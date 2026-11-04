// @vitest-environment jsdom
// The area editor: box or shape on the street map, with the surrounding context.
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlaceResult } from "@affinitygeo/geo-core";
import {
  CONTEXT_DEFAULT_M, MAX_KM2, TOO_BIG, boxRing, fetchKm2, ringAreaKm2, ringBbox, type Ring,
} from "@affinitygeo/geo-core/view";
import { AreaEditor, initialArea, type AreaValue } from "../src/ui/area/AreaEditor.js";

// The Basemap runs its offline fallback (a plain Web Mercator fit), so no real map is made.
vi.mock("maplibre-gl", () => {
  class Stub { constructor() { throw new Error("no map in tests"); } }
  return { Map: Stub, NavigationControl: Stub, AttributionControl: Stub };
});

const square: Ring = [[-0.17, 51.505], [-0.15, 51.505], [-0.15, 51.515], [-0.17, 51.515]];
const hydePark: PlaceResult = {
  name: "Hyde Park, London, England", centre: [-0.16, 51.51], bboxWgs84: [-0.17, 51.505, -0.15, 51.515],
  outline: { type: "Polygon", coordinates: [[...square, square[0]!]] },
};

/** A wiggly 120-corner outline around Hyde Park. */
function wiggly(): PlaceResult {
  const ring: [number, number][] = [];
  for (let i = 0; i < 120; i++) {
    const a = (i / 120) * 2 * Math.PI;
    const r = 1 + 0.08 * Math.sin(i * 1.7);
    ring.push([-0.16 + 0.01 * r * Math.cos(a), 51.51 + 0.006 * r * Math.sin(a)]);
  }
  return { ...hydePark, outline: { type: "Polygon", coordinates: [[...ring, ring[0]!]] } };
}

let last: AreaValue;
function Harness({ start, place = hydePark }: { start: AreaValue; place?: PlaceResult | null }) {
  const [v, setV] = useState(start);
  last = v;
  return <AreaEditor value={v} onChange={(n) => { last = n; setV(n); }} place={place} fitKey="k" />;
}

const shape = (ring: Ring, contextM = 0): AreaValue => ({ kind: "shape", ring, contextM });
const corners = () => screen.getAllByRole("button", { name: /^Corner \d+$/ });

beforeEach(() => {
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300, x: 0, y: 0, toJSON() {} } as DOMRect);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("initialArea", () => {
  it("grows a small place's bbox by 10 % as a box with the default context", () => {
    const a = initialArea(hydePark);
    expect(a.kind).toBe("box");
    expect(a.contextM).toBe(CONTEXT_DEFAULT_M);
    const [w, s, e, n] = ringBbox(a.ring);
    expect(w).toBeCloseTo(-0.171, 6);
    expect(e).toBeCloseTo(-0.149, 6);
    expect(s).toBeCloseTo(51.5045, 6);
    expect(n).toBeCloseTo(51.5155, 6);
  });

  it("gives a 97 km² place a square that fits the limit with its context, centred on the place", () => {
    // About 11 km × 8.9 km.
    const big: PlaceResult = { name: "Big, London", centre: [-0.12, 51.5], bboxWgs84: [-0.2, 51.46, -0.04, 51.54] };
    const box = ringAreaKm2(boxRing(big.bboxWgs84));
    expect(box).toBeGreaterThan(90);
    expect(box).toBeLessThan(105);
    const a = initialArea(big);
    expect(fetchKm2(a)).toBeLessThanOrEqual(MAX_KM2);
    const [w, s, e, n] = ringBbox(a.ring);
    expect((w + e) / 2).toBeCloseTo(-0.12, 6);
    expect((s + n) / 2).toBeCloseTo(51.5, 6);
    expect(ringAreaKm2(a.ring)).toBeGreaterThan(15);
  });
});

