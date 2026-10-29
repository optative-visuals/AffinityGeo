import { topology } from "topojson-server";
import { presimplify, simplify, planarTriangleArea } from "topojson-simplify";
import { feature } from "topojson-client";
import type { Bbox, GeoFeature, Geometry, Position, ProjectedLayer } from "./types.js";

// Counts every position in every geometry, including the repeated closing position of each ring.
export function countNodes(features: GeoFeature[]): number {
  let n = 0;
  const walk = (c: unknown): void => {
    if (typeof (c as unknown[])[0] === "number") n++;
    else for (const x of c as unknown[]) walk(x);
  };
  for (const f of features) walk(f.geometry.coordinates);
  return n;
}

function computeBbox(features: GeoFeature[]): Bbox {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const walk = (c: unknown): void => {
    if (typeof (c as unknown[])[0] === "number") {
      const [x, y] = c as Position;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    } else for (const x of c as unknown[]) walk(x);
  };
  for (const f of features) walk(f.geometry.coordinates);
  return minX <= maxX ? [minX, minY, maxX, maxY] : [0, 0, 0, 0];
}

const isPoint = (g: Geometry) => g.type === "Point" || g.type === "MultiPoint";

const distinct = (r: Position[]) => new Set(r.map((p) => p[0] + "," + p[1])).size;

// topojson-client pads collapsed rings to 4 positions, so check structure: 3+ distinct vertices and real area.
function ringOk(r: Position[]): boolean {
  if (r.length < 4 || distinct(r) < 3) return false;
  let a = 0, minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < r.length; i++) {
    const [x1, y1] = r[i], [x2, y2] = r[(i + 1) % r.length];
    a += x1 * y2 - x2 * y1;
    minX = Math.min(minX, x1); maxX = Math.max(maxX, x1); minY = Math.min(minY, y1); maxY = Math.max(maxY, y1);
  }
  return Math.abs(a / 2) > 1e-9 * Math.max((maxX - minX) * (maxY - minY), Number.MIN_VALUE);
}

/** Replace any ring/line that collapsed (see ringOk; lines need 2 distinct positions) with the original. */
function applyFloors(orig: Geometry, out: Geometry | null): Geometry {
  if (!out || out.type !== orig.type) return orig;
  const fix = (o: Position[], s: Position[] | undefined, min: number) =>
    s && (min === 2 ? s.length >= 2 && distinct(s) >= 2 : ringOk(s)) ? s : o;
  switch (orig.type) {
    case "LineString":
      return { type: "LineString", coordinates: fix(orig.coordinates, (out as typeof orig).coordinates, 2) };
    case "MultiLineString":
      return { type: "MultiLineString", coordinates: orig.coordinates.map((l, i) => fix(l, (out as typeof orig).coordinates[i], 2)) };
    case "Polygon":
      return { type: "Polygon", coordinates: orig.coordinates.map((r, i) => fix(r, (out as typeof orig).coordinates[i], 4)) };
    case "MultiPolygon":
      return {
        type: "MultiPolygon",
        coordinates: orig.coordinates.map((p, pi) => p.map((r, ri) => fix(r, (out as typeof orig).coordinates[pi]?.[ri], 4))),
      };
    default:
      return orig;
  }
}

export function simplifyLayer(layer: ProjectedLayer, detail: number): { layer: ProjectedLayer; nodesBefore: number; nodesAfter: number } {
  const d = Math.min(100, Math.max(0, Number.isFinite(detail) ? detail : 100));
  if (d >= 100) { const n = countNodes(layer.features); return { layer, nodesBefore: n, nodesAfter: n }; }
  const share = (d / 100) ** 2;
  return simplifyWith(layer, (weights) => {
    const idx = Math.floor((1 - share) * weights.length);
    return idx >= weights.length ? Infinity : weights[idx];
  });
}

/**
 * Simplifies to a distance in the layer's own units (metres for a projected layer): a vertex goes when the
 * triangle it makes with its neighbours is smaller than tolerance squared. Used for the app's area preview.
 */
export function simplifyLayerToTolerance(layer: ProjectedLayer, tolerance: number): { layer: ProjectedLayer; nodesBefore: number; nodesAfter: number } {
  const t = Number.isFinite(tolerance) && tolerance > 0 ? tolerance : 0;
  if (t === 0) { const n = countNodes(layer.features); return { layer, nodesBefore: n, nodesAfter: n }; }
  return simplifyWith(layer, () => t * t);
}

function simplifyWith(layer: ProjectedLayer, minWeightOf: (sortedWeights: number[]) => number): { layer: ProjectedLayer; nodesBefore: number; nodesAfter: number } {
  const nodesBefore = countNodes(layer.features);
  const gj = {
    type: "FeatureCollection",
    features: layer.features.map((f, i) => ({ type: "Feature", id: i, properties: {}, geometry: f.geometry })),
  };
  // Planar topology on projected units; no quantisation, so surviving coordinates are exact.
  const topo = presimplify(topology({ layer: gj as never }) as never, planarTriangleArea);

  const weights: number[] = [];
  for (const arc of topo.arcs) for (const p of arc) if (Number.isFinite(p[2])) weights.push(p[2]);
  weights.sort((a, b) => a - b);
  const simplified = simplify(topo, minWeightOf(weights));

  const fc = feature(simplified, simplified.objects.layer as never) as unknown as {
    features: { id: number; geometry: Geometry | null }[];
  };
  const byId = new Map(fc.features.map((f) => [f.id, f.geometry]));

  const features: GeoFeature[] = layer.features.map((f, i) => {
    if (isPoint(f.geometry)) return f;
    return { ...f, geometry: applyFloors(f.geometry, byId.get(i) ?? null) };
  });
  return { layer: { ...layer, features, bbox: computeBbox(features) }, nodesBefore, nodesAfter: countNodes(features) };
}
