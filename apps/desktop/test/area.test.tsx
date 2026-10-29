// @vitest-environment jsdom
// The new-project flow and the Area screen.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlaceResult } from "@affinitygeo/geo-core";
import { TOO_BIG, type AreaSpec, type ProjectStyle } from "@affinitygeo/geo-core/view";
import { ApiFail, api, type ProjectionOption } from "../src/ui/api.js";
import { platform } from "../src/ui/platform.js";
import { AreaScreen } from "../src/ui/area/AreaScreen.js";
import { NewProject, resetSearchClock } from "../src/ui/area/NewProject.js";
import { BoxEditor } from "../src/ui/area/BoxEditor.js";
import { App } from "../src/ui/App.js";
import { getSendState, resetSend } from "../src/ui/maps/SendSummary.js";
import { getApp, resetApp, type AppState } from "../src/ui/store.js";

type Project = NonNullable<AppState["project"]>;
const style = { presetName: "T", roles: {} } as unknown as ProjectStyle;
const area: AreaSpec = { placeName: "Hyde Park", bboxWgs84: [-0.17, 51.50, -0.14, 51.52], projectionId: "bng" };
let current: Project;
const projectWith = (over: Partial<Project> = {}): Project =>
  ({ id: "p1", name: "W", area, style, maps: [], dataVersion: 1, sources: { buildings: { kind: "osm" } }, fetchedAt: null, version: 1, ...over }) as unknown as Project;

const small: PlaceResult = {
  name: "Hyde Park, London, England", centre: [-0.16, 51.51], bboxWgs84: [-0.17, 51.505, -0.15, 51.515],
  outline: { type: "Polygon", coordinates: [[[-0.17, 51.505], [-0.15, 51.505], [-0.15, 51.515], [-0.17, 51.515], [-0.17, 51.505]]] },
};
const huge: PlaceResult = { name: "London, England", centre: [-0.19, 51.52], bboxWgs84: [-0.29, 51.47, -0.09, 51.57] };
const mid: PlaceResult = { name: "Kensington Gardens, London", centre: [-0.14, 51.50], bboxWgs84: [-0.17, 51.48, -0.11, 51.52] };

const presets = [{ name: "Light" }, { name: "Dark" }, { name: "Mono" }, { name: "Garden" }];
const flushReal = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

function stubApi() {
  current = projectWith();
  return {
    project: vi.spyOn(api, "project").mockImplementation(async () => ({ project: current, dirty: false, counts: null })),
    presets: vi.spyOn(api, "presets").mockResolvedValue(presets),
    areaPreview: vi.spyOn(api, "areaPreview").mockImplementation(() => new Promise(() => {})),
  };
}

