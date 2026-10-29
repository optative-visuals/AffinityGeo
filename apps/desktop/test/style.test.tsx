// @vitest-environment jsdom
// The Style screen: presets, role rows, marker and the live preview.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PRESETS, mapFrameCorners, type AreaSpec, type MapSpec, type ProjectStyle } from "@affinitygeo/geo-core/view";
import { ApiFail, api } from "../src/ui/api.js";
import { FOCUS_PAD, StyleScreen, focusBox } from "../src/ui/style/StyleScreen.js";
import { getApp, resetApp, type AppState } from "../src/ui/store.js";

const area: AreaSpec = { placeName: "Hyde Park", bboxWgs84: [-0.17, 51.50, -0.14, 51.52], projectionId: "bng" };
type Project = NonNullable<AppState["project"]>;
const base = (): ProjectStyle => structuredClone(PRESETS[0]!);
const projectWith = (style: ProjectStyle, maps: MapSpec[] = []): Project =>
  ({ id: "p1", name: "W", area, style, maps, dataVersion: 1, sources: {}, fetchedAt: null, version: 1 }) as unknown as Project;

class Path2DStub { moveTo() {} lineTo() {} closePath() {} arc() {} rect() {} }

function start(style = base()) {
  resetApp({ project: projectWith(style), connection: { connected: true, busy: false }, preview: { status: "none" }, screen: "style" });
  const fake = {
    presets: vi.spyOn(api, "presets").mockResolvedValue(PRESETS.map((p) => ({ name: p.presetName }))),
    updateStyle: vi.spyOn(api, "updateStyle").mockImplementation(async (patch) => {
      const s = structuredClone(getApp().project!.style);
      for (const [r, v] of Object.entries(patch.roles ?? {})) Object.assign(s.roles[r as keyof typeof s.roles], v);
      if (patch.paper !== undefined) s.paper = patch.paper;
      return s;
    }),
    applyPreset: vi.spyOn(api, "applyPreset").mockImplementation(async (n) => structuredClone(PRESETS.find((p) => p.presetName === n)!)),
    project: vi.spyOn(api, "project").mockImplementation(async () => ({ project: getApp().project, dirty: true, counts: null })),
    areaPreview: vi.spyOn(api, "areaPreview").mockImplementation(() => new Promise(() => {})),
  };
  render(<StyleScreen />);
  return fake;
}

