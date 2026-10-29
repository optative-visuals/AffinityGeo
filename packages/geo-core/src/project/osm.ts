// Ported from CavalryGeo (GPL-3.0-or-later), src/core/osm.js and src/core/geometry.js:
// the Overpass bbox format, `out geom` queries, and multipolygon ring joining/orientation.
import { WGS84 } from "../crs.js";
import { cleanText, featureName } from "../read/naming.js";
import type { Bbox, Dataset, GeoFeature, Geometry, GeometryKind, Position } from "../types.js";
import { ROLE_IDS, ROLE_LABELS, roleForOsmTags } from "./roles.js";
import type { RoleId } from "./types.js";
import { MAX_KM2, TOO_BIG, areaKm2, areaWarning } from "./view.js";

export class DataError extends Error {
  constructor(message: string) { super(message); this.name = "DataError"; }
}

export const USER_AGENT = "AffinityGeo/0.1.0 (+https://github.com/optative-visuals)";
const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const BUSY = "OpenStreetMap is busy right now. Try again in a minute — your current data is unchanged.";
export { TOO_BIG, areaWarning };

// ---- query ----

export function buildOverpassQuery(bboxWgs84: Bbox): string {
  const [w, s, e, n] = bboxWgs84;
  const bb = `(${[s, w, n, e].map((v) => v.toFixed(6)).join(",")})`;
  const both = (sel: string) => [`way${sel}`, `relation${sel}`];
  const sels = [
    'way["highway"]',
    ...both('["building"]'), 'way["building:part"]',
    ...both('["amenity"="parking"]'),
    ...both('["natural"="water"]'), 'way["waterway"="riverbank"]', ...both('["water"]'),
    ...both('["leisure"~"^(park|garden|pitch)$"]'),
    ...both('["landuse"]'), ...both('["natural"="wood"]'),
    'way["railway"~"^(rail|light_rail|subway|tram|narrow_gauge)$"]',
    ...["amenity", "tourism", "shop", "entrance", "public_transport"].flatMap((k) => [`node["${k}"]`, `way["${k}"]`]),
    'node["highway"="bus_stop"]',
  ];
  return `[out:json][timeout:90];(${sels.map((x) => x + bb + ";").join("")});out geom;`;
}

// ---- geometry helpers ----

type Ring = Position[];
const same = (a: Position, b: Position) => Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
const isClosed = (r: Ring) => r.length > 2 && same(r[0], r[r.length - 1]);

function signedArea(r: Ring): number {
  let a = 0;
  for (let i = 0; i < r.length - 1; i++) a += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1];
  return a / 2;
}
function orient(r: Ring, ccw: boolean): Ring { return (signedArea(r) > 0) === ccw ? r : r.slice().reverse(); }

/** Joins open way fragments (multipolygon members) into closed rings. */
function joinRings(segments: Ring[]): Ring[] {
  const pool = segments.filter((s) => s.length > 1).map((s) => s.slice());
  const rings: Ring[] = [];
  while (pool.length) {
    let ring = pool.shift()!;
    while (!isClosed(ring)) {
      const end = ring[ring.length - 1];
      let found = -1, reverse = false;
      for (let i = 0; i < pool.length; i++) {
        if (same(pool[i][0], end)) { found = i; break; }
        if (same(pool[i][pool[i].length - 1], end)) { found = i; reverse = true; break; }
      }
      if (found < 0) break;
      const seg = pool.splice(found, 1)[0];
      if (reverse) seg.reverse();
      ring = ring.concat(seg.slice(1));
    }
    if (isClosed(ring) && ring.length >= 4) rings.push(ring);
  }
  return rings;
}

function inRing(p: Position, r: Ring): boolean {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function centroid(r: Ring): Position {
  const a = signedArea(r);
  if (Math.abs(a) < 1e-18) {
    const pts = r.slice(0, -1);
    return [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
  }
  let cx = 0, cy = 0;
  for (let i = 0; i < r.length - 1; i++) {
    const f = r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1];
    cx += (r[i][0] + r[i + 1][0]) * f; cy += (r[i][1] + r[i + 1][1]) * f;
  }
  return [cx / (6 * a), cy / (6 * a)];
}

// ---- parsing ----

interface OsmGeomPt { lat: number; lon: number }
interface OsmElement {
  type?: string; id?: number; tags?: Record<string, unknown>; lat?: number; lon?: number;
  geometry?: OsmGeomPt[]; members?: Array<{ type?: string; role?: string; geometry?: OsmGeomPt[] }>;
}
const toRing = (g: OsmGeomPt[]): Ring => g.map((p) => [p.lon, p.lat] as Position);
const LINE_ROLES = new Set<RoleId>(["rail", "mainRoads", "minorRoads", "paths", "steps"]);

function stringTags(t: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(t ?? {})) if (typeof v === "string") out[k] = v;
  return out;
}

