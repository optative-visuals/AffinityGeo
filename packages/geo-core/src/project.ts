import proj4 from "proj4";
import { geoArea } from "d3-geo";
import { geoProject } from "d3-geo-projection";
import { WGS84 } from "./crs.js";
import type { ResolvedProjection } from "./projections.js";
import type { Bbox, Dataset, GeoFeature, Geometry, Position, ProjectedLayer } from "./types.js";

const MERCATOR_MAX_LAT = 85.0511;

function mapPositions(g: Geometry, fn: (p: Position) => Position): Geometry {
  switch (g.type) {
    case "Point":
      return { type: "Point", coordinates: fn(g.coordinates) };
    case "MultiPoint":
    case "LineString":
      return { type: g.type, coordinates: g.coordinates.map(fn) };
    case "MultiLineString":
    case "Polygon":
      return { type: g.type, coordinates: g.coordinates.map((r) => r.map(fn)) };
    case "MultiPolygon":
      return { type: "MultiPolygon", coordinates: g.coordinates.map((p) => p.map((r) => r.map(fn))) };
  }
}

/**
 * d3 uses spherical winding: a small polygon must wind the way d3 expects, otherwise it means
 * "the whole globe minus the polygon". Rewind outer rings to the small side and holes to the
 * opposite, using spherical area so rings crossing the antimeridian work. Returns a copy.
 */
function rewindForD3(g: Geometry): Geometry {
  const fix = (rings: Position[][]): Position[][] =>
    rings.map((ring, i) => {
      const area = geoArea({ type: "Polygon", coordinates: [ring] });
      const insideOut = area > 2 * Math.PI;
      return insideOut === (i > 0) ? ring : [...ring].reverse();
    });
  if (g.type === "Polygon") return { type: "Polygon", coordinates: fix(g.coordinates) };
  if (g.type === "MultiPolygon") return { type: "MultiPolygon", coordinates: g.coordinates.map(fix) };
  return g;
}

function eachPosition(g: Geometry, fn: (p: Position) => void): void {
  mapPositions(g, (p) => {
    fn(p);
    return p;
  });
}

export function projectDataset(ds: Dataset, proj: ResolvedProjection): ProjectedLayer {
  const out: GeoFeature[] = [];

  if (proj.def.kind === "proj4") {
    const dst = proj.crs!;
    const same = ds.crs.id === dst.id;
    const conv = same ? null : proj4(ds.crs.proj4, dst.proj4);
    for (const f of ds.features) {
      // Same CRS: pass coordinates through untouched, never via WGS84.
      const geometry = same
        ? f.geometry
        : mapPositions(f.geometry, (p) => {
            const [x, y] = conv!.forward(p);
            return [x, y];
          });
      out.push({ ...f, geometry });
    }
  } else {
    const d3 = proj.d3!;
    const conv = ds.crs.id === WGS84.id ? null : proj4(ds.crs.proj4, WGS84.proj4);
    const mercator = proj.def.id === "web-mercator";
    for (const f of ds.features) {
      const wgs = mapPositions(f.geometry, (p) => {
        const [lon, lat] = conv ? conv.forward(p) : p;
        return [lon, mercator ? Math.max(-MERCATOR_MAX_LAT, Math.min(MERCATOR_MAX_LAT, lat)) : lat];
      });
      // d3 cuts at the antimeridian and clips; features that vanish come back null.
      const projected = geoProject({ type: "Feature", properties: {}, geometry: rewindForD3(wgs) }, d3) as {
        geometry: Geometry | null;
      } | null;
      const pg = projected?.geometry;
      if (!pg) continue;
      let valid = true;
      const flipped = mapPositions(pg, (p) => {
        if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) valid = false;
        return [p[0], -p[1]];
      });
      if (!valid) continue;
      out.push({ ...f, geometry: flipped });
    }
  }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const f of out) {
    eachPosition(f.geometry, ([x, y]) => {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    });
  }
  const bbox: Bbox = out.length ? [minX, minY, maxX, maxY] : [0, 0, 0, 0];
  return { name: ds.name, kind: ds.kind, features: out, bbox };
}

/** The dataset's bounding box in lon/lat, sampling at most 10,000 positions for speed. */
export function datasetBboxWgs84(ds: Dataset): Bbox {
  let total = 0;
  for (const f of ds.features) eachPosition(f.geometry, () => { total++; });
  const step = Math.max(1, Math.ceil(total / 10_000));
  const conv = ds.crs.id === WGS84.id ? null : proj4(ds.crs.proj4, WGS84.proj4);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let i = 0;
  for (const f of ds.features) {
    eachPosition(f.geometry, (p) => {
      if (i++ % step !== 0) return;
      const [x, y] = conv ? conv.forward(p) : p;
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    });
  }
  return minX === Infinity ? [0, 0, 0, 0] : [minX, minY, maxX, maxY];
}