beforeEach(() => {
  vi.stubGlobal("Path2D", Path2DStub);
  const ctx = new Proxy({}, { get: (t: Record<string, unknown>, k: string) => (k in t ? t[k] : () => undefined), set: (t, k, v) => { t[k as string] = v; return true; } });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

describe("Style screen", () => {
  it("has a Background colour above the layers (no 'none'), patched as paper after 250 ms", async () => {
    const fake = start();
    await flush();
    const swatch = screen.getByLabelText("Background colour") as HTMLInputElement;
    expect(swatch.value).toBe(PRESETS[0]!.paper);
    expect(screen.getByText("Background colour")).toBeTruthy();
    expect(screen.getByText("Fills each map's frame, under every layer.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /No .* for Background/ })).toBeNull();
    // above the layer rows
    expect(swatch.compareDocumentPosition(screen.getByLabelText("Water fill")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.change(swatch, { target: { value: "#1d2a33" } });
    expect((screen.getByLabelText("Background colour") as HTMLInputElement).value).toBe("#1d2a33");
    await advance(260);
    expect(fake.updateStyle).toHaveBeenCalledTimes(1);
    expect(fake.updateStyle).toHaveBeenCalledWith({ paper: "#1d2a33" });
    expect(getApp().project!.style.paper).toBe("#1d2a33");
  });

  it("a refused background colour goes back to the server's", async () => {
    const fake = start();
    await flush();
    fake.updateStyle.mockRejectedValueOnce(new ApiFail(400, "The background must be a colour like #1a2b3c."));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.change(screen.getByLabelText("Background colour"), { target: { value: "#123456" } });
    await advance(260);
    await flush();
    expect((screen.getByLabelText("Background colour") as HTMLInputElement).value).toBe(PRESETS[0]!.paper);
  });

  it("changing a fill patches only that role's fill after 250 ms", async () => {
    const fake = start();
    await flush();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.change(screen.getByLabelText("Water fill"), { target: { value: "#112233" } });
    await advance(249);
    expect(fake.updateStyle).not.toHaveBeenCalled();
    await advance(2);
    expect(fake.updateStyle).toHaveBeenCalledTimes(1);
    expect(fake.updateStyle).toHaveBeenCalledWith({ roles: { water: { fill: "#112233" } } });
  });

  it("the eye toggles visible", async () => {
    const fake = start();
    await flush();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.click(screen.getByRole("button", { name: "Hide Water" }));
    await advance(260);
    expect(fake.updateStyle).toHaveBeenCalledWith({ roles: { water: { visible: false } } });
    expect(screen.getByRole("button", { name: "Show Water" })).toBeTruthy();
  });

  it("moving Paths up swaps order with its neighbour in one patch", async () => {
    const style = base();
    const fake = start(style);
    await flush();
    // Rows run top of stack first: the neighbour above Paths is the role with the next higher order.
    const ordered = Object.entries(style.roles).sort((a, b) => b[1].order - a[1].order).map(([id]) => id);
    const i = ordered.indexOf("paths");
    const above = ordered[i - 1]!;
    fireEvent.click(screen.getByRole("button", { name: "Move Paths and footways up" }));
    await flush();
    expect(fake.updateStyle).toHaveBeenCalledTimes(1);
    expect(fake.updateStyle).toHaveBeenCalledWith({
      roles: {
        paths: { order: style.roles[above as "paths"].order },
        [above]: { order: style.roles.paths.order },
      },
    });
  });

  it("choosing a preset asks first", async () => {
    const fake = start();
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /Dark/ }));
    expect(fake.applyPreset).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Replace your style tweaks with 'Dark'?")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Replace" }));
    await flush();
    expect(fake.applyPreset).toHaveBeenCalledWith("Dark");
  });

  it("cancelling the preset question changes nothing", async () => {
    const fake = start();
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /Dark/ }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Cancel" }));
    await flush();
    expect(fake.applyPreset).not.toHaveBeenCalled();
  });

  it("a 400 restores the previous colour and shows the message", async () => {
    const fake = start();
    await flush();
    const before = (screen.getByLabelText("Water fill") as HTMLInputElement).value;
    fake.updateStyle.mockRejectedValueOnce(new ApiFail(400, "Fill must be a colour like #1a2b3c, or null for none."));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.change(screen.getByLabelText("Water fill"), { target: { value: "#112233" } });
    expect((screen.getByLabelText("Water fill") as HTMLInputElement).value).toBe("#112233"); // optimistic
    await advance(260);
    await flush();
    expect((screen.getByLabelText("Water fill") as HTMLInputElement).value).toBe(before);
    expect(screen.getByText("Fill must be a colour like #1a2b3c, or null for none.")).toBeTruthy();
  });

  it("the none toggle patches fill null", async () => {
    const fake = start();
    await flush();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.click(screen.getByLabelText("No fill for Water"));
    await advance(260);
    expect(fake.updateStyle).toHaveBeenCalledWith({ roles: { water: { fill: null } } });
  });

  it("the width field patches strokePt", async () => {
    const fake = start();
    await flush();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.change(screen.getByLabelText("Main roads width"), { target: { value: "6.5" } });
    await advance(260);
    expect(fake.updateStyle).toHaveBeenCalledWith({ roles: { mainRoads: { strokePt: 6.5 } } });
  });

  it("the marker label patches marker", async () => {
    const fake = start();
    await flush();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.change(screen.getByLabelText("Marker label"), { target: { value: "Here" } });
    await advance(260);
    expect(fake.updateStyle).toHaveBeenCalledWith({ marker: { label: "Here" } });
  });

  it("marks the current preset", async () => {
    start();
    await flush();
    expect(screen.getByRole("button", { name: /Light/ }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: /Dark/ }).getAttribute("aria-pressed")).toBe("false");
  });

  it("an edit made while an earlier PATCH is in flight survives that PATCH's 400", async () => {
    const fake = start();
    await flush();
    const original = (screen.getByLabelText("Water fill") as HTMLInputElement).value;
    let reject!: (e: unknown) => void;
    fake.updateStyle.mockImplementationOnce(() => new Promise((_, r) => { reject = r; }));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.change(screen.getByLabelText("Water fill"), { target: { value: "#111111" } });
    await advance(260); // B is in flight
    fireEvent.change(screen.getByLabelText("Water fill"), { target: { value: "#222222" } }); // C pending
    await act(async () => { reject(new ApiFail(400, "No.")); });
    expect((screen.getByLabelText("Water fill") as HTMLInputElement).value).toBe("#222222");
    // C is refused too: back to the server's value, not to B.
    fake.updateStyle.mockRejectedValueOnce(new ApiFail(400, "No again."));
    await advance(260);
    await flush();
    expect((screen.getByLabelText("Water fill") as HTMLInputElement).value).toBe(original);
  });

  it("two fields of one role within 250 ms go out as one PATCH, and a 400 restores both", async () => {
    const fake = start();
    await flush();
    const fill = (screen.getByLabelText("Water fill") as HTMLInputElement).value;
    const width = (screen.getByLabelText("Water width") as HTMLInputElement).value;
    fake.updateStyle.mockRejectedValueOnce(new ApiFail(400, "Refused."));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.change(screen.getByLabelText("Water fill"), { target: { value: "#123456" } });
    await advance(100);
    fireEvent.change(screen.getByLabelText("Water width"), { target: { value: "3" } });
    await advance(300);
    await flush();
    expect(fake.updateStyle).toHaveBeenCalledTimes(1);
    expect(fake.updateStyle).toHaveBeenCalledWith({ roles: { water: { fill: "#123456", strokePt: 3 } } });
    expect((screen.getByLabelText("Water fill") as HTMLInputElement).value).toBe(fill);
    expect((screen.getByLabelText("Water width") as HTMLInputElement).value).toBe(width);
  });

  it("a reply never overwrites a newer local edit", async () => {
    const fake = start();
    await flush();
    let resolve!: (s: ProjectStyle) => void;
    fake.updateStyle.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.change(screen.getByLabelText("Water fill"), { target: { value: "#111111" } });
    await advance(260);
    fireEvent.change(screen.getByLabelText("Water fill"), { target: { value: "#222222" } });
    const reply = structuredClone(getApp().project!.style);
    reply.roles.water.fill = "#111111";
    await act(async () => { resolve(reply); });
    expect((screen.getByLabelText("Water fill") as HTMLInputElement).value).toBe("#222222");
  });

  it("the none toggle is labelled and pressed; the slashed swatch restores the remembered colour", async () => {
    const fake = start();
    await flush();
    const remembered = (screen.getByLabelText("Water fill") as HTMLInputElement).value;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const toggle = screen.getByLabelText("No fill for Water");
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(toggle.getAttribute("title")).toBe("No fill");
    fireEvent.click(toggle);
    await advance(260);
    expect(fake.updateStyle).toHaveBeenLastCalledWith({ roles: { water: { fill: null } } });
    expect(screen.getByLabelText("No fill for Water").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByTestId("Water fill-none"));
    await advance(260);
    expect(fake.updateStyle).toHaveBeenLastCalledWith({ roles: { water: { fill: remembered } } });
  });

  it("the width is rounded to one decimal place", async () => {
    const fake = start();
    await flush();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.change(screen.getByLabelText("Main roads width"), { target: { value: "2.349" } });
    await advance(260);
    expect(fake.updateStyle).toHaveBeenCalledWith({ roles: { mainRoads: { strokePt: 2.3 } } });
  });

  it("focus fits the selected frame with a named padding", () => {
    const map: MapSpec = { id: "m", name: "M", centre: [-0.155, 51.51], scale: 2500, rotationDeg: 0, sizeMm: { width: 420, height: 297 }, marker: true, target: null, resizeArtboard: null, sent: null };
    const c = mapFrameCorners(area, map);
    const xs = c.map((q) => q[0]), ys = c.map((q) => q[1]);
    const [x0, y0, x1, y1] = focusBox(area, map)!;
    const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...ys) - Math.min(...ys);
    const pad = Math.max(w, h) * FOCUS_PAD;
    expect(x0).toBeCloseTo(Math.min(...xs) - pad, 6);
    expect(y1).toBeCloseTo(Math.max(...ys) + pad, 6);
    expect(x1 - x0).toBeGreaterThan(w);
    expect(y0).toBeLessThan(Math.min(...ys));
  });
});

describe("pending debounced edits (final review)", () => {
  it("an edit still waiting for its 250 ms is sent when the edits are flushed, and only once", async () => {
    const { flushPendingEdits } = await import("../src/ui/store.js");
    const fake = start();
    await flush();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.change(screen.getByLabelText("Water fill"), { target: { value: "#112233" } });
    expect(fake.updateStyle).not.toHaveBeenCalled();
    await act(async () => { await flushPendingEdits(); });
    expect(fake.updateStyle).toHaveBeenCalledWith({ roles: { water: { fill: "#112233" } } });
    await advance(300);
    expect(fake.updateStyle).toHaveBeenCalledTimes(1);
  });
});
