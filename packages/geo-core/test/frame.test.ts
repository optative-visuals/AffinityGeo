import { describe, expect, it } from "vitest";
import { fitFrame, pageToWorld, worldToPage } from "../src/frame.js";

describe("frame", () => {
  it("fits, centres and flips y", () => {
    const t = fitFrame([0, 0, 100, 50], { x: 10, y: 20, width: 200, height: 200 });
    expect(t.scale).toBe(2);
    expect(worldToPage(t, 0, 50)).toEqual([10, 70]);
    expect(worldToPage(t, 100, 0)).toEqual([210, 170]);
  });
  it("round-trips", () => {
    const t = fitFrame([-5, 3, 17, 40], { x: 0, y: 0, width: 300, height: 120 }, 10);
    const [px, py] = worldToPage(t, 4.2, 11.1);
    const [x, y] = pageToWorld(t, px, py);
    expect(x).toBeCloseTo(4.2, 9);
    expect(y).toBeCloseTo(11.1, 9);
  });
  it("applies padding", () => {
    const t = fitFrame([0, 0, 100, 100], { x: 0, y: 0, width: 120, height: 120 }, 10);
    expect(t.scale).toBe(1);
    expect(worldToPage(t, 0, 100)).toEqual([10, 10]);
  });
  it("handles degenerate boxes", () => {
    const pt = fitFrame([5, 5, 5, 5], { x: 0, y: 0, width: 100, height: 100 });
    expect(pt.scale).toBe(1);
    expect(worldToPage(pt, 5, 5)).toEqual([50, 50]);
    const flat = fitFrame([0, 5, 10, 5], { x: 0, y: 0, width: 100, height: 100 });
    expect(flat.scale).toBe(10);
    expect(Number.isFinite(flat.tx + flat.ty)).toBe(true);
  });
});
