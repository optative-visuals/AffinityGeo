// Browser-safe geometry for project locations (box or shape). No node: imports allowed here (the UI bundles this file).
import type { Bbox } from "../types.js";

/** WGS84 [lon, lat], open (the last vertex is not repeated), at least 3 vertices. */
export type Ring = [number, number][];

export const CONTEXT_MAX_M = 1000;
export const CONTEXT_STEP_M = 50;
export const CONTEXT_DEFAULT_M = 200;
export const RING_MAX_VERTICES = 60;
export const OUTLINE_MAX_VERTICES = 40;

const KM_PER_DEG = 111.32;
const M_PER_DEG = KM_PER_DEG * 1000;
const RAD = Math.PI / 180;
const CIRCLE_POINTS = 8;
// The 8 points sit on a circle slightly wider than the margin, so the octagon they form fully contains the margin circle.
const CIRCLE_REACH = 1 / Math.cos(Math.PI / CIRCLE_POINTS);

export function boxRing(b: Bbox): Ring {
  return [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]];
}

export function ringBbox(r: Ring): Bbox {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const [x, y] of r) {
    if (x < w) w = x;
    if (x > e) e = x;
    if (y < s) s = y;
    if (y > n) n = y;
  }
  return [w, s, e, n];
}

/** Shoelace on the same equirectangular approximation as areaKm2, using the ring's mid-latitude. */
export function ringAreaKm2(r: Ring): number {
  const b = ringBbox(r);
  const kx = Math.cos(((b[1] + b[3]) / 2) * RAD) * KM_PER_DEG;
  let sum = 0;
  for (let i = 0; i < r.length; i++) {
    const [x1, y1] = r[i]!;
    const [x2, y2] = r[(i + 1) % r.length]!;
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2 * kx * KM_PER_DEG;
}

type P = [number, number];

function cross(o: P, a: P, b: P): number {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

function onSegment(a: P, b: P, p: P): boolean {
  return Math.min(a[0], b[0]) <= p[0] && p[0] <= Math.max(a[0], b[0])
    && Math.min(a[1], b[1]) <= p[1] && p[1] <= Math.max(a[1], b[1]);
}

/** True when segments ab and cd cross or touch. */
function segmentsMeet(a: P, b: P, c: P, d: P): boolean {
  const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  return (d1 === 0 && onSegment(c, d, a)) || (d2 === 0 && onSegment(c, d, b))
    || (d3 === 0 && onSegment(a, b, c)) || (d4 === 0 && onSegment(a, b, d));
}

export function validateRing(r: Ring): string | null {
  if (r.length < 3) return "A shape needs at least 3 corners.";
  if (r.length > RING_MAX_VERTICES) return `A shape can have at most ${RING_MAX_VERTICES} corners.`;
  const n = r.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      // Edges that share a corner are neighbours; they are allowed to meet there.
      if (j === i + 1 || (i === 0 && j === n - 1)) continue;
      if (segmentsMeet(r[i]!, r[(i + 1) % n]!, r[j]!, r[(j + 1) % n]!)) {
        return "The shape's edges cross. Move a corner so the outline doesn't cross itself.";
      }
    }
  }
  return null;
}

/** Even-odd point-in-polygon. */
export function pointInRing(p: [number, number], r: Ring): boolean {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i]!;
    const [xj, yj] = r[j]!;
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Andrew's monotone chain. Returns the hull counter-clockwise, open. */
function convexHull(points: P[]): P[] {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const lower: P[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: P[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

/**
 * The area to fetch from OpenStreetMap: the shape's convex hull, grown by contextM metres.
 * A box with no margin is fetched as drawn.
 */
export function fetchRing(loc: { kind: "box" | "shape"; ring: Ring; contextM: number }): Ring {
  if (loc.kind === "box" && loc.contextM === 0) return loc.ring;
  const ring = loc.ring;
  // Local metres around the centroid (equirectangular).
  const cx = ring.reduce((s, p) => s + p[0], 0) / ring.length;
  const cy = ring.reduce((s, p) => s + p[1], 0) / ring.length;
  const kx = Math.cos(cy * RAD) * M_PER_DEG;
  const pts: P[] = [];
  for (const [lon, lat] of ring) {
    const x = (lon - cx) * kx, y = (lat - cy) * M_PER_DEG;
    pts.push([x, y]);
    if (loc.contextM > 0) {
      for (let k = 0; k < CIRCLE_POINTS; k++) {
        const a = (k / CIRCLE_POINTS) * 2 * Math.PI;
        pts.push([x + loc.contextM * CIRCLE_REACH * Math.cos(a), y + loc.contextM * CIRCLE_REACH * Math.sin(a)]);
      }
    }
  }
  return convexHull(pts).map(([x, y]) => [cx + x / kx, cy + y / M_PER_DEG] as P);
}

export function fetchKm2(loc: { kind: "box" | "shape"; ring: Ring; contextM: number }): number {
  return ringAreaKm2(fetchRing(loc));
}

/**
 * Douglas-Peucker on a closed ring, reduced to at most maxVertices (never fewer than 3).
 * Running Douglas-Peucker with ever larger tolerances keeps exactly the vertices with the largest
 * "importance" (the distance at which each one is split off), so this ranks vertices once and keeps the top ones.
 */
export function simplifyRing(r: Ring, maxVertices: number): Ring {
  const keep = Math.max(3, maxVertices);
  const n = r.length;
  if (n <= keep) return r;
  const kx = Math.cos(((ringBbox(r)[1] + ringBbox(r)[3]) / 2) * RAD);
  const pts: P[] = r.map(([x, y]) => [x * kx, y]);
  const dist = (i: number, a: number, b: number): number => {
    const [ax, ay] = pts[a]!, [bx, by] = pts[b]!, [px, py] = pts[i]!;
    const dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy);
    return len === 0 ? Math.hypot(px - ax, py - ay) : Math.abs(dx * (py - ay) - dy * (px - ax)) / len;
  };
  // Anchors: vertex 0 and the vertex farthest from it.
  let far = 1;
  for (let i = 2; i < n; i++) if (dist(i, 0, 0) > dist(far, 0, 0)) far = i;
  const importance = new Array<number>(n).fill(0);
  importance[0] = importance[far] = Infinity;
  // Each span is an inclusive index range a..b along the ring (indices modulo n).
  const stack: [number, number][] = [[0, far], [far, n]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let best = -1, bestD = -1;
    for (let i = a + 1; i < b; i++) {
      const d = dist(i % n, a % n, b % n);
      if (d > bestD) { bestD = d; best = i; }
    }
    if (best < 0) continue;
    importance[best % n] = bestD;
    stack.push([a, best], [best, b]);
  }
  const chosen = new Set(
    importance.map((v, i) => [v, i] as const).sort((x, y) => y[0] - x[0] || x[1] - y[1]).slice(0, keep).map(([, i]) => i),
  );
  return r.filter((_, i) => chosen.has(i));
}
