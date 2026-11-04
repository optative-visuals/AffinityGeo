// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projector, type AreaSpec, type MapSpec, type ProjectStyle } from "@affinitygeo/geo-core/view";
import { MapCanvas, type MapCanvasProps } from "../src/ui/map/MapCanvas.js";
import { toScreen, toWorld, fit, zoomAt } from "../src/ui/map/viewport.js";

const area: AreaSpec = { placeName: "Hyde Park", bboxWgs84: [-0.17, 51.50, -0.14, 51.52], projectionId: "bng" };
const W = 400, H = 300;
const style = { presetName: "T", roles: {}, marker: {} } as unknown as ProjectStyle;
const map = (id: string, centre: [number, number], rotationDeg = 0): MapSpec => ({
  id, name: id, centre, scale: 2500, rotationDeg, sizeMm: { width: 100, height: 100 },
  marker: false, target: null, resizeArtboard: null, sent: null, locationId: "l1", showContext: false,
});

class Path2DStub { moveTo() {} lineTo() {} closePath() {} arc() {} }

beforeEach(() => {
  vi.stubGlobal("Path2D", Path2DStub);
  const ctx = new Proxy({}, { get: (t: Record<string, unknown>, k: string) => (k in t ? t[k] : () => undefined), set: (t, k, v) => { t[k as string] = v; return true; } });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: W, height: H, right: W, bottom: H, x: 0, y: 0, toJSON() {} } as DOMRect);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function setup(over: Partial<MapCanvasProps> = {}) {
  const props: MapCanvasProps = {
    preview: null, style, maps: [], selectedIds: [], mode: "browse", area,
    onSelect: vi.fn(), onAdd: vi.fn(), onMove: vi.fn(), onRotate: vi.fn(), onPick: vi.fn(), ...over,
  };
  const r = render(<MapCanvas {...props} />);
  return { props, canvas: r.getByLabelText("Map view") };
}

/** The view MapCanvas fits before there's data: the area's projected box. */
function areaView() {
  const pr = projector(area);
  const [w, s, e, n] = area.bboxWgs84;
  const pts = [pr.forward([w, s]), pr.forward([e, s]), pr.forward([e, n]), pr.forward([w, n])];
  return { pr, view: fit([Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))], W, H) };
}

describe("MapCanvas", () => {
  it("in add mode, a click places a map at that point", () => {
    const { props, canvas } = setup({ mode: "add" });
    const { pr, view } = areaView();
    const [px, py] = toScreen(view, W, H, pr.forward([-0.155, 51.51]));
    fireEvent.pointerDown(canvas, { pointerId: 1, button: 0, clientX: px, clientY: py });
    fireEvent.pointerUp(canvas, { pointerId: 1, button: 0, clientX: px, clientY: py });
    expect(props.onAdd).toHaveBeenCalledTimes(1);
    const [lon, lat] = (props.onAdd as ReturnType<typeof vi.fn>).mock.calls[0]![0] as [number, number];
    expect(lon).toBeCloseTo(-0.155, 4);
    expect(lat).toBeCloseTo(51.51, 4);
  });

  it("dragging a pin selects it and sends the new centre once, on release", () => {
    const { props, canvas } = setup({ maps: [map("m1", [-0.155, 51.51])] });
    const { pr, view } = areaView();
    const [px, py] = toScreen(view, W, H, pr.forward([-0.155, 51.51]));
    fireEvent.pointerDown(canvas, { pointerId: 1, button: 0, clientX: px + 2, clientY: py });
    expect(props.onSelect).toHaveBeenCalledWith(["m1"]);
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: px + 22, clientY: py });
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: px + 42, clientY: py });
    expect(props.onMove).not.toHaveBeenCalled();
    fireEvent.pointerUp(canvas, { pointerId: 1, clientX: px + 42, clientY: py });
    expect(props.onMove).toHaveBeenCalledTimes(1);
    const [id, [lon, lat]] = (props.onMove as ReturnType<typeof vi.fn>).mock.calls[0]! as [string, [number, number]];
    expect(id).toBe("m1");
    expect(lon).toBeGreaterThan(-0.155); // moved east
    expect(lat).toBeCloseTo(51.51, 3);
  });

  it("dragging the rotate handle of the selected map rotates it in whole degrees", () => {
    const m = map("m1", [-0.155, 51.51]);
    const { props, canvas } = setup({ maps: [m], selectedIds: ["m1"] });
    const { pr, view } = areaView();
    const [cx, cy] = pr.forward(m.centre);
    const half = (0.1 * m.scale) / 2; // 100 mm at 1:2500 = 250 m across
    const [hx, hy] = toScreen(view, W, H, [cx + half, cy + half]); // top-right corner
    const [ex, ey] = toScreen(view, W, H, [cx + Math.SQRT2 * half, cy]); // swing it round to due east of the centre
    fireEvent.pointerDown(canvas, { pointerId: 1, button: 0, clientX: hx, clientY: hy });
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: ex, clientY: ey });
    fireEvent.pointerUp(canvas, { pointerId: 1, clientX: ex, clientY: ey });
    expect(props.onRotate).toHaveBeenCalledTimes(1);
    const deg = (props.onRotate as ReturnType<typeof vi.fn>).mock.calls[0]![1] as number;
    expect(Number.isInteger(deg)).toBe(true);
    // The corner went from bearing ~45° to 90°: the map turns 45° (BNG grid north differs from true north slightly).
    expect(Math.abs(deg - 45)).toBeLessThanOrEqual(2);
  });

  it("read-only: a pin can't be selected or dragged, and the canvas pans instead", () => {
    const { props, canvas } = setup({ maps: [map("m1", [-0.155, 51.51])], readOnly: true });
    const { pr, view } = areaView();
    const [px, py] = toScreen(view, W, H, pr.forward([-0.155, 51.51]));
    fireEvent.pointerDown(canvas, { pointerId: 1, button: 0, clientX: px + 2, clientY: py });
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: px + 42, clientY: py });
    fireEvent.pointerUp(canvas, { pointerId: 1, clientX: px + 42, clientY: py });
    expect(props.onSelect).not.toHaveBeenCalled();
    expect(props.onMove).not.toHaveBeenCalled();
  });

  it("a click on empty space clears the selection", () => {
    const { props, canvas } = setup({ maps: [map("m1", [-0.155, 51.51])], selectedIds: ["m1"] });
    fireEvent.pointerDown(canvas, { pointerId: 1, button: 0, clientX: 5, clientY: 5 });
    fireEvent.pointerUp(canvas, { pointerId: 1, button: 0, clientX: 5, clientY: 5 });
    expect(props.onSelect).toHaveBeenCalledWith([]);
  });
});

