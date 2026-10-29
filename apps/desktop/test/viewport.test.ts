import { describe, expect, it } from "vitest";
import { MAX_M_PER_PX, MIN_M_PER_PX, fit, toScreen, toWorld, zoomAt, type View } from "../src/ui/map/viewport.js";

const W = 800, H = 500;
const v: View = { cx: 1000, cy: 2000, mPerPx: 2 };

describe("viewport", () => {
  it("toWorld undoes toScreen, with screen y pointing down", () => {
    for (const p of [[1000, 2000], [1234.5, 1876.25], [-50, 9999]] as [number, number][]) {
      const s = toScreen(v, W, H, p);
      const back = toWorld(v, W, H, s);
      expect(back[0]).toBeCloseTo(p[0], 9);
      expect(back[1]).toBeCloseTo(p[1], 9);
    }
    expect(toScreen(v, W, H, [1000, 2000])).toEqual([400, 250]);
    // North (world y up) is towards the top of the screen.
    expect(toScreen(v, W, H, [1000, 2100])[1]).toBe(200);
  });

  it("zoomAt keeps the cursor point fixed", () => {
    const cursor: [number, number] = [120, 430];
    const before = toWorld(v, W, H, cursor);
    const z = zoomAt(v, W, H, cursor, 2);
    expect(z.mPerPx).toBeCloseTo(1, 12);
    const after = toWorld(z, W, H, cursor);
    expect(after[0]).toBeCloseTo(before[0], 9);
    expect(after[1]).toBeCloseTo(before[1], 9);
  });

  it("zoomAt clamps to 0.05–50 m/px and still keeps the cursor fixed", () => {
    const cursor: [number, number] = [700, 40];
    const before = toWorld(v, W, H, cursor);
    const zin = zoomAt(v, W, H, cursor, 1e6);
    expect(zin.mPerPx).toBe(MIN_M_PER_PX);
    expect(MIN_M_PER_PX).toBe(0.05);
    const after = toWorld(zin, W, H, cursor);
    expect(after[0]).toBeCloseTo(before[0], 9);
    expect(after[1]).toBeCloseTo(before[1], 9);
    expect(zoomAt(v, W, H, cursor, 1e-6).mPerPx).toBe(MAX_M_PER_PX);
    expect(MAX_M_PER_PX).toBe(50);
  });

  it("fit shows the whole bounds with a 5 % margin", () => {
    const bounds: [number, number, number, number] = [500, 100, 1500, 400]; // 1000 × 300 m: width-bound in 800 × 500
    const f = fit(bounds, W, H);
    expect(f.cx).toBe(1000);
    expect(f.cy).toBe(250);
    const tl = toScreen(f, W, H, [500, 400]);
    const br = toScreen(f, W, H, [1500, 100]);
    expect(tl[0]).toBeCloseTo(W * 0.05, 6);
    expect(br[0]).toBeCloseTo(W * 0.95, 6);
    expect(tl[1]).toBeGreaterThanOrEqual(H * 0.05);
    expect(br[1]).toBeLessThanOrEqual(H * 0.95);

    const tall = fit([0, 0, 100, 1000], W, H); // height-bound
    expect(toScreen(tall, W, H, [0, 1000])[1]).toBeCloseTo(H * 0.05, 6);
    expect(toScreen(tall, W, H, [0, 0])[1]).toBeCloseTo(H * 0.95, 6);
  });

  it("fit copes with empty bounds and a zero-size canvas", () => {
    const f = fit([10, 20, 10, 20], 0, 0);
    expect(f).toEqual({ cx: 10, cy: 20, mPerPx: MIN_M_PER_PX });
  });
});
