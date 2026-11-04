// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Basemap, type BasemapApi } from "../src/ui/map/Basemap.js";

type Handler = (e?: unknown) => void;
const mocks = vi.hoisted(() => ({ instances: [] as Array<{ handlers: Record<string, Handler[]>; fitBounds: ReturnType<typeof vi.fn>; options: unknown; remove: ReturnType<typeof vi.fn> }> }));

vi.mock("maplibre-gl", () => {
  class MapStub {
    handlers: Record<string, Handler[]> = {};
    fitBounds = vi.fn();
    remove = vi.fn();
    addControl = vi.fn();
    dragRotate = { disable: vi.fn() };
    touchZoomRotate = { disableRotation: vi.fn() };
    constructor(public options: unknown) { mocks.instances.push(this); }
    on(name: string, fn: Handler) { (this.handlers[name] ??= []).push(fn); }
    resize() {}
    project(p: [number, number]) { return { x: p[0] * 10, y: p[1] * 10 }; }
    unproject(p: [number, number]) { return { lng: p[0] / 10, lat: p[1] / 10 }; }
  }
  class ControlStub { constructor(public options?: unknown) {} }
  return { Map: MapStub, NavigationControl: ControlStub, AttributionControl: ControlStub };
});

const bbox: [number, number, number, number] = [-0.17, 51.5, -0.14, 51.52];
const emit = (name: string, e?: unknown) => mocks.instances[0]!.handlers[name]?.forEach((h) => h(e));

beforeEach(() => {
  mocks.instances.length = 0;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300, x: 0, y: 0, toJSON() {} } as DOMRect);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("Basemap", () => {
  it("creates a non-rotating map on the Positron style and fits the bbox", () => {
    render(<Basemap fit={{ bbox, paddingPx: 24 }} fitKey="a" />);
    const m = mocks.instances[0]!;
    expect(m.options).toMatchObject({ style: "https://tiles.openfreemap.org/styles/positron", dragRotate: false, pitchWithRotate: false, attributionControl: false });
    expect(m.fitBounds).toHaveBeenCalledWith([[-0.17, 51.5], [-0.14, 51.52]], expect.objectContaining({ padding: 24, animate: false }));
  });

  it("refits only when fitKey changes", () => {
    const { rerender } = render(<Basemap fit={{ bbox }} fitKey="a" />);
    const m = mocks.instances[0]!;
    rerender(<Basemap fit={{ bbox: [...bbox] }} fitKey="a" />);
    expect(m.fitBounds).toHaveBeenCalledTimes(1);
    rerender(<Basemap fit={{ bbox }} fitKey="b" />);
    expect(m.fitBounds).toHaveBeenCalledTimes(2);
  });

  it("projects through the map and bumps version on every move", () => {
    let api!: BasemapApi;
    render(<Basemap fit={{ bbox }} fitKey="a">{(a) => { api = a; return null; }}</Basemap>);
    expect(api.project([1, 2])).toEqual([10, 20]);
    expect(api.unproject([10, 20])).toEqual([1, 2]);
    const v = api.version;
    act(() => emit("move"));
    expect(api.version).toBeGreaterThan(v);
  });

  it("shows the offline note and keeps overlays when the map errors", () => {
    render(<Basemap fit={{ bbox }} fitKey="a">{() => <i data-testid="overlay" />}</Basemap>);
    expect(screen.queryByText("Street map unavailable offline")).toBeNull();
    act(() => emit("error", { error: new Error("net") }));
    expect(screen.getByText("Street map unavailable offline")).toBeTruthy();
    expect(screen.getByTestId("overlay")).toBeTruthy();
  });

  it("starts in the offline fallback without creating a map when the browser is offline", () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    render(<Basemap fit={{ bbox }} fitKey="a" />);
    expect(mocks.instances).toHaveLength(0);
    expect(screen.getByText("Street map unavailable offline")).toBeTruthy();
  });

  it("falls back to a Web Mercator fit that round-trips and keeps the bbox inside the view", () => {
    let api!: BasemapApi;
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    render(<Basemap fit={{ bbox, paddingPx: 20 }} fitKey="a">{(a) => { api = a; return null; }}</Basemap>);
    for (const p of [[-0.155, 51.51], [-0.17, 51.5], [-0.14, 51.52]] as Array<[number, number]>) {
      const back = api.unproject(api.project(p));
      expect(back[0]).toBeCloseTo(p[0], 6);
      expect(back[1]).toBeCloseTo(p[1], 6);
    }
    const [x0, y0] = api.project([bbox[0], bbox[3]]);
    const [x1, y1] = api.project([bbox[2], bbox[1]]);
    expect(Math.min(x0, y0)).toBeGreaterThanOrEqual(20 - 1e-6);
    expect(x1).toBeLessThanOrEqual(380 + 1e-6);
    expect(y1).toBeLessThanOrEqual(280 + 1e-6);
    expect(x1).toBeGreaterThan(x0);
    expect(y1).toBeGreaterThan(y0);
  });

  it("removes the map on unmount", () => {
    const { unmount } = render(<Basemap fit={{ bbox }} fitKey="a" />);
    const m = mocks.instances[0]!;
    unmount();
    expect(m.remove).toHaveBeenCalled();
  });
});
