// @vitest-environment jsdom
// The Maps screen: list, add, Gallery, inspector fields, Send and its summary.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PRESETS, projector, type AreaSpec, type MapSpec, type ProjectStyle } from "@affinitygeo/geo-core/view";
import { ApiFail, api, type SendResult, type TargetDocument } from "../src/ui/api.js";
import { MapsScreen } from "../src/ui/maps/MapsScreen.js";
import { clearThumbCache } from "../src/ui/maps/Gallery.js";
import { MAP_DELETED, NOT_CONNECTED, NOT_CONNECTED_REST, PROJECT_CHANGED, STILL_DRAWING, getSendState, resetSend } from "../src/ui/maps/SendSummary.js";
import { App, handleCloseRequest } from "../src/ui/App.js";
import { platform } from "../src/ui/platform.js";
import { fit, toScreen } from "../src/ui/map/viewport.js";
import { flushPendingEdits, getActions, getApp, resetApp, setApp, type AppState } from "../src/ui/store.js";

const area: AreaSpec = { placeName: "Hyde Park", bboxWgs84: [-0.17, 51.50, -0.14, 51.52], projectionId: "bng" };
const style = {
  presetName: "T", roles: {},
  marker: { dot: "#E4572E", ring: "#FFFFFF", text: "#1B252C", textPt: 9, label: "You are here" },
} as unknown as ProjectStyle;
const W = 400, H = 300;

const mk = (id: string, name: string, over: Partial<MapSpec> = {}): MapSpec => ({
  id, name, centre: [-0.155, 51.51], scale: 2500, rotationDeg: 0, sizeMm: { width: 420, height: 297 },
  marker: true, target: null, resizeArtboard: null, sent: null, ...over,
});

type Project = NonNullable<AppState["project"]>;
const projectWith = (maps: MapSpec[]): Project =>
  ({ id: "p1", name: "W", area, style, maps, dataVersion: 1, sources: {}, fetchedAt: null, version: 1 }) as unknown as Project;

class Path2DStub { moveTo() {} lineTo() {} closePath() {} arc() {} rect() {} }

let current: Project;

/** A fake api: every call the screen makes, answered from `current`. */
function fakeApi() {
  return {
    project: vi.spyOn(api, "project").mockImplementation(async () => ({ project: current, dirty: false, counts: null })),
    areaPreview: vi.spyOn(api, "areaPreview").mockImplementation(() => new Promise(() => {})),
    mapPreview: vi.spyOn(api, "mapPreview").mockImplementation(async (id) => ({
      mapId: id, mapName: id, projectId: "p1", sizeMm: { width: 420, height: 297 }, background: { fill: "#ffffff" }, layers: [], marker: null, hash: "h",
    })),
    statuses: vi.spyOn(api, "statuses").mockImplementation(async () => Object.entries(getApp().statuses).map(([mapId, status]) => ({ mapId, status }))),
    targets: vi.spyOn(api, "targets").mockImplementation(async () => ({ documents: getApp().targets })),
    addMap: vi.spyOn(api, "addMap").mockImplementation(async (input) => {
      const m = mk("new", input.name, { centre: input.centre });
      current = projectWith([...current.maps, m]);
      return m;
    }),
    patchMap: vi.spyOn(api, "patchMap").mockImplementation(async (id, patch) => {
      const maps = current.maps.map((m) => (m.id === id ? { ...m, ...patch } : m));
      current = projectWith(maps);
      return maps.find((m) => m.id === id)!;
    }),
    linkArtboard: vi.spyOn(api, "linkArtboard").mockImplementation(async (id) => ({ map: current.maps.find((m) => m.id === id)! })),
    deleteMap: vi.spyOn(api, "deleteMap").mockResolvedValue({ ok: true }),
    send: vi.spyOn(api, "send").mockResolvedValue({ results: [] }),
  };
}

function start(maps: MapSpec[], patch: Partial<AppState> = {}) {
  current = projectWith(maps);
  resetApp({ project: current, connection: { connected: true, busy: false }, preview: { status: "none" }, ...patch });
  const fake = fakeApi();
  render(<MapsScreen />);
  return fake;
}

beforeEach(() => {
  clearThumbCache();
  resetSend();
  vi.stubGlobal("Path2D", Path2DStub);
  const ctx = new Proxy({}, { get: (t: Record<string, unknown>, k: string) => (k in t ? t[k] : () => undefined), set: (t, k, v) => { t[k as string] = v; return true; } });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: W, height: H, right: W, bottom: H, x: 0, y: 0, toJSON() {} } as DOMRect);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
/** The send mock answers each one-map POST with that map's result. */
const answer = (results: SendResult[]) => async (opts: { mapIds?: string[] } = {}) =>
  ({ results: results.filter((r) => opts.mapIds?.includes(r.mapId)) });
const sendButton = () => screen.getByRole("button", { name: /^(Send to Affinity|Send all changed)/ });

