import type { CrsInfo, Dataset, GeoFeature, Geometry, GeometryKind } from "../types.js";
import { cleanText, featureId, featureName, layerNameFromPath, pickIdColumn } from "./naming.js";

export interface RawFeature {
  id?: unknown;
  properties?: Record<string, unknown> | null;
  geometry?: { type?: string; coordinates?: unknown } | null;
}

const KIND_OF: Record<string, GeometryKind> = {
  Point: "point", MultiPoint: "point",
  LineString: "line", MultiLineString: "line",
  Polygon: "polygon", MultiPolygon: "polygon",
};
const KIND_LABEL: Record<GeometryKind, string> = { point: "points", line: "lines", polygon: "polygons" };

function hasCoordinates(g: { coordinates?: unknown }): boolean {
  const walk = (c: unknown): boolean =>
    Array.isArray(c) && (typeof c[0] === "number" ? c.length >= 2 : c.some(walk));
  return walk(g.coordinates);
}

function cleanAttrs(props: Record<string, unknown> | null | undefined): GeoFeature["attrs"] {
  const out: GeoFeature["attrs"] = {};
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === null || v === undefined) out[k] = null;
    else if (typeof v === "string") out[k] = cleanText(v);
    else if (typeof v === "boolean") out[k] = v;
    else if (typeof v === "number") out[k] = Number.isFinite(v) ? v : null;
    else if (v instanceof Date) out[k] = v.toISOString();
    else out[k] = JSON.stringify(v);
  }
  return out;
}

/** Drop Z/M: keep only [x, y] in every position. */
function stripToXY(c: unknown): unknown {
  if (!Array.isArray(c)) return c;
  if (typeof c[0] === "number") return [c[0], c[1]];
  return c.map(stripToXY);
}

/** Largest absolute x and y over every coordinate of a feature list. */
export function coordinateExtent(features: RawFeature[]): { maxX: number; maxY: number } {
  let maxX = 0, maxY = 0;
  const walk = (c: unknown): void => {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === "number") {
      maxX = Math.max(maxX, Math.abs(c[0] as number));
      maxY = Math.max(maxY, Math.abs(c[1] as number));
    } else for (const i of c) walk(i);
  };
  for (const f of features) if (f.geometry) walk(f.geometry.coordinates);
  return { maxX, maxY };
}

/** Turn raw GeoJSON-like features into one Dataset per geometry kind. Null/empty geometry is skipped and counted. */
export function buildDatasets(
  raw: RawFeature[],
  opts: { path: string; format: Dataset["sourceFormat"]; crs: CrsInfo },
): Dataset[] {
  const byKind = new Map<GeometryKind, GeoFeature[]>();
  const used = new Set<string>();
  const reasons: string[] = [];
  let skipped = 0;
  const cleaned = raw.map((f) => cleanAttrs(f.properties));
  const idColumn = pickIdColumn(cleaned);
  raw.forEach((f, i) => {
    const g = f.geometry;
    if (!g || !g.type || !hasCoordinates(g)) {
      skipped++;
      reasons.push(`Feature ${i + 1} has no geometry`);
      return;
    }
    const kind = KIND_OF[g.type];
    if (!kind) {
      skipped++;
      reasons.push(`Feature ${i + 1} uses an unsupported geometry type (${g.type})`);
      return;
    }
    const attrs = cleaned[i]!;
    let fid = featureId({ id: f.id, properties: attrs }, i, idColumn);
    if (used.has(fid)) fid = "f" + i;
    used.add(fid);
    const list = byKind.get(kind) ?? [];
    list.push({ fid, name: featureName(attrs, fid), geometry: { type: g.type, coordinates: stripToXY(g.coordinates) } as Geometry, attrs });
    byKind.set(kind, list);
  });

  if (byKind.size === 0) {
    const file = opts.path.split(/[\\/]/).pop();
    throw new Error(`${file} has no features with usable geometry, so there is nothing to draw.`);
  }

  const kinds = [...byKind.keys()].sort((a, b) => byKind.get(b)!.length - byKind.get(a)!.length);
  const base = layerNameFromPath(opts.path);
  return kinds.map((kind, n) => {
    const features = byKind.get(kind)!;
    const own = n === 0 ? skipped : 0; // skipped features are reported against the dominant dataset
    return {
      name: kinds.length > 1 ? `${base} — ${KIND_LABEL[kind]}` : base,
      sourcePath: opts.path,
      sourceFormat: opts.format,
      crs: opts.crs,
      kind,
      features,
      report: { read: features.length + own, skipped: own, reasons: n === 0 ? reasons : [] },
    };
  });
}