function shapeOf(el: OsmElement, tags: Record<string, string>): { kind: GeometryKind; geometry: Geometry } | null {
  if (el.type === "node") {
    return typeof el.lat === "number" && typeof el.lon === "number"
      ? { kind: "point", geometry: { type: "Point", coordinates: [el.lon, el.lat] } } : null;
  }
  if (el.type === "way" && Array.isArray(el.geometry)) {
    const ring = toRing(el.geometry);
    if (ring.length < 2) return null;
    // Roads, paths, rail and waterways stay lines even when they loop back on themselves.
    const lineLike = Boolean(tags.highway || tags.railway || (tags.waterway && tags.waterway !== "riverbank"));
    if (!lineLike && isClosed(ring) && ring.length >= 4) {
      return { kind: "polygon", geometry: { type: "Polygon", coordinates: [orient(ring, true)] } };
    }
    return { kind: "line", geometry: { type: "LineString", coordinates: ring } };
  }
  if (el.type === "relation" && Array.isArray(el.members)) {
    const outer: Ring[] = [], inner: Ring[] = [];
    for (const m of el.members) if (m.type === "way" && Array.isArray(m.geometry)) (m.role === "inner" ? inner : outer).push(toRing(m.geometry));
    const outers = joinRings(outer).map((r) => orient(r, true));
    if (!outers.length) return null;
    const polys: Position[][][] = outers.map((o) => [o]);
    for (const hole of joinRings(inner).map((r) => orient(r, false))) {
      const owner = outers.findIndex((o) => inRing(hole[0], o));
      if (owner >= 0) polys[owner].push(hole);
    }
    return { kind: "polygon", geometry: { type: "MultiPolygon", coordinates: polys } };
  }
  return null;
}

function firstRing(g: Geometry): Ring | null {
  if (g.type === "Polygon") return g.coordinates[0];
  if (g.type === "MultiPolygon") return g.coordinates[0][0];
  return null;
}

// eslint-disable-next-line no-control-regex
const stripControls = (s: string) => cleanText(s.replace(/[\u0000-\u001f\u007f]/g, " ")).replace(/ {2,}/g, " ");

export function parseOverpass(json: unknown): Partial<Record<RoleId, Dataset>> {
  const elements = (json as { elements?: unknown } | null)?.elements;
  if (!Array.isArray(elements)) return {};
  const feats: Partial<Record<RoleId, GeoFeature[]>> = {};
  const skipped: Partial<Record<RoleId, number>> = {};
  const seen = new Set<string>();
  for (const el of elements as OsmElement[]) {
    if (!el || typeof el.id !== "number" || typeof el.type !== "string") continue;
    const key = `${el.type}-${el.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const tags = stringTags(el.tags);
    const shape = shapeOf(el, tags);
    // Judge the role by the feature's natural shape; a node is a point, an open way a line.
    const role = roleForOsmTags(tags, shape?.kind ?? (el.type === "node" ? "point" : el.type === "way" ? "line" : "polygon"));
    if (!role) continue;
    let out: Geometry | null = null;
    if (shape) {
      if (role === "poi") {
        if (shape.kind === "point") out = shape.geometry;
        else if (shape.kind === "polygon") { const r = firstRing(shape.geometry); out = r ? { type: "Point", coordinates: centroid(r) } : null; }
      } else if (LINE_ROLES.has(role)) {
        if (shape.kind === "line") out = shape.geometry;
        else if (shape.kind === "polygon") { const r = firstRing(shape.geometry); out = r ? { type: "LineString", coordinates: r } : null; }
      } else if (shape.kind === "polygon") {
        out = shape.geometry;
      }
    }
    if (!out) { skipped[role] = (skipped[role] ?? 0) + 1; continue; }
    const name = stripControls(featureName(tags, ""));
    (feats[role] ??= []).push({ fid: `osm-${key}`, name, geometry: out, attrs: tags });
  }
  const result: Partial<Record<RoleId, Dataset>> = {};
  for (const role of ROLE_IDS) {
    const features = feats[role];
    if (!features?.length) continue;
    const n = skipped[role] ?? 0;
    result[role] = {
      name: ROLE_LABELS[role], sourcePath: "OpenStreetMap", sourceFormat: "osm", crs: WGS84,
      kind: role === "poi" ? "point" : LINE_ROLES.has(role) ? "line" : "polygon",
      features,
      report: { read: features.length, skipped: n, reasons: n ? [`${n} had no usable shape`] : [] },
    };
  }
  return result;
}

// ---- fetch ----

export async function fetchOsm(bboxWgs84: Bbox, fetchImpl: typeof fetch = fetch): Promise<Partial<Record<RoleId, Dataset>>> {
  if (areaKm2(bboxWgs84) > MAX_KM2) throw new DataError(TOO_BIG);
  let res: Response;
  try {
    // One request per refresh, no automatic retry: the public server asks us to go easy.
    res = await fetchImpl(OVERPASS_URL, {
      method: "POST",
      headers: { "User-Agent": USER_AGENT, "Content-Type": "application/x-www-form-urlencoded" },
      body: "data=" + encodeURIComponent(buildOverpassQuery(bboxWgs84)),
    });
  } catch { throw new DataError(BUSY); }
  if (!res.ok) throw new DataError(BUSY);
  let json: unknown;
  try { json = await res.json(); } catch { throw new DataError(BUSY); }
  // Overpass can answer 200 with a remark and a truncated result when it runs out of time or memory.
  const remark = (json as { remark?: unknown } | null)?.remark;
  if (typeof remark === "string" && /runtime error|timed out/i.test(remark)) throw new DataError(BUSY);
  return parseOverpass(json);
}