beforeEach(() => {
  resetSearchClock();
  resetSend();
  resetApp();
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

const typeSearch = (text: string) => fireEvent.change(screen.getByLabelText("Search for a place"), { target: { value: text } });

describe("New project", () => {
  it("search waits 400 ms and never sends two requests within a second", async () => {
    vi.useFakeTimers();
    stubApi();
    const places = vi.spyOn(api, "places").mockResolvedValue([small]);
    render(<NewProject onClose={() => {}} />);

    typeSearch("Rea");
    await act(() => vi.advanceTimersByTimeAsync(399));
    expect(places).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(places).toHaveBeenCalledTimes(1);
    expect(places).toHaveBeenLastCalledWith("Rea");

    // 100 ms later the person types more: 400 ms of quiet is not enough, the 1 s gap holds it back.
    await act(() => vi.advanceTimersByTimeAsync(100));
    typeSearch("Read");
    await act(() => vi.advanceTimersByTimeAsync(400));
    expect(places).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(499));
    expect(places).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(places).toHaveBeenCalledTimes(2);
    expect(places).toHaveBeenLastCalledWith("Read");
  });

  it("lists the results and shows the box for the chosen place", async () => {
    vi.useFakeTimers();
    stubApi();
    vi.spyOn(api, "places").mockResolvedValue([small, huge]);
    render(<NewProject onClose={() => {}} />);
    typeSearch("London");
    await act(() => vi.advanceTimersByTimeAsync(400));
    const list = screen.getByRole("list", { name: "Places" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    fireEvent.click(within(list).getByRole("button", { name: /Hyde Park/ }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByLabelText("Project name")).toHaveProperty("value", "Hyde Park");
    expect(screen.getByLabelText("Area box")).toBeTruthy();
    expect(screen.getByTestId("area-readout").textContent).toMatch(/^\d+\.\d km²$/);
  });

  async function pick(place: PlaceResult) {
    stubApi();
    vi.spyOn(api, "places").mockResolvedValue([place]);
    render(<NewProject onClose={() => {}} />);
    typeSearch("x");
    // Searches need two letters; "xx" is the shortest.
    typeSearch("xx");
    await act(() => vi.advanceTimersByTimeAsync(400));
    fireEvent.click(screen.getByRole("button", { name: new RegExp(place.name.split(",")[0]!) }));
    await act(() => vi.advanceTimersByTimeAsync(0));
  }

  it("BoxEditor shows km² and disables Create above 25 km²", async () => {
    vi.useFakeTimers();
    await pick(huge);
    expect(screen.getByTestId("area-readout").textContent).toMatch(/km²$/);
    expect(screen.getByText(TOO_BIG)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Create and fetch data" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("warns above 3 km² but still allows Create", async () => {
    vi.useFakeTimers();
    await pick(mid);
    expect(screen.getByText(/large area/i)).toBeTruthy();
    expect(screen.queryByText(TOO_BIG)).toBeNull();
    expect((screen.getByRole("button", { name: "Create and fetch data" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("Create and fetch posts new then refresh and shows elapsed seconds", async () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    stubApi();
    vi.spyOn(api, "places").mockResolvedValue([small]);
    const created = vi.spyOn(api, "newProject").mockImplementation(async () => { current = projectWith(); return current; });
    let finish!: (v: { counts: never; changed: never }) => void;
    const refresh = vi.spyOn(api, "refresh").mockImplementation(() => new Promise((r) => { finish = r as typeof finish; }));
    render(<NewProject onClose={onClose} />);
    typeSearch("Hyde Park");
    await act(() => vi.advanceTimersByTimeAsync(400));
    fireEvent.click(screen.getByRole("button", { name: /Hyde Park/ }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    fireEvent.click(screen.getByRole("button", { name: "Dark" }));
    fireEvent.click(screen.getByRole("button", { name: "Create and fetch data" }));
    await act(() => vi.advanceTimersByTimeAsync(0));

    expect(created).toHaveBeenCalledTimes(1);
    const [name, a, preset] = created.mock.calls[0]!;
    expect(name).toBe("Hyde Park");
    expect(a.placeName).toBe("Hyde Park, London, England");
    // The box is the place grown by 10 %.
    expect(a.bboxWgs84[0]).toBeLessThan(-0.17);
    expect(a.bboxWgs84[2]).toBeGreaterThan(-0.15);
    expect(preset).toBe("Dark");
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Fetching from OpenStreetMap… 0 s/)).toBeTruthy();
    expect(screen.getByText("Large areas can take up to a minute.")).toBeTruthy();
    await act(() => vi.advanceTimersByTimeAsync(3000));
    expect(screen.getByText(/Fetching from OpenStreetMap… 3 s/)).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => { finish({ counts: {} as never, changed: {} as never }); });
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(onClose).toHaveBeenCalled();
  });

  it("a refresh failure keeps the project and shows the message", async () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    const fake = stubApi();
    vi.spyOn(api, "places").mockResolvedValue([small]);
    vi.spyOn(api, "newProject").mockResolvedValue(projectWith());
    vi.spyOn(api, "refresh").mockRejectedValue(new ApiFail(503, "OpenStreetMap is busy right now. Try again in a minute."));
    render(<NewProject onClose={onClose} />);
    typeSearch("Hyde Park");
    await act(() => vi.advanceTimersByTimeAsync(400));
    fireEvent.click(screen.getByRole("button", { name: /Hyde Park/ }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    fireEvent.click(screen.getByRole("button", { name: "Create and fetch data" }));
    await act(() => vi.advanceTimersByTimeAsync(0));

    expect(screen.getByRole("alert").textContent).toContain("OpenStreetMap is busy right now. Try again in a minute.");
    expect(screen.getByText(/project was created/i)).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    expect(fake.project).toHaveBeenCalled(); // the app has the new project even though the fetch failed
    expect(getApp().project?.id).toBe("p1");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("creating a project re-reads the statuses at once", async () => {
    stubApi();
    vi.spyOn(api, "places").mockResolvedValue([small]);
    vi.spyOn(api, "newProject").mockResolvedValue(projectWith());
    vi.spyOn(api, "refresh").mockResolvedValue({ counts: {} as never, changed: {} });
    const targets = vi.spyOn(api, "targets").mockResolvedValue({ documents: [] } as never);
    vi.useFakeTimers();
    render(<NewProject onClose={() => {}} />);
    typeSearch("Hyde Park");
    await act(() => vi.advanceTimersByTimeAsync(400));
    fireEvent.click(screen.getByRole("button", { name: /Hyde Park/ }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    fireEvent.click(screen.getByRole("button", { name: "Create and fetch data" }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(targets).toHaveBeenCalled();
  });

  it("creating a project clears the previous send summary", async () => {
    stubApi();
    vi.spyOn(api, "places").mockResolvedValue([small]);
    vi.spyOn(api, "newProject").mockResolvedValue(projectWith());
    vi.spyOn(api, "refresh").mockResolvedValue({ counts: {} as never, changed: {} });
    vi.spyOn(api, "send").mockResolvedValue({ results: [{ mapId: "m", ok: true, created: 1 }] });
    const { sendMaps } = await import("../src/ui/maps/SendSummary.js");
    resetApp({ project: projectWith({ maps: [{ id: "m", name: "M" } as never] }), connection: { connected: true, busy: false } });
    await sendMaps({});
    expect(getSendState().summary).not.toBeNull();

    vi.useFakeTimers();
    render(<NewProject onClose={() => {}} />);
    typeSearch("Hyde Park");
    await act(() => vi.advanceTimersByTimeAsync(400));
    fireEvent.click(screen.getByRole("button", { name: /Hyde Park/ }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    fireEvent.click(screen.getByRole("button", { name: "Create and fetch data" }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(getSendState().summary).toBeNull();
  });
});

describe("BoxEditor", () => {
  it("dragging the right edge handle widens the box", () => {
    const onChange = vi.fn();
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300, x: 0, y: 0, toJSON() {} } as DOMRect);
    render(<BoxEditor place={small} bbox={[-0.171, 51.504, -0.149, 51.516]} onChange={onChange} />);
    const handle = screen.getByLabelText("Drag the right edge");
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 300, clientY: 150 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 330, clientY: 150 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 330, clientY: 150 });
    expect(onChange).toHaveBeenCalled();
    const last = onChange.mock.calls.at(-1)![0] as number[];
    expect(last[2]).toBeGreaterThan(-0.149);
    expect(last[0]).toBeCloseTo(-0.171, 5);
  });
});

describe("BoxEditor handles", () => {
  it("are 14 px on screen, measured from the fitted size", () => {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300, x: 0, y: 0, toJSON() {} } as DOMRect);
    render(<BoxEditor place={small} bbox={[-0.171, 51.504, -0.149, 51.516]} onChange={() => {}} />);
    const vbW = Number(screen.getByLabelText("Area box").getAttribute("viewBox")!.split(" ")[2]);
    const w = Number(screen.getByLabelText("Drag the right edge").getAttribute("width"));
    expect(w).toBeCloseTo((14 * vbW) / 300, 3);
  });
});

describe("BoxEditor view", () => {
  /** The viewBox as [x, y, w, h]. */
  const viewBox = () => screen.getByLabelText("Area box").getAttribute("viewBox")!.split(" ").map(Number) as [number, number, number, number];
  /** Every handle lies wholly inside the view (the svg is square-fitted, so the viewBox is what shows). */
  function expectHandlesInside(): void {
    const [x, y, w, h] = viewBox();
    for (const edge of ["left", "right", "top", "bottom"]) {
      const r = screen.getByLabelText(`Drag the ${edge} edge`);
      const rx = Number(r.getAttribute("x")), ry = Number(r.getAttribute("y"));
      const rw = Number(r.getAttribute("width")), rh = Number(r.getAttribute("height"));
      expect(rx, edge).toBeGreaterThanOrEqual(x);
      expect(ry, edge).toBeGreaterThanOrEqual(y);
      expect(rx + rw, edge).toBeLessThanOrEqual(x + w);
      expect(ry + rh, edge).toBeLessThanOrEqual(y + h);
    }
  }
  beforeEach(() => {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 400, height: 260, right: 400, bottom: 260, x: 0, y: 0, toJSON() {} } as DOMRect);
  });

  it("fits the outline and the box together, so a box bigger than the place keeps all its handles in view", () => {
    render(<BoxEditor place={small} bbox={[-0.21, 51.48, -0.89, 51.54]} onChange={() => {}} />);
    expectHandlesInside();
  });

  it("refits when the box ends up beyond the view", () => {
    const { rerender } = render(<BoxEditor place={small} bbox={[-0.171, 51.504, -0.149, 51.516]} onChange={() => {}} />);
    expectHandlesInside();
    rerender(<BoxEditor place={small} bbox={[-0.171, 51.47, -0.149, 51.482]} onChange={() => {}} />);
    expectHandlesInside();
  });

  it("keeps the view still while the box stays inside it", () => {
    const { rerender } = render(<BoxEditor place={small} bbox={[-0.171, 51.504, -0.149, 51.516]} onChange={() => {}} />);
    const before = viewBox();
    rerender(<BoxEditor place={small} bbox={[-0.1705, 51.504, -0.149, 51.516]} onChange={() => {}} />);
    expect(viewBox()).toEqual(before);
  });
});

describe("Area screen", () => {
  const topBar = {};
  const projections: ProjectionOption[] = [
    { id: "bng", name: "British National Grid", description: "The Ordnance Survey grid.", suggested: true },
    { id: "utm", name: "UTM", description: "A worldwide metric grid.", params: { zone: 30 }, suggested: false },
  ];

  function start(over: Partial<Project> = {}) {
    current = projectWith(over);
    resetApp({ project: current, connection: { connected: true, busy: false }, counts: null });
    vi.spyOn(api, "project").mockImplementation(async () => ({ project: current, dirty: false, counts: null }));
    vi.spyOn(api, "projections").mockResolvedValue(projections);
    vi.spyOn(api, "areaPreview").mockImplementation(() => new Promise(() => {}));
    render(<AreaScreen topBar={topBar} />);
  }

  it("shows the area map beside the settings, with the map frames", () => {
    start();
    expect(screen.getByLabelText("Map view")).toBeTruthy();
  });

  it("Refresh data lists the changes per role, or says nothing changed", async () => {
    start();
    const refresh = vi.spyOn(api, "refresh");
    refresh.mockResolvedValueOnce({ counts: {} as never, changed: { buildings: { before: 2380, after: 2400 } } });
    fireEvent.click(screen.getByRole("button", { name: "Refresh data" }));
    await flushReal();
    expect(screen.getByText("Buildings 2,380 → 2,400")).toBeTruthy();
    refresh.mockResolvedValueOnce({ counts: {} as never, changed: {} });
    fireEvent.click(screen.getByRole("button", { name: "Refresh data" }));
    await flushReal();
    expect(screen.getByText("Nothing changed")).toBeTruthy();
    expect(screen.queryByText("Buildings 2,380 → 2,400")).toBeNull();
  });

  it("shows the place, its size and a busy panel while refreshing", async () => {
    start();
    vi.spyOn(api, "refresh").mockImplementation(() => new Promise(() => {}));
    expect(screen.getByText("Hyde Park")).toBeTruthy();
    expect(screen.getByTestId("area-size").textContent).toMatch(/km²$/);
    fireEvent.click(screen.getByRole("button", { name: "Refresh data" }));
    await flushReal();
    expect(screen.getByText(/Fetching from OpenStreetMap… 0 s/)).toBeTruthy();
  });

  it("a busy refresh shows the server's message", async () => {
    start();
    vi.spyOn(api, "refresh").mockRejectedValue(new ApiFail(503, "OpenStreetMap is busy. Try again in a minute."));
    fireEvent.click(screen.getByRole("button", { name: "Refresh data" }));
    await flushReal();
    expect(screen.getByRole("alert").textContent).toContain("OpenStreetMap is busy. Try again in a minute.");
  });

  it("Use a file on a row imports with that row's role and the row shows the file name", async () => {
    start();
    vi.spyOn(platform, "openDataFile").mockResolvedValue("C:/data/new-buildings.shp");
    const imp = vi.spyOn(api, "importFile").mockImplementation(async () => {
      current = projectWith({ sources: { buildings: { kind: "file", path: "C:/data/new-buildings.shp", datasetName: "new-buildings" } } as never });
      return { counts: {} as never };
    });
    expect(screen.queryAllByRole("button", { name: "Use a file…" }).length).toBe(12);
    const buildings = screen.getByRole("listitem", { name: "Buildings" });
    expect(within(buildings).getByText("OpenStreetMap")).toBeTruthy();
    fireEvent.click(within(buildings).getByRole("button", { name: "Use a file…" }));
    await flushReal();
    const dialog = screen.getByRole("dialog", { name: "Which data is this file?" });
    expect((within(dialog).getByRole("radio", { name: "Buildings" }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(within(dialog).getByRole("button", { name: "Import" }));
    await flushReal();
    expect(imp).toHaveBeenCalledWith("C:/data/new-buildings.shp", "buildings");
    const row = screen.getByRole("listitem", { name: "Buildings" });
    expect(row.textContent).toContain("new-buildings.shp");
    expect(screen.queryByRole("dialog", { name: "Which data is this file?" })).toBeNull();
  });

  it("the import toast counts objects", async () => {
    start();
    vi.spyOn(platform, "openDataFile").mockResolvedValue("C:/data/new-buildings.shp");
    vi.spyOn(api, "importFile").mockResolvedValue({ counts: { buildings: 12 } as never });
    const buildings = screen.getByRole("listitem", { name: "Buildings" });
    fireEvent.click(within(buildings).getByRole("button", { name: "Use a file…" }));
    await flushReal();
    fireEvent.click(within(screen.getByRole("dialog", { name: "Which data is this file?" })).getByRole("button", { name: "Import" }));
    await flushReal();
    expect(screen.getByText("Imported new-buildings.shp: 12 objects.")).toBeTruthy();
  });

  it("Escape cancels the role picker", async () => {
    start();
    vi.spyOn(platform, "openDataFile").mockResolvedValue("/d/x.shp");
    const imp = vi.spyOn(api, "importFile");
    fireEvent.click(within(screen.getByRole("listitem", { name: "Water" })).getByRole("button", { name: "Use a file…" }));
    await flushReal();
    expect(screen.getByRole("dialog", { name: "Which data is this file?" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    await flushReal();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(imp).not.toHaveBeenCalled();
  });

  it("the Suggested chip is not lime", async () => {
    start();
    await flushReal();
    expect(screen.getByText("Suggested").className).not.toContain("lime");
  });

  it("a failed reload after a good fetch is not reported as a fetch error", async () => {
    start();
    vi.spyOn(api, "refresh").mockResolvedValue({ counts: {} as never, changed: { buildings: { before: 1, after: 2 } } });
    (api.project as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("reload broke"));
    fireEvent.click(screen.getByRole("button", { name: "Refresh data" }));
    await flushReal();
    expect(screen.getAllByRole("alert").every((a) => a.classList.contains("toast"))).toBe(true); // only the toast, no fetch error in the section
    expect(screen.getByText("Buildings 1 → 2")).toBeTruthy();
    expect(screen.getByText("reload broke")).toBeTruthy(); // as a toast
  });

  it("choosing no file does nothing", async () => {
    start();
    vi.spyOn(platform, "openDataFile").mockResolvedValue(null);
    fireEvent.click(within(screen.getByRole("listitem", { name: "Water" })).getByRole("button", { name: "Use a file…" }));
    await flushReal();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Use OpenStreetMap sets a file role back", async () => {
    start({ sources: { buildings: { kind: "file", path: "/d/x.geojson", datasetName: "x" } } as never });
    const set = vi.spyOn(api, "setSource").mockResolvedValue({ counts: {} as never });
    const row = screen.getByRole("listitem", { name: "Buildings" });
    expect(row.textContent).toContain("x.geojson");
    fireEvent.click(within(row).getByRole("button", { name: "Use OpenStreetMap" }));
    await flushReal();
    expect(set).toHaveBeenCalledWith("buildings", { kind: "osm" });
  });

  it("changing projection asks first", async () => {
    start();
    await flushReal();
    const set = vi.spyOn(api, "setArea").mockResolvedValue(projectWith());
    expect(screen.getByText("Suggested")).toBeTruthy();
    expect((screen.getByRole("radio", { name: /British National Grid/ }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: /UTM/ }));
    await flushReal();
    expect(screen.getByText("Changing the projection changes every map. Sent maps will show 'Changed since sent'.")).toBeTruthy();
    expect(set).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await flushReal();
    expect(set).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("radio", { name: /UTM/ }));
    await flushReal();
    fireEvent.click(screen.getByRole("button", { name: "Change projection" }));
    await flushReal();
    expect(set).toHaveBeenCalledWith("utm", { zone: 30 });
  });
});

describe("App wiring", () => {
  it("the empty state offers New project, which opens the search", async () => {
    stubApi();
    vi.spyOn(api, "affinity").mockResolvedValue({ connected: false, busy: false });
    vi.spyOn(api, "project").mockResolvedValue({ project: null, dirty: false, counts: null });
    render(<App />);
    await flushReal();
    fireEvent.click(screen.getByRole("button", { name: "New project" }));
    expect(screen.getByLabelText("Search for a place")).toBeTruthy();
  });

  it("opening a project clears the previous send summary", async () => {
    stubApi();
    vi.spyOn(api, "affinity").mockResolvedValue({ connected: true, busy: false });
    vi.spyOn(api, "send").mockResolvedValue({ results: [{ mapId: "m", ok: true, created: 1 }] });
    vi.spyOn(api, "open").mockResolvedValue(projectWith());
    vi.spyOn(platform, "openProject").mockResolvedValue("C:\\p\\a.afgeo");
    vi.spyOn(platform, "addRecent").mockResolvedValue([]);
    const { sendMaps } = await import("../src/ui/maps/SendSummary.js");
    current = projectWith({ maps: [{ id: "m", name: "M" } as never] });
    resetApp({ project: current, screen: "area", connection: { connected: true, busy: false } });
    await sendMaps({});
    expect(getSendState().summary).not.toBeNull();
    vi.spyOn(api, "projections").mockResolvedValue([]);
    render(<App />);
    await flushReal();
    fireEvent.click(screen.getByRole("button", { name: "Open…" }));
    await flushReal();
    expect(getSendState().summary).toBeNull();
  });
});
