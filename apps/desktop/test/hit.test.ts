import { describe, expect, it } from "vitest";
import { PIN_HIT_PX, bearingFrom, hitPin, hitRotateHandle, pinPoint } from "../src/ui/map/hit.js";
import { toScreen, type View } from "../src/ui/map/viewport.js";

const W = 400, H = 400;
const view: View = { cx: 0, cy: 0, mPerPx: 1 };
type Corners = [number, number][];
const box = (cx: number, cy: number, hw: number, hh: number): Corners =>
  [[cx - hw, cy + hh], [cx + hw, cy + hh], [cx + hw, cy - hh], [cx - hw, cy - hh]];

const maps = [{ id: "a" }, { id: "b" }, { id: "c" }];
const corners: Record<string, Corners> = {
  a: box(0, 0, 50, 30),
  b: box(100, 0, 50, 30),
  c: box(4, 0, 50, 30), // its pin sits 4 px right of a's, and c is drawn on top
};

describe("hitPin", () => {
  it("puts the pin at the frame centre", () => {
    expect(pinPoint(corners.b!)).toEqual([100, 0]);
  });

  it("finds the nearest pin within 8 px and null beyond", () => {
    const [bx, by] = toScreen(view, W, H, [100, 0]);
    expect(hitPin(maps, corners, view, W, H, [bx + 5, by - 5])).toBe("b");
    expect(PIN_HIT_PX).toBe(8);
    expect(hitPin(maps, corners, view, W, H, [bx + 7.9, by])).toBe("b");
    expect(hitPin(maps, corners, view, W, H, [bx + 8.1, by])).toBeNull();
    expect(hitPin(maps, corners, view, W, H, [bx, by + 20])).toBeNull();
  });

  it("prefers the nearer pin, and the topmost on a tie", () => {
    const [ax, ay] = toScreen(view, W, H, [0, 0]);
    expect(hitPin(maps, corners, view, W, H, [ax - 1, ay])).toBe("a");
    expect(hitPin(maps, corners, view, W, H, [ax + 2, ay])).toBe("c"); // equidistant: c is on top
    expect(hitPin(maps, corners, view, W, H, [ax + 3, ay])).toBe("c");
  });

  it("skips maps without corners", () => {
    expect(hitPin([{ id: "z" }], corners, view, W, H, [200, 200])).toBeNull();
  });
});

describe("hitRotateHandle", () => {
  it("finds the top-right corner of a frame within 8 px, only on the maps given", () => {
    const [tx, ty] = toScreen(view, W, H, corners.b![1]!);
    expect(hitRotateHandle(maps, corners, view, W, H, [tx + 3, ty + 3])).toBe("b");
    expect(hitRotateHandle(maps, corners, view, W, H, [tx + 9, ty])).toBeNull();
    expect(hitRotateHandle(maps, corners, view, W, H, [tx, ty], ["a"])).toBeNull();
    expect(hitRotateHandle(maps, corners, view, W, H, [tx, ty], ["b"])).toBe("b");
  });
});

describe("bearingFrom", () => {
  it("gives compass degrees: north 0, east 90, south 180, west 270", () => {
    expect(bearingFrom([10, 10], [10, 50])).toBe(0);
    expect(bearingFrom([10, 10], [60, 10])).toBe(90);
    expect(bearingFrom([10, 10], [10, -5])).toBe(180);
    expect(bearingFrom([10, 10], [-5, 10])).toBe(270);
    expect(bearingFrom([0, 0], [1, 1])).toBeCloseTo(45, 9);
  });
});