describe("MapCanvas paper", () => {
  it("paints the area in the style's paper colour", () => {
    const fills: unknown[] = [];
    const t: Record<string, unknown> = {};
    const ctx = new Proxy(t, {
      get: (o, k: string) => (k === "fillRect" ? () => fills.push(o.fillStyle) : k in o ? o[k] : () => undefined),
      set: (o, k, v) => { o[k as string] = v; return true; },
    });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
    vi.stubGlobal("requestAnimationFrame", (cb: (t: number) => void) => { cb(0); return 0; });
    const pr = projector(area);
    const [w, s, e, n] = area.bboxWgs84;
    const [x0, y0] = pr.forward([w, s]);
    const [x1, y1] = pr.forward([e, n]);
    const paperStyle = { presetName: "Light", paper: "#1d2a33", roles: {}, marker: {} } as unknown as ProjectStyle;
    setup({ style: paperStyle, preview: { bounds: [x0, y0, x1, y1], layers: [], locations: [] } });
    expect(fills).toContain("#1d2a33");
  });
});

describe("MapCanvas resizing", () => {
  let observed: Array<() => void> = [];
  let box = { w: 200, h: 150 };
  beforeEach(() => {
    observed = [];
    box = { w: 200, h: 150 };
    vi.stubGlobal("ResizeObserver", class { constructor(cb: () => void) { observed.push(cb); } observe() {} disconnect() {} });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() =>
      ({ left: 0, top: 0, width: box.w, height: box.h, right: box.w, bottom: box.h, x: 0, y: 0, toJSON() {} }) as DOMRect);
  });
  const resize = (w: number, h: number) => { box = { w, h }; act(() => { for (const cb of observed) cb(); }); };
  const clickAt = (canvas: HTMLElement, x: number, y: number) => {
    fireEvent.pointerDown(canvas, { pointerId: 1, button: 0, clientX: x, clientY: y });
    fireEvent.pointerUp(canvas, { pointerId: 1, button: 0, clientX: x, clientY: y });
  };
  const bounds = () => {
    const pr = projector(area);
    const [w, s, e, n] = area.bboxWgs84;
    const pts = [pr.forward([w, s]), pr.forward([e, s]), pr.forward([e, n]), pr.forward([w, n])];
    return { pr, b: [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))] as [number, number, number, number] };
  };

  it("refits when its box grows, while the person hasn't panned or zoomed", () => {
    const { props, canvas } = setup({ mode: "add" });
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 10, clientY: 10 }); // the view is fitted at 200 × 150
    resize(400, 300);
    const { pr, b } = bounds();
    const [px, py] = toScreen(fit(b, 400, 300), 400, 300, pr.forward([-0.16, 51.505]));
    clickAt(canvas, px, py);
    const [lon, lat] = (props.onAdd as ReturnType<typeof vi.fn>).mock.calls[0]![0] as [number, number];
    expect(lon).toBeCloseTo(-0.16, 4);
    expect(lat).toBeCloseTo(51.505, 4);
  });

  it("after a zoom, a resize keeps the centre and the zoom", () => {
    const { props, canvas } = setup({ mode: "add" });
    fireEvent.wheel(canvas, { deltaY: -500 * Math.log(2), clientX: 100, clientY: 75 });
    resize(400, 300);
    const { pr, b } = bounds();
    const zoomed = zoomAt(fit(b, 200, 150), 200, 150, [100, 75], 2);
    clickAt(canvas, 300, 150);
    const [lon, lat] = (props.onAdd as ReturnType<typeof vi.fn>).mock.calls[0]![0] as [number, number];
    const [elon, elat] = pr.inverse(toWorld(zoomed, 400, 300, [300, 150]));
    expect(lon).toBeCloseTo(elon, 5);
    expect(lat).toBeCloseTo(elat, 5);
  });
});