describe("Maps screen", () => {
  it("Add map in add mode posts the clicked centre and selects the new map", async () => {
    const fake = start([mk("m1", "Map 1"), mk("m3", "Map 3")]);
    fireEvent.click(screen.getByRole("button", { name: "+ Add map" }));
    const canvas = screen.getByLabelText("Map view");
    const pr = projector(area);
    const [w, s, e, n] = area.bboxWgs84;
    const pts = [pr.forward([w, s]), pr.forward([e, s]), pr.forward([e, n]), pr.forward([w, n])];
    const view = fit([Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))], W, H);
    const [px, py] = toScreen(view, W, H, pr.forward([-0.15, 51.505]));
    fireEvent.pointerDown(canvas, { pointerId: 1, button: 0, clientX: px, clientY: py });
    fireEvent.pointerUp(canvas, { pointerId: 1, button: 0, clientX: px, clientY: py });
    await flush();
    expect(fake.addMap).toHaveBeenCalledTimes(1);
    const input = fake.addMap.mock.calls[0]![0];
    expect(input.name).toBe("Map 2");
    expect(input.centre[0]).toBeCloseTo(-0.15, 4);
    expect(input.centre[1]).toBeCloseTo(51.505, 4);
    expect(getApp().selectedMapIds).toEqual(["new"]);
    // Back to browsing: the hint has gone.
    expect(screen.queryByText(/Click the map where/)).toBeNull();
  });

  it("the list is numbered with name, scale and badge", () => {
    start([mk("m1", "Library", { target: { docId: "d1", docTitle: "Doc" } }), mk("m2", "Lake", { scale: 10000 })], { statuses: { m1: "Up to date" } });
    const list = screen.getByRole("list", { name: "Maps" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toContain("1");
    expect(items[0]!.textContent).toContain("Library");
    expect(items[0]!.textContent).toContain("1:2,500");
    expect(items[0]!.textContent).toContain("Up to date");
    expect(items[1]!.textContent).toContain("1:10,000");
    expect(items[1]!.textContent).toContain("Not sent");
  });

  it("Gallery shows Target not open and Change document re-targets", async () => {
    const targets: TargetDocument[] = [{
      docId: "d2", title: "Parkland maps",
      artboards: [{ name: "Lake", mapIds: [], widthMm: 297, heightMm: 210 }, { name: "Park", mapIds: [], widthMm: 297, heightMm: 210 }],
    }];
    const fake = start([mk("m1", "Library", { target: { docId: "d1", docTitle: "Old plan" } })],
      { statuses: { m1: "Target not open" }, targets, view: "gallery" });
    await flush();
    const card = screen.getByRole("article", { name: "Library" });
    expect(within(card).getByText("Target not open")).toBeTruthy();
    expect(within(card).getByText("Old plan")).toBeTruthy();
    expect(fake.mapPreview).toHaveBeenCalledWith("m1");

    fireEvent.click(within(card).getByRole("button", { name: "Change document…" }));
    fireEvent.change(within(card).getByLabelText("Document"), { target: { value: "d2" } });
    await flush();
    expect(fake.patchMap).toHaveBeenCalledWith("m1", { target: { docId: "d2", docTitle: "Parkland maps" } });

    fireEvent.change(within(card).getByLabelText("Artboard"), { target: { value: "1" } });
    await flush();
    expect(fake.linkArtboard).toHaveBeenCalledWith("m1", { docId: "d2", artboardIndex: 1, artboardName: "Park" });
  });

  it("the gallery target line names the document and artboard", async () => {
    const targets: TargetDocument[] = [{
      docId: "d2", title: "Parkland maps",
      artboards: [{ name: "Lake", mapIds: [{ projectId: "p1", mapId: "m1" }], widthMm: 420, heightMm: 297 }],
    }];
    start([mk("m1", "Library", { target: { docId: "d2", docTitle: "Parkland maps" } }), mk("m2", "Park")],
      { statuses: { m1: "Changed since sent" }, targets, view: "gallery" });
    await flush();
    expect(within(screen.getByRole("article", { name: "Library" })).getByText("Parkland maps · Lake")).toBeTruthy();
    expect(within(screen.getByRole("article", { name: "Library" })).getByText("Changed since sent")).toBeTruthy();
    expect(within(screen.getByRole("article", { name: "Park" })).getByText("No document chosen")).toBeTruthy();
  });

  it("MapInspector rejects bad numbers without patching", async () => {
    const fake = start([mk("m1", "Library", { scale: 1000 })], { selectedMapIds: ["m1"] });
    const rotation = screen.getByLabelText("Rotation") as HTMLInputElement;
    fireEvent.change(rotation, { target: { value: "abc" } });
    fireEvent.blur(rotation);
    await flush();
    expect(fake.patchMap).not.toHaveBeenCalled();
    expect(screen.getByText("Enter a number")).toBeTruthy();
    expect(rotation.value).toBe("0");

    const scale = screen.getByLabelText("Scale") as HTMLInputElement;
    fireEvent.change(scale, { target: { value: "2,500" } });
    fireEvent.keyDown(scale, { key: "Enter" });
    await flush();
    expect(fake.patchMap).toHaveBeenCalledTimes(1);
    expect(fake.patchMap).toHaveBeenCalledWith("m1", { scale: 2500 });
  });

  it("the server's 400 message shows under the field", async () => {
    const fake = start([mk("m1", "Library")], { selectedMapIds: ["m1"] });
    fake.patchMap.mockRejectedValueOnce(new ApiFail(400, "The scale must be a number from 100 to 1,000,000 (as in 1:2500)."));
    const scale = screen.getByLabelText("Scale") as HTMLInputElement;
    fireEvent.change(scale, { target: { value: "50" } });
    fireEvent.blur(scale);
    await flush();
    expect(screen.getByText(/The scale must be a number from 100/)).toBeTruthy();
  });

  it("the rotation helper says which way is up", () => {
    start([mk("m1", "Library", { rotationDeg: 90 })], { selectedMapIds: ["m1"] });
    expect(screen.getByText("Up is 90° — east")).toBeTruthy();
  });

  it("the scale slider patches once, 300 ms after the last move", async () => {
    vi.useFakeTimers();
    const fake = start([mk("m1", "Library")], { selectedMapIds: ["m1"] });
    const slider = screen.getByLabelText("Scale slider");
    fireEvent.change(slider, { target: { value: "500" } });
    fireEvent.change(slider, { target: { value: "600" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(fake.patchMap).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(150); });
    expect(fake.patchMap).toHaveBeenCalledTimes(1);
    expect(Object.keys(fake.patchMap.mock.calls[0]![1])).toEqual(["scale"]);
  });

  it("Send all changed when nothing is selected; Send to Affinity (2) with two selected", async () => {
    const fake = start([mk("m1", "Library"), mk("m2", "Lake"), mk("m3", "Park")]);
    expect(sendButton().textContent).toContain("Send all changed");
    fireEvent.click(sendButton());
    await flush();
    // One POST per map, so the progress is real.
    expect(fake.send.mock.calls.map((c) => c[0])).toEqual([{ mapIds: ["m1"] }, { mapIds: ["m2"] }, { mapIds: ["m3"] }]);

    fake.send.mockClear();
    act(() => { getActions().select(["m1", "m2"]); });
    expect(sendButton().textContent).toContain("Send to Affinity (2)");
    fireEvent.click(sendButton());
    await flush();
    expect(fake.send.mock.calls.map((c) => c[0])).toEqual([{ mapIds: ["m1"] }, { mapIds: ["m2"] }]);
  });

  it("Send is disabled with a tooltip when Affinity isn't connected", () => {
    start([mk("m1", "Library")], { connection: { connected: false, busy: false } });
    expect((sendButton() as HTMLButtonElement).disabled).toBe(true);
    expect(sendButton().getAttribute("title")).toMatch(/isn't connected/);
  });

  it("SendSummary shows the not-connected message and keeps statuses", async () => {
    const fake = start([mk("m1", "Library", { target: { docId: "d", docTitle: "D" } })], { statuses: { m1: "Changed since sent" } });
    fake.send.mockRejectedValueOnce(new ApiFail(503, "Affinity isn't connected."));
    fireEvent.click(sendButton());
    await flush();
    const summary = screen.getByRole("region", { name: "Send summary" });
    expect(within(summary).getByText(/Affinity isn't connected/)).toBeTruthy();
    expect(getApp().statuses).toEqual({ m1: "Changed since sent" });
  });

  it("SendSummary lists counts, kept edits by reason, warnings and failures", async () => {
    const fake = start([mk("m1", "Library"), mk("m2", "Lake")]);
    const results: SendResult[] = [
      { mapId: "m1", ok: true, created: 3, updated: 10, removed: 1, warnings: ["2 features had no shape and were skipped."],
        keptEdited: [{ fid: "w/1", role: "buildings", name: "Town Hall", reason: "edited by hand" },
          { fid: "w/2", role: "buildings", name: "Museum", reason: "edited by hand" },
          { fid: "w/3", role: "water", name: "Pond", reason: "reshaped" }] },
      { mapId: "m2", ok: false, error: "Open 'Old' in Affinity to update Lake" },
    ];
    fake.send.mockImplementation(answer(results));
    fireEvent.click(sendButton());
    await flush();
    const summary = screen.getByRole("region", { name: "Send summary" });
    expect(within(summary).getByText("3 created · 10 updated · 1 removed")).toBeTruthy();
    expect(within(summary).getByText(/Town Hall, Museum/)).toBeTruthy();
    expect(within(summary).getByText(/Pond/)).toBeTruthy();
    expect(within(summary).getByText("2 features had no shape and were skipped.")).toBeTruthy();
    const failure = within(summary).getByText("Open 'Old' in Affinity to update Lake");
    expect(failure.className).toContain("is-error");
  });

  it("needsResizeChoice opens the prompt; Keep its size patches resizeArtboard false and re-sends", async () => {
    const fake = start([mk("m1", "Library", { target: { docId: "d", docTitle: "D" } })], { selectedMapIds: ["m1"] });
    fake.send.mockResolvedValueOnce({ results: [{ mapId: "m1", ok: false, needsResizeChoice: true, artboardMm: { width: 297, height: 210 } }] });
    fireEvent.click(sendButton());
    await flush();
    expect(screen.getByText("The artboard is 297 × 210 mm; the map is 420 × 297 mm. Resize the artboard?")).toBeTruthy();
    fake.send.mockResolvedValueOnce({ results: [{ mapId: "m1", ok: true, created: 5, updated: 0, removed: 0 }] });
    fireEvent.click(screen.getByRole("button", { name: "Keep its size" }));
    await flush();
    await waitFor(() => expect(fake.send).toHaveBeenCalledTimes(2));
    expect(fake.patchMap).toHaveBeenCalledWith("m1", { resizeArtboard: false });
    expect(fake.send).toHaveBeenLastCalledWith({ mapIds: ["m1"] });
    await flush();
    expect(within(screen.getByRole("region", { name: "Send summary" })).getByText("5 created · 0 updated · 0 removed")).toBeTruthy();
  });

  it("Reset hand edits confirms, then sends reset true for that map only", async () => {
    const fake = start([mk("m1", "Library"), mk("m2", "Lake")], { selectedMapIds: ["m1"] });
    fireEvent.click(screen.getByRole("button", { name: "Reset hand edits…" }));
    expect(screen.getByText("Put every object on 'Library' back to the app's version? Your colour, shape and position changes on this map are lost.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    await flush();
    expect(fake.send).toHaveBeenCalledTimes(1);
    expect(fake.send).toHaveBeenCalledWith({ mapIds: ["m1"], reset: true });
  });

  it("Delete map confirms before deleting", async () => {
    const fake = start([mk("m1", "Library")], { selectedMapIds: ["m1"] });
    fireEvent.click(screen.getByRole("button", { name: "Delete map…" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await flush();
    expect(fake.deleteMap).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete map…" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await flush();
    expect(fake.deleteMap).toHaveBeenCalledWith("m1");
  });

  it("the resize checkbox sets resizeArtboard", async () => {
    const fake = start([mk("m1", "Library", { resizeArtboard: true })], { selectedMapIds: ["m1"] });
    const box = screen.getByLabelText("Resize the artboard to fit the map") as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    await flush();
    expect(fake.patchMap).toHaveBeenCalledWith("m1", { resizeArtboard: false });
  });

  it("choosing a paper preset keeps the orientation", async () => {
    const fake = start([mk("m1", "Library")], { selectedMapIds: ["m1"] });
    fireEvent.change(screen.getByLabelText("Paper"), { target: { value: "A4" } });
    await flush();
    expect(fake.patchMap).toHaveBeenCalledWith("m1", { sizeMm: { width: 297, height: 210 } });
    fireEvent.click(screen.getByRole("button", { name: "Portrait" }));
    await flush();
    expect(fake.patchMap).toHaveBeenLastCalledWith("m1", { sizeMm: { width: 210, height: 297 } });
  });
});

describe("Maps screen fixes", () => {
  it("Send from the Style screen ends on Maps with the summary showing", async () => {
    current = projectWith([mk("m1", "Library")]);
    current = { ...current, style: structuredClone(PRESETS[0]!) }; // the Style screen reads every role
    resetApp({ project: current, connection: { connected: true, busy: false }, preview: { status: "none" }, screen: "style" });
    const fake = fakeApi();
    vi.spyOn(api, "affinity").mockResolvedValue({ connected: true, busy: false });
    fake.send.mockResolvedValueOnce({ results: [{ mapId: "m1", ok: true, created: 2, updated: 0, removed: 0 }] });
    render(<App />);
    await flush();
    fireEvent.click(sendButton());
    await flush();
    expect(getApp().screen).toBe("maps");
    expect(fake.send).toHaveBeenCalledWith({ mapIds: ["m1"] });
    const summary = screen.getByRole("region", { name: "Send summary" });
    expect(within(summary).getByText("2 created · 0 updated · 0 removed")).toBeTruthy();
  });

  it("a thumbnail whose refetch fails says No preview instead of keeping the old picture", async () => {
    const fake = start([mk("m1", "Library")], { view: "gallery" });
    await flush();
    expect(screen.queryByText("No preview")).toBeNull();
    fake.mapPreview.mockRejectedValueOnce(new ApiFail(500, "boom"));
    act(() => { setApp({ project: projectWith([mk("m1", "Library", { scale: 5000 })]) }); });
    await flush();
    expect(screen.getByText("No preview")).toBeTruthy();
  });

  it("Reset hand edits is disabled while a send is running", async () => {
    const fake = start([mk("m1", "Library")], { selectedMapIds: ["m1"] });
    fake.send.mockImplementationOnce(() => new Promise(() => {}));
    fireEvent.click(sendButton());
    await flush();
    expect((screen.getByRole("button", { name: "Reset hand edits…" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("summary titles are honest: a failed reset isn't 'Reset', a cancelled resize isn't 'Sent 0 maps'", async () => {
    const fake = start([mk("m1", "Library", { target: { docId: "d", docTitle: "D" } })], { selectedMapIds: ["m1"] });
    fake.send.mockResolvedValueOnce({ results: [{ mapId: "m1", ok: false, error: "Open 'D' in Affinity to update Library" }] });
    fireEvent.click(screen.getByRole("button", { name: "Reset hand edits…" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    await flush();
    let summary = screen.getByRole("region", { name: "Send summary" });
    expect(within(summary).queryByText(/^Reset/)).toBeNull();
    expect(within(summary).getByText("Not sent")).toBeTruthy();

    fake.send.mockResolvedValueOnce({ results: [{ mapId: "m1", ok: false, needsResizeChoice: true, artboardMm: { width: 297, height: 210 } }] });
    fireEvent.click(sendButton());
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await flush();
    summary = screen.getByRole("region", { name: "Send summary" });
    expect(within(summary).queryByText(/Sent 0/)).toBeNull();
    expect(within(summary).getByText("Not sent")).toBeTruthy();
  });

  it("partly sent says how many of how many", async () => {
    const fake = start([mk("m1", "Library"), mk("m2", "Lake")]);
    fake.send.mockImplementation(answer([{ mapId: "m1", ok: true, created: 1, updated: 0, removed: 0 }, { mapId: "m2", ok: false, error: "No." }]));
    fireEvent.click(sendButton());
    await flush();
    expect(within(screen.getByRole("region", { name: "Send summary" })).getByText("Sent 1 of 2 maps")).toBeTruthy();
  });

  it("pick mode ends when a different map is selected", () => {
    start([mk("m1", "Library"), mk("m2", "Lake")], { selectedMapIds: ["m1"] });
    fireEvent.click(screen.getByRole("button", { name: "Pick on map" }));
    expect(screen.getByText(/Click the map where the centre of 'Library' goes/)).toBeTruthy();
    act(() => { getActions().select(["m2"]); });
    expect(screen.queryByText(/Click the map where the centre of/)).toBeNull();
  });
});

describe("store preview retries", () => {
  it("a retry from 'none' keeps 'none' until data arrives", async () => {
    resetApp({ preview: { status: "none" } });
    let answer: (v: unknown) => void = () => {};
    vi.spyOn(api, "areaPreview").mockImplementation(() => new Promise((r) => { answer = r as (v: unknown) => void; }));
    const run = getActions().refreshPreview();
    expect(getApp().preview.status).toBe("none");
    answer({ bounds: [0, 0, 1, 1], layers: [] });
    await run;
    expect(getApp().preview.status).toBe("ready");
    setApp({ preview: { status: "none" } });
  });
});

describe("Send, one map at a time (live-test fixes)", () => {
  it("Send all changed skips maps that are up to date", async () => {
    const fake = start([mk("m1", "Library"), mk("m2", "Lake"), mk("m3", "Park")], { statuses: { m2: "Up to date" } });
    fireEvent.click(sendButton());
    await flush();
    expect(fake.send.mock.calls.map((c) => c[0])).toEqual([{ mapIds: ["m1"] }, { mapIds: ["m3"] }]);
  });

  it("shows a progress panel per map: name, n of total, elapsed seconds and a bar that advances", async () => {
    const fake = start([mk("m1", "Library"), mk("m2", "Lake")]);
    const waits: Array<(v: { results: SendResult[] }) => void> = [];
    fake.send.mockImplementation(() => new Promise((r) => { waits.push(r); }));
    fireEvent.click(sendButton());
    await flush();
    let panel = screen.getByRole("region", { name: "Send progress" });
    expect(within(panel).getByText("Drawing Library (1 of 2)…")).toBeTruthy();
    expect(within(panel).getByText(/^\d+ s$/)).toBeTruthy();
    expect(within(panel).getByRole("progressbar").getAttribute("aria-valuenow")).toBe("0");
    expect(within(panel).getByRole("progressbar").getAttribute("aria-valuemax")).toBe("2");
    expect(screen.queryByRole("region", { name: "Send summary" })).toBeNull();

    await act(async () => { waits[0]!({ results: [{ mapId: "m1", ok: true, created: 1, updated: 0, removed: 0 }] }); });
    await flush();
    panel = screen.getByRole("region", { name: "Send progress" });
    expect(within(panel).getByText("Drawing Lake (2 of 2)…")).toBeTruthy();
    expect(within(panel).getByRole("progressbar").getAttribute("aria-valuenow")).toBe("1");

    await act(async () => { waits[1]!({ results: [{ mapId: "m2", ok: true, created: 2, updated: 0, removed: 0 }] }); });
    await flush();
    expect(screen.queryByRole("region", { name: "Send progress" })).toBeNull();
    expect(within(screen.getByRole("region", { name: "Send summary" })).getByText("Sent 2 maps")).toBeTruthy();
  });

  it("a 503 part-way stops the run: later maps aren't posted, the plain message shows, and what was sent stays listed", async () => {
    const fake = start([mk("m1", "Library"), mk("m2", "Lake"), mk("m3", "Park")]);
    fake.send
      .mockResolvedValueOnce({ results: [{ mapId: "m1", ok: true, created: 1, updated: 0, removed: 0 }] })
      .mockRejectedValueOnce(new ApiFail(503, "Affinity isn't connected."));
    fireEvent.click(sendButton());
    await flush();
    expect(fake.send).toHaveBeenCalledTimes(2);
    const summary = screen.getByRole("region", { name: "Send summary" });
    expect(within(summary).getByText(/Affinity isn't connected/)).toBeTruthy();
    expect(within(summary).getByText("1 created · 0 updated · 0 removed")).toBeTruthy();
    expect(within(summary).getByText("Sent 1 of 3 maps")).toBeTruthy();
  });

  it("a 503 on the first map sends nothing and keeps the statuses", async () => {
    const fake = start([mk("m1", "Library", { target: { docId: "d", docTitle: "D" } }), mk("m2", "Lake")], { statuses: { m1: "Changed since sent" } });
    fake.send.mockRejectedValueOnce(new ApiFail(503, "Affinity isn't connected."));
    fireEvent.click(sendButton());
    await flush();
    expect(fake.send).toHaveBeenCalledTimes(1);
    const summary = screen.getByRole("region", { name: "Send summary" });
    expect(within(summary).getByText("Not sent")).toBeTruthy();
    expect(within(summary).getByText(/nothing was sent/)).toBeTruthy();
    expect(getApp().statuses).toEqual({ m1: "Changed since sent" });
  });

  it("while the size prompt is open the row waits for the choice; a cancel says so", async () => {
    const fake = start([mk("m1", "Library", { target: { docId: "d", docTitle: "D" } })], { selectedMapIds: ["m1"] });
    fake.send.mockResolvedValueOnce({ results: [{ mapId: "m1", ok: false, needsResizeChoice: true, artboardMm: { width: 297, height: 210 } }] });
    fireEvent.click(sendButton());
    await flush();
    let summary = screen.getByRole("region", { name: "Send summary" });
    expect(within(summary).getByText("Waiting for your choice…")).toBeTruthy();
    expect(within(summary).queryByText(/Send again to choose/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await flush();
    summary = screen.getByRole("region", { name: "Send summary" });
    expect(within(summary).getByText("Not sent: you cancelled the size choice.")).toBeTruthy();
  });

  it("the size prompt's Resize button is lime", async () => {
    const fake = start([mk("m1", "Library", { target: { docId: "d", docTitle: "D" } })], { selectedMapIds: ["m1"] });
    fake.send.mockResolvedValueOnce({ results: [{ mapId: "m1", ok: false, needsResizeChoice: true, artboardMm: { width: 297, height: 210 } }] });
    fireEvent.click(sendButton());
    await flush();
    expect(screen.getByRole("button", { name: "Resize" }).className).toContain("btn-primary");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" })); // the prompt queue is module-wide
    await flush();
  });

  it("on Style, Data and Area the button always reads Send all changed and ignores the hidden selection", async () => {
    current = projectWith([mk("m1", "Library"), mk("m2", "Lake")]);
    current = { ...current, style: structuredClone(PRESETS[0]!) };
    resetApp({ project: current, connection: { connected: true, busy: false }, preview: { status: "none" }, screen: "style", selectedMapIds: ["m1"] });
    const fake = fakeApi();
    vi.spyOn(api, "affinity").mockResolvedValue({ connected: true, busy: false });
    render(<App />);
    await flush();
    expect(sendButton().textContent).toContain("Send all changed");
    fireEvent.click(sendButton());
    await flush();
    expect(fake.send.mock.calls.map((c) => c[0])).toEqual([{ mapIds: ["m1"] }, { mapIds: ["m2"] }]);
  });

  it("Send to Affinity in the top bar is lime", () => {
    start([mk("m1", "Library")]);
    expect(sendButton().className).toContain("btn-primary");
  });
});

describe("Send: honest summary when a run stops ", () => {
  const needsChoice = (mapId: string): SendResult => ({ mapId, ok: false, needsResizeChoice: true, artboardMm: { width: 297, height: 210 } });
  const okResult = (mapId: string, created = 1): SendResult => ({ mapId, ok: true, created, updated: 0, removed: 0 });

  it("a run that stops after a map needing a size choice never asks, and says the choice is still to make", async () => {
    const fake = start([mk("m1", "Library"), mk("m2", "Lake")]);
    fake.send.mockResolvedValueOnce({ results: [needsChoice("m1")] }).mockRejectedValueOnce(new ApiFail(503, "Affinity isn't connected."));
    fireEvent.click(sendButton());
    await flush();
    expect(screen.queryByRole("button", { name: "Resize" })).toBeNull();
    const summary = screen.getByRole("region", { name: "Send summary" });
    expect(within(summary).getByText("Not sent: the artboard size needs a choice. Send again to choose.")).toBeTruthy();
    expect(within(summary).queryByText(/you cancelled/)).toBeNull();
  });

  it("a 504 part-way stops the run with the still-drawing message", async () => {
    const fake = start([mk("m1", "Library"), mk("m2", "Lake"), mk("m3", "Park")]);
    fake.send.mockResolvedValueOnce({ results: [okResult("m1")] }).mockRejectedValueOnce(new ApiFail(504, "Timed out."));
    fireEvent.click(sendButton());
    await flush();
    expect(fake.send).toHaveBeenCalledTimes(2);
    const summary = screen.getByRole("region", { name: "Send summary" });
    expect(within(summary).getByText(STILL_DRAWING)).toBeTruthy();
    expect(within(summary).getByText("Sent 1 of 3 maps")).toBeTruthy();
  });

  it("a 503 after only failed maps says nothing was sent", async () => {
    const fake = start([mk("m1", "Library"), mk("m2", "Lake")]);
    fake.send.mockResolvedValueOnce({ results: [{ mapId: "m1", ok: false, error: "No." }] }).mockRejectedValueOnce(new ApiFail(503, "Affinity isn't connected."));
    fireEvent.click(sendButton());
    await flush();
    const summary = screen.getByRole("region", { name: "Send summary" });
    expect(within(summary).getByText(NOT_CONNECTED)).toBeTruthy();
    expect(within(summary).queryByText(NOT_CONNECTED_REST)).toBeNull();
  });

  it("a map deleted mid-run (404) is that map's failure, and the run carries on", async () => {
    const fake = start([mk("m1", "Library"), mk("m2", "Lake")]);
    fake.send.mockRejectedValueOnce(new ApiFail(404, "No map with that id.")).mockResolvedValueOnce({ results: [okResult("m2")] });
    fireEvent.click(sendButton());
    await flush();
    expect(fake.send).toHaveBeenCalledTimes(2);
    const summary = screen.getByRole("region", { name: "Send summary" });
    expect(within(summary).getByText(MAP_DELETED)).toBeTruthy();
    expect(within(summary).getByText("Sent 1 of 2 maps")).toBeTruthy();
  });

  it("a map gone by the time it would be asked about reads as deleted, not cancelled", async () => {
    const fake = start([mk("m1", "Library"), mk("m2", "Lake")]);
    fake.send.mockResolvedValueOnce({ results: [needsChoice("m1")] }).mockImplementationOnce(async () => {
      current = projectWith([mk("m2", "Lake")]);
      setApp({ project: current });
      return { results: [okResult("m2")] };
    });
    fireEvent.click(sendButton());
    await flush();
    expect(screen.queryByRole("button", { name: "Resize" })).toBeNull();
    const summary = screen.getByRole("region", { name: "Send summary" });
    expect(within(summary).getByText(MAP_DELETED)).toBeTruthy();
    expect(within(summary).queryByText(/you cancelled/)).toBeNull();
  });

  it("answering Resize patches the map, re-posts it and the row shows the real result", async () => {
    const fake = start([mk("m1", "Library", { target: { docId: "d", docTitle: "D" } })], { selectedMapIds: ["m1"] });
    fake.send.mockResolvedValueOnce({ results: [needsChoice("m1")] }).mockResolvedValueOnce({ results: [{ ...okResult("m1", 4), resized: true }] });
    fireEvent.click(sendButton());
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Resize" }));
    await flush();
    await flush();
    expect(fake.patchMap).toHaveBeenCalledWith("m1", { resizeArtboard: true });
    expect(fake.send).toHaveBeenCalledTimes(2);
    expect(fake.send).toHaveBeenLastCalledWith({ mapIds: ["m1"] });
    const summary = screen.getByRole("region", { name: "Send summary" });
    expect(within(summary).getByText("4 created · 0 updated · 0 removed")).toBeTruthy();
    expect(within(summary).getByText("The artboard was resized to fit.")).toBeTruthy();
    expect(within(summary).getByText("Sent 1 map")).toBeTruthy();
  });
});

describe("Send: the unsaved guard during a run (final review)", () => {
  const okResult = (mapId: string): SendResult => ({ mapId, ok: true, created: 1, updated: 0, removed: 0 });
  const needsChoice = (mapId: string): SendResult => ({ mapId, ok: false, needsResizeChoice: true, artboardMm: { width: 297, height: 210 } });
  const alert = () => screen.queryByRole("alertdialog");
  const answerDialog = async (name: string) => {
    await act(async () => { fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name })); });
    await flush();
  };

  function startApp(maps: MapSpec[]) {
    current = projectWith(maps);
    resetApp({ project: current, connection: { connected: true, busy: false }, preview: { status: "none" }, screen: "maps" });
    const fake = fakeApi();
    vi.spyOn(api, "affinity").mockResolvedValue({ connected: true, busy: false });
    vi.spyOn(platform, "settings").mockResolvedValue({ appearance: "system", firstRunDone: true });
    render(<App />);
    return fake;
  }

  it("re-reads the project after each map, so the unsaved dot appears as maps are drawn", async () => {
    const fake = start([mk("m1", "Library"), mk("m2", "Lake")]);
    let serverDirty = false;
    fake.project.mockImplementation(async () => ({ project: current, dirty: serverDirty, counts: null }));
    const waits: Array<(v: { results: SendResult[] }) => void> = [];
    fake.send.mockImplementation(() => new Promise((r) => { waits.push(r); }));
    fireEvent.click(sendButton());
    await flush();
    expect(getApp().dirty).toBe(false);
    serverDirty = true; // the server recorded map 1
    await act(async () => { waits[0]!({ results: [okResult("m1")] }); });
    await flush();
    expect(waits).toHaveLength(2); // map 2 is drawing
    expect(getApp().dirty).toBe(true);
    await act(async () => { waits[1]!({ results: [okResult("m2")] }); });
    await flush();
  });

  it("closing while the size question is open asks to save the maps already recorded", async () => {
    const fake = startApp([mk("m1", "Library"), mk("m2", "Lake"), mk("m3", "Park")]);
    await flush();
    let serverDirty = false;
    fake.project.mockImplementation(async () => ({ project: current, dirty: serverDirty, counts: null }));
    fake.send.mockImplementation(async (opts: { mapIds?: string[] } = {}) => {
      const id = opts.mapIds![0]!;
      if (id === "m1") serverDirty = true;
      return { results: [id === "m2" ? needsChoice(id) : okResult(id)] };
    });
    fireEvent.click(sendButton());
    await flush();
    expect(screen.getByRole("button", { name: "Resize" })).toBeTruthy(); // Lake's size question
    expect(getSendState().sending).toBe(true);
    setApp({ dirty: false }); // even a stale client flag must not let the window close unasked
    const confirmClose = vi.spyOn(platform, "confirmClose").mockImplementation(() => {});

    act(() => { void handleCloseRequest(); });
    await flush();
    expect(within(alert()!).getByText("AffinityGeo is still working")).toBeTruthy();
    await answerDialog("Close anyway");
    expect(within(alert()!).getByText("Save changes to 'W' first?")).toBeTruthy();
    expect(confirmClose).not.toHaveBeenCalled();
    await answerDialog("Cancel");
    expect(confirmClose).not.toHaveBeenCalled();
    // Back to the size question.
    expect(screen.getByRole("button", { name: "Resize" })).toBeTruthy();
    await answerDialog("Cancel");
  });

  it("New, Open… and Open Recent are disabled while a send runs", async () => {
    const fake = startApp([mk("m1", "Library")]);
    await flush();
    let finish: (v: { results: SendResult[] }) => void = () => {};
    fake.send.mockImplementation(() => new Promise((r) => { finish = r; }));
    const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;
    expect(button("New").disabled).toBe(false);
    fireEvent.click(sendButton());
    await flush();
    expect(button("New").disabled).toBe(true);
    expect(button("Open…").disabled).toBe(true);
    expect(button("Open Recent").disabled).toBe(true);
    await act(async () => { finish({ results: [okResult("m1")] }); });
    await flush();
    expect(button("New").disabled).toBe(false);
    expect(button("Open…").disabled).toBe(false);
  });

  it("a project switch mid-run stops it: the old project's maps aren't posted", async () => {
    const fake = start([mk("m1", "Library"), mk("m2", "Lake"), mk("m3", "Park")]);
    fake.send.mockImplementation(async (opts: { mapIds?: string[] } = {}) => {
      // Another project is opened (another window, the CLI) while map 1 draws.
      current = { ...projectWith([mk("m2", "Elsewhere")]), id: "p2" } as Project;
      return { results: [okResult(opts.mapIds![0]!)] };
    });
    fireEvent.click(sendButton());
    await flush();
    expect(fake.send.mock.calls.map((c) => c[0])).toEqual([{ mapIds: ["m1"] }]);
    expect(getSendState().summary?.failure).toBe(PROJECT_CHANGED);
    expect(getSendState().sending).toBe(false);
  });
});

describe("pending debounced edits (final review)", () => {
  it("the scale slider's waiting value is saved when the edits are flushed", async () => {
    const fake = start([mk("m1", "Library")], { selectedMapIds: ["m1"] });
    await flush();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.change(screen.getByLabelText("Scale slider"), { target: { value: "700" } });
    expect(fake.patchMap).not.toHaveBeenCalled();
    await act(async () => { await flushPendingEdits(); });
    expect(fake.patchMap).toHaveBeenCalledTimes(1);
    expect(fake.patchMap.mock.calls[0]![1]).toHaveProperty("scale");
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    expect(fake.patchMap).toHaveBeenCalledTimes(1); // not sent twice
  });
});
