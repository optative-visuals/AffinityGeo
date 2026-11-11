import { describe, expect, it } from "vitest";
import {
  areaKm2, boxRing, fetchKm2, fetchRing, pointInRing, ringAreaKm2, ringBbox, simplifyRing, validateRing,
  CONTEXT_MAX_M, CONTEXT_STEP_M, CONTEXT_DEFAULT_M, RING_MAX_VERTICES, OUTLINE_MAX_VERTICES,
  type Ring,
} from "../../src/project/view.js";
import * as root from "../../src/index.js";

const HYDE: [number, number, number, number] = [-0.1870, 51.5010, -0.1500, 51.5130];
const L: Ring = [[0, 51], [0.02, 51], [0.02, 51.01], [0.01, 51.01], [0.01, 51.02], [0, 51.02]];
const M_PER_DEG = 111320;

function isConvex(r: Ring): boolean {
  let sign = 0;
  for (let i = 0; i < r.length; i++) {
    const a = r[i]!, b = r[(i + 1) % r.length]!, c = r[(i + 2) % r.length]!;
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cross) < 1e-15) continue;
    const s = Math.sign(cross);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

describe("constants", () => {
  it("has the agreed values and is exported from the package root", () => {
    expect([CONTEXT_MAX_M, CONTEXT_STEP_M, CONTEXT_DEFAULT_M, RING_MAX_VERTICES, OUTLINE_MAX_VERTICES])
      .toEqual([1000, 50, 200, 60, 40]);
    expect(root.boxRing).toBe(boxRing);
  });
});

describe("boxRing / ringBbox / ringAreaKm2", () => {
  it("builds the corners in order", () => {
    expect(boxRing([0, 51, 0.01, 51.01])).toEqual([[0, 51], [0.01, 51], [0.01, 51.01], [0, 51.01]]);
  });
  it("round-trips the bbox", () => {
    expect(ringBbox(boxRing(HYDE))).toEqual(HYDE);
  });
  it("matches areaKm2 for a box within 0.1 %", () => {
    expect(Math.abs(ringAreaKm2(boxRing(HYDE)) / areaKm2(HYDE) - 1)).toBeLessThan(0.001);
  });
});

describe("validateRing", () => {
  it("rejects too few corners", () => {
    expect(validateRing([[0, 0], [1, 1]])).toBe("A shape needs at least 3 corners.");
  });
  it("rejects too many corners", () => {
    const ring: Ring = Array.from({ length: 61 }, (_, i) => [Math.cos(i / 61 * 2 * Math.PI), Math.sin(i / 61 * 2 * Math.PI)]);
    expect(validateRing(ring)).toBe("A shape can have at most 60 corners.");
  });
  it("rejects a bow tie", () => {
    expect(validateRing([[0, 0], [1, 1], [1, 0], [0, 1]]))
      .toBe("The shape's edges cross. Move a corner so the outline doesn't cross itself.");
  });
  it("accepts a concave L-shape and a box", () => {
    expect(validateRing(L)).toBeNull();
    expect(validateRing(boxRing(HYDE))).toBeNull();
  });
});

describe("pointInRing", () => {
  it("is even-odd", () => {
    expect(pointInRing([0.005, 51.015], L)).toBe(true);
    expect(pointInRing([0.015, 51.015], L)).toBe(false);
  });
});

describe("fetchRing", () => {
  it("returns a box with no margin unchanged", () => {
    const ring = boxRing(HYDE);
    expect(fetchRing({ kind: "box", ring, contextM: 0 })).toBe(ring);
  });
  it("gives the plain convex hull for a shape with no margin", () => {
    const hull = fetchRing({ kind: "shape", ring: L, contextM: 0 });
    expect(isConvex(hull)).toBe(true);
    for (const v of L) {
      const onVertex = hull.some((h) => Math.abs(h[0] - v[0]) < 1e-12 && Math.abs(h[1] - v[1]) < 1e-12);
      expect(onVertex || pointInRing(v, hull)).toBe(true);
    }
  });
  it("covers points 199 m from a vertex with a 200 m margin and grows the area", () => {
    const loc = { kind: "shape" as const, ring: L, contextM: 200 };
    const out = fetchRing(loc);
    expect(isConvex(out)).toBe(true);
    for (const v of L) {
      for (const deg of [0, 45, 90, 137, 180, 225, 270, 315]) {
        const a = (deg * Math.PI) / 180;
        const p: [number, number] = [
          v[0] + (199 * Math.cos(a)) / (M_PER_DEG * Math.cos(v[1] * Math.PI / 180)),
          v[1] + (199 * Math.sin(a)) / M_PER_DEG,
        ];
        expect(pointInRing(p, out)).toBe(true);
      }
    }
    const hullArea = ringAreaKm2(fetchRing({ ...loc, contextM: 0 }));
    expect(fetchKm2(loc)).toBeGreaterThan(hullArea);
    expect(fetchKm2(loc)).toBe(ringAreaKm2(out));
  });
  it("grows a box with a margin", () => {
    const ring = boxRing(HYDE);
    expect(fetchKm2({ kind: "box", ring, contextM: 100 })).toBeGreaterThan(ringAreaKm2(ring));
  });
});

describe("simplifyRing", () => {
  const circle: Ring = Array.from({ length: 400 }, (_, i) => [Math.cos(i / 400 * 2 * Math.PI), Math.sin(i / 400 * 2 * Math.PI)]);
  it("reduces to the vertex limit", () => {
    const out = simplifyRing(circle, 40);
    expect(out.length).toBeGreaterThanOrEqual(3);
    expect(out.length).toBeLessThanOrEqual(40);
  });
  it("leaves a small ring alone and never goes below 3", () => {
    expect(simplifyRing(L, 40)).toEqual(L);
    expect(simplifyRing(circle, 1).length).toBe(3);
  });
});