describe("MapCanvas locations", () => {
  // The fetched area: a square 800 m across around the map's centre. The frame is 250 m across (100 mm at 1:2,500),
  // so its centre can go at most 275 m from the middle before a corner leaves the square.
  const centre: [number, number] = [-0.155, 51.51];
  const located = () => {
    const pr = projector(area);
    const [cx, cy] = pr.forward(centre);
    const sq = (r: number) => [[cx - r, cy - r], [cx + r, cy - r], [cx + r, cy + r], [cx - r, cy + r]];
    const [w, s, e, n] = area.bboxWgs84;
    const pts = [pr.forward([w, s]), pr.forward([e, s]), pr.forward([e, n]), pr.forward([w, n])];
    const bounds = [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))] as [number, number, number, number];
    return { pr, cx, cy, view: fit(bounds, W, H), preview: { bounds, layers: [], locations: [{ id: "l1", name: "Hyde Park", ring: sq(200), fetchRing: sq(400) }] } };
  };
  const drag = (canvas: HTMLElement, from: [number, number], steps: number[]) => {
    fireEvent.pointerDown(canvas, { pointerId: 1, button: 0, clientX: from[0] + 2, clientY: from[1] });
    for (const dx of steps) fireEvent.pointerMove(canvas, { pointerId: 1, clientX: from[0] + 2 + dx, clientY: from[1] });
    fireEvent.pointerUp(canvas, { pointerId: 1, clientX: from[0] + 2 + steps[steps.length - 1]!, clientY: from[1] });
  };
  const movedTo = (props: MapCanvasProps) => (props.onMove as ReturnType<typeof vi.fn>).mock.calls[0]![1] as [number, number];

  it("a frame dragged past its location's fetched area stops at the last centre that was inside", () => {
    const { pr, cx, view, preview } = located();
    const { props, canvas } = setup({ preview, maps: [map("m1", centre)] });
    const [px, py] = toScreen(view, W, H, pr.forward(centre));
    const mPerPx = toWorld(view, W, H, [1, 0])[0] - toWorld(view, W, H, [0, 0])[0];
    const ok = Math.round(100 / mPerPx); // about 100 m east: still inside
    drag(canvas, [px, py], [ok, ok * 3, ok * 10]); // then 300 m and 1 km: both outside
    expect(props.onMove).toHaveBeenCalledTimes(1);
    const [x] = pr.forward(movedTo(props));
    expect(x - cx).toBeGreaterThan(50);
    expect(x - cx).toBeLessThanOrEqual(275);
  });

  it("a frame already outside can be dragged back in, but not further out", () => {
    const { pr, cx, cy, view, preview } = located();
    const out = pr.inverse([cx + 350, cy]); // 75 m past the edge
    const mPerPx = toWorld(view, W, H, [1, 0])[0] - toWorld(view, W, H, [0, 0])[0];
    const step = Math.round(50 / mPerPx);

    const a = setup({ preview, maps: [map("m1", out)] });
    const [px, py] = toScreen(view, W, H, pr.forward(out));
    drag(a.canvas, [px, py], [-step]);
    expect(a.props.onMove).toHaveBeenCalledTimes(1);
    expect(pr.forward(movedTo(a.props))[0] - cx).toBeLessThan(350);
    cleanup();

    const b = setup({ preview, maps: [map("m1", out)] });
    drag(b.canvas, [px, py], [step]);
    expect(b.props.onMove).not.toHaveBeenCalled();
  });

  it("draws each location's fetched outline dashed", () => {
    const dashes: unknown[] = [];
    const t: Record<string, unknown> = {};
    const ctx = new Proxy(t, {
      get: (o, k: string) => (k === "setLineDash" ? (d: number[]) => dashes.push(d) : k in o ? o[k] : () => undefined),
      set: (o, k, v) => { o[k as string] = v; return true; },
    });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
    vi.stubGlobal("requestAnimationFrame", (cb: (t: number) => void) => { cb(0); return 0; });
    setup({ preview: located().preview });
    expect(dashes.some((d) => Array.isArray(d) && d.length > 0)).toBe(true);
  });
});