describe("AreaEditor", () => {
  it("Fit to place outline makes a shape with at most 40 corners", () => {
    render(<Harness start={initialArea(wiggly())} place={wiggly()} />);
    fireEvent.click(screen.getByRole("button", { name: "Fit to place outline" }));
    expect(last.kind).toBe("shape");
    expect(last.ring.length).toBeLessThanOrEqual(40);
    expect(last.ring.length).toBeGreaterThanOrEqual(3);
    expect(corners()).toHaveLength(last.ring.length);
  });

  it("has no Fit to place outline without an outline", () => {
    render(<Harness start={initialArea(hydePark)} place={{ ...hydePark, outline: undefined }} />);
    expect(screen.queryByRole("button", { name: "Fit to place outline" })).toBeNull();
  });

  it("clicking an edge's dot adds a corner between its neighbours", () => {
    render(<Harness start={shape(square)} />);
    fireEvent.click(screen.getByRole("button", { name: "Add a corner after corner 1" }));
    expect(last.ring).toHaveLength(5);
    expect(last.ring[0]).toEqual(square[0]);
    expect(last.ring[1]![0]).toBeCloseTo(-0.16, 9);
    expect(last.ring[1]![1]).toBeCloseTo(51.505, 9);
    expect(last.ring[2]).toEqual(square[1]);
    expect(corners()).toHaveLength(5);
  });

  it("hides the add dots at 60 corners", () => {
    const ring: Ring = Array.from({ length: 60 }, (_, i) => {
      const a = (i / 60) * 2 * Math.PI;
      return [-0.16 + 0.01 * Math.cos(a), 51.51 + 0.006 * Math.sin(a)] as [number, number];
    });
    render(<Harness start={shape(ring)} />);
    expect(screen.queryAllByRole("button", { name: /^Add a corner/ })).toHaveLength(0);
  });

  it("double-clicking a corner removes it, but never below 3 corners", () => {
    render(<Harness start={shape(square)} />);
    fireEvent.doubleClick(screen.getByRole("button", { name: "Corner 2" }));
    expect(last.ring).toEqual([square[0], square[2], square[3]]);
    fireEvent.doubleClick(screen.getByRole("button", { name: "Corner 1" }));
    expect(last.ring).toHaveLength(3);
  });

  it("Delete removes the focused corner, and the arrow keys move it", () => {
    render(<Harness start={shape(square)} />);
    const before = last.ring[0]!;
    fireEvent.keyDown(screen.getByRole("button", { name: "Corner 1" }), { key: "ArrowRight" });
    expect(last.ring[0]![0]).toBeGreaterThan(before[0]);
    expect(last.ring[0]![1]).toBeCloseTo(before[1], 9);
    fireEvent.keyDown(screen.getByRole("button", { name: "Corner 3" }), { key: "Delete" });
    expect(last.ring).toHaveLength(3);
  });

  it("dragging a corner moves only that corner", () => {
    render(<Harness start={shape(square)} />);
    const c = screen.getByRole("button", { name: "Corner 2" });
    const x = Number(c.getAttribute("cx")), y = Number(c.getAttribute("cy"));
    fireEvent.pointerDown(c, { pointerId: 1, clientX: x, clientY: y });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: x + 20, clientY: y });
    fireEvent.pointerUp(window, { pointerId: 1 });
    expect(last.ring[1]![0]).toBeGreaterThan(square[1]![0]);
    expect(last.ring[0]).toEqual(square[0]);
    expect(last.ring[2]).toEqual(square[2]);
  });

  it("the context slider moves in 50 m steps and the size line shows the fetched size", () => {
    render(<Harness start={{ kind: "box", ring: square, contextM: 0 }} />);
    const slider = screen.getByLabelText("Surrounding context") as HTMLInputElement;
    expect(slider.step).toBe("50");
    expect(slider.min).toBe("0");
    expect(slider.max).toBe("1000");
    expect(screen.getByTestId("area-readout").textContent).not.toContain("with context");
    fireEvent.change(slider, { target: { value: "350" } });
    expect(last.contextM).toBe(350);
    expect(screen.getByText("350 m")).toBeTruthy();
    expect(screen.getByTestId("area-readout").textContent).toMatch(/^\d+\.\d km² · \d+\.\d km² with context$/);
  });

  it("shows the too-big message when the fetched area is over the limit", () => {
    const big = boxRing([-0.2, 51.46, -0.04, 51.54]);
    render(<Harness start={{ kind: "box", ring: big, contextM: 0 }} />);
    expect(screen.getByText(TOO_BIG).className).toContain("help-bad");
  });

  it("a bow tie shows the crossing message", () => {
    render(<Harness start={shape([square[0]!, square[2]!, square[1]!, square[3]!])} />);
    expect(screen.getByText(/edges cross/)).toBeTruthy();
  });

  it("Box to Shape keeps the 4 corners, and Shape to Box goes back to the bounding box", () => {
    const tri: Ring = [[-0.17, 51.505], [-0.15, 51.506], [-0.16, 51.515]];
    render(<Harness start={{ kind: "box", ring: square, contextM: 0 }} />);
    expect(screen.getByText("Drag an edge to resize the area, or drag inside the box to move it.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Shape" }));
    expect(last).toEqual({ kind: "shape", ring: square, contextM: 0 });
    expect(corners()).toHaveLength(4);
    expect(screen.getByText("Drag a corner to move it. Click a dot on an edge to add a corner. Double-click a corner to remove it.")).toBeTruthy();
    cleanup();
    render(<Harness start={shape(tri)} />);
    fireEvent.click(screen.getByRole("button", { name: "Box" }));
    expect(last.kind).toBe("box");
    expect(last.ring).toEqual(boxRing(ringBbox(tri)));
  });

  it("dragging the right edge in box mode widens the box", () => {
    render(<Harness start={{ kind: "box", ring: square, contextM: 0 }} />);
    const h = screen.getByLabelText("Drag the right edge");
    const x = Number(h.getAttribute("x")), y = Number(h.getAttribute("y"));
    fireEvent.pointerDown(h, { pointerId: 1, clientX: x, clientY: y });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: x + 30, clientY: y + 10 });
    fireEvent.pointerUp(window, { pointerId: 1 });
    const [w, s, e, n] = ringBbox(last.ring);
    expect(e).toBeGreaterThan(-0.15);
    expect(w).toBeCloseTo(-0.17, 9);
    expect(s).toBeCloseTo(51.505, 9);
    expect(n).toBeCloseTo(51.515, 9);
    expect(last.ring).toEqual(boxRing([w, s, e, n]));
  });

  it("the overlay lets the map get the pointer except on the shape and its handles", () => {
    render(<Harness start={shape(square)} />);
    const svg = screen.getByLabelText("Area editor");
    expect(svg.getAttribute("style")).toContain("pointer-events: none");
  });
});
