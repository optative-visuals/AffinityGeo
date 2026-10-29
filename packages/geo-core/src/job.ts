import { worldToPage } from "./frame.js";
import type {
  FrameTransform, GeometryKind, JobFeature, LayerJob, LayerStyle, Position, ProjectedLayer,
} from "./types.js";

export const DEFAULT_STYLES: Record<GeometryKind, LayerStyle> = {
  polygon: { fill: "#E8E4DC", stroke: "#8C8C8C", strokePt: 0.5, pointRadiusPt: 0 },
  line: { fill: null, stroke: "#4A7FB5", strokePt: 1, pointRadiusPt: 0 },
  point: { fill: "#333333", stroke: null, strokePt: 0, pointRadiusPt: 2 },
};

function r2(v: number): number {
  const r = Math.round(v * 100) / 100;
  return r === 0 ? 0 : r; // normalise -0
}

/** Project positions to rounded page pairs. */
function toPage(t: FrameTransform, ps: Position[]): Position[] {
  return ps.map((p) => {
    const [x, y] = worldToPage(t, p[0], p[1]);
    return [r2(x), r2(y)] as Position;
  });
}

function dedupe(ps: Position[]): Position[] {
  const out: Position[] = [];
  for (const p of ps) {
    const last = out[out.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
  }
  return out;
}

function flat(ps: Position[]): number[] {
  const out: number[] = [];
  for (const p of ps) out.push(p[0], p[1]);
  return out;
}

function path(t: FrameTransform, ps: Position[], min: number, dropClosing: boolean): number[] | null {
  let src = ps;
  if (dropClosing && src.length > 1) {
    const a = src[0]!;
    const b = src[src.length - 1]!;
    if (a[0] === b[0] && a[1] === b[1]) src = src.slice(0, -1);
  }
  const rounded = toPage(t, src);
  const deduped = dedupe(rounded);
  // Collapsed paths keep their pre-dedupe rounded positions rather than vanishing.
  const chosen = deduped.length < min ? rounded : deduped;
  // Too few positions to draw (a ring under 3, a line under 2): drop the path.
  return chosen.length < min ? null : flat(chosen);
}

function featurePaths(t: FrameTransform, g: ProjectedLayer["features"][number]["geometry"]): { paths: number[][]; closed: boolean } {
  const paths: number[][] = [];
  const add = (p: number[] | null) => { if (p) paths.push(p); };
  // A polygon whose outer ring is undrawable is dropped with its holes (holes alone would fill the wrong area).
  const addPolygon = (rings: Position[][]) => {
    const outer = path(t, rings[0] ?? [], 3, true);
    if (!outer) return;
    paths.push(outer);
    for (let i = 1; i < rings.length; i++) add(path(t, rings[i]!, 3, true));
  };
  switch (g.type) {
    case "Point": add(path(t, [g.coordinates], 1, false)); return { paths, closed: false };
    case "MultiPoint": for (const c of g.coordinates) add(path(t, [c], 1, false)); return { paths, closed: false };
    case "LineString": add(path(t, g.coordinates, 2, false)); return { paths, closed: false };
    case "MultiLineString": for (const l of g.coordinates) add(path(t, l, 2, false)); return { paths, closed: false };
    case "Polygon": addPolygon(g.coordinates); return { paths, closed: true };
    case "MultiPolygon": for (const poly of g.coordinates) addPolygon(poly); return { paths, closed: true };
  }
}

export function buildLayerJob(layerId: string, layer: ProjectedLayer, t: FrameTransform, style?: LayerStyle): LayerJob {
  const features: JobFeature[] = [];
  let skipped = 0;
  for (const f of layer.features) {
    const { paths, closed } = featurePaths(t, f.geometry);
    if (paths.length === 0) { skipped++; continue; } // nothing drawable left: skip and count, never an empty object
    features.push({ fid: f.fid, name: f.name, paths, closed });
  }
  return {
    layerId,
    name: layer.name,
    kind: layer.kind,
    style: { ...(style ?? DEFAULT_STYLES[layer.kind]) },
    features,
    skipped,
  };
}
