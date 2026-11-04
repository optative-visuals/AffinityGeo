// Turns project data into page geometry for one map: project -> rotate -> clip to the frame (plus its bleed) -> millimetres.
import proj4 from "proj4";
import { clipPolygon, clipPolyline } from "lineclip";
import type { ClipBox, ClipPoint } from "lineclip";
import { WGS84 } from "../crs.js";
import { worldToPage } from "../frame.js";
import { buildLayerJob, r2 } from "../job.js";
import { projectDataset } from "../project.js";
import { getProjection } from "../projections.js";
import type { ResolvedProjection } from "../projections.js";
import type { FrameTransform, GeoFeature, Geometry, Position, ProjectedLayer } from "../types.js";
import { TOO_BIG } from "./osm.js";
import { ROLE_IDS, ROLE_LABELS } from "./roles.js";
import { fnv, stable, styleHash } from "./styles.js";
import { dataFor } from "./file.js";
import { ringBbox } from "./location.js";
import type { MapJob, MapLayerJob, LocationSpec, MapSpec, Project, ProjectSnapshot } from "./types.js";

function findMap(project: Project, mapId: string): MapSpec {
  const map = project.maps.find((m) => m.id === mapId);
  if (!map) throw new Error("That map isn't in this project any more.");
  return map;
}

function areaProjection(project: Project): ResolvedProjection {
  return getProjection(project.area.projectionId, project.area.projectionParams ?? {});
}

function findLocation(project: Project, map: MapSpec): LocationSpec {
  const loc = project.locations.find((l) => l.id === map.locationId);
  if (!loc) throw new Error("That map's location isn't in this project any more.");
  return loc;
}

/** A legacy map (a plain box, no margin, no context) keeps the 0.1.x job and hash exactly. */
export function isLegacyMap(project: Project, map: MapSpec): boolean {
  const loc = findLocation(project, map);
  return loc.kind === "box" && loc.contextM === 0 && !map.showContext;
}

/** The hash a sent map is compared against: everything that changes its drawing, nothing about where it was sent. */
export function mapStatusHash(project: Project, mapId: string): string {
  const map = findMap(project, mapId);
  const loc = findLocation(project, map);
  const { sent: _sent, target: _target, locationId: _locationId, showContext, ...spec } = map;
  const base = {
    map: spec, style: styleHash(project.style), dataVersion: loc.dataVersion, sources: project.sources,
    area: {
      placeName: loc.placeName, bboxWgs84: ringBbox(loc.ring), projectionId: project.area.projectionId,
      ...(project.area.projectionParams ? { projectionParams: project.area.projectionParams } : {}),
    },
  };
  return fnv(stable(isLegacyMap(project, map) ? base
    : { ...base, location: { kind: loc.kind, ring: loc.ring, contextM: loc.contextM, showContext } }));
}

type Xf = (p: Position) => Position;

function mapGeometry(g: Geometry, fn: Xf): Geometry {
  switch (g.type) {
    case "Point": return { type: "Point", coordinates: fn(g.coordinates) };
    case "MultiPoint": case "LineString": return { type: g.type, coordinates: g.coordinates.map(fn) };
    case "MultiLineString": case "Polygon": return { type: g.type, coordinates: g.coordinates.map((r) => r.map(fn)) };
    case "MultiPolygon": return { type: "MultiPolygon", coordinates: g.coordinates.map((p) => p.map((r) => r.map(fn))) };
  }
}

const inside = (p: Position, b: ClipBox) => p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3];

function clipPolygonRings(rings: Position[][], box: ClipBox): Position[][] | null {
  const clipped = rings.map((r) => clipPolygon(r as ClipPoint[], box) as Position[]);
  if (clipped[0]!.length < 3) return null; // outer ring gone: the polygon goes with its holes
  return clipped.filter((r, i) => i === 0 || r.length >= 3);
}

function clipLines(lines: Position[][], box: ClipBox): Position[][] {
  const out: Position[][] = [];
  for (const l of lines) if (l.length >= 2) out.push(...(clipPolyline(l as ClipPoint[], box) as Position[][]));
  return out.filter((l) => l.length >= 2);
}

function clipGeometry(g: Geometry, box: ClipBox): Geometry | null {
  switch (g.type) {
    case "Point": return inside(g.coordinates, box) ? g : null;
    case "MultiPoint": {
      const c = g.coordinates.filter((p) => inside(p, box));
      return c.length ? { type: "MultiPoint", coordinates: c } : null;
    }
    case "LineString": case "MultiLineString": {
      const parts = clipLines(g.type === "LineString" ? [g.coordinates] : g.coordinates, box);
      return parts.length ? { type: "MultiLineString", coordinates: parts } : null;
    }
    case "Polygon": {
      const rings = clipPolygonRings(g.coordinates, box);
      return rings ? { type: "Polygon", coordinates: rings } : null;
    }
    case "MultiPolygon": {
      const polys = g.coordinates.map((p) => clipPolygonRings(p, box)).filter((p): p is Position[][] => p !== null);
      return polys.length ? { type: "MultiPolygon", coordinates: polys } : null;
    }
  }
}

/**
 * The bleed margin per side, as a fraction of the frame's own width or height, for a map at 1:scale.
 * Detailed maps (1:500 and closer) get the most (0.20), wide-area maps (1:25,000 and further) the least (0.05),
 * log-interpolated between.
 */
export function bleedFraction(scale: number): number {
  const MAX = 0.2, MIN = 0.05, NEAR = 500, FAR = 25000;
  if (scale <= NEAR) return MAX;
  if (scale >= FAR) return MIN;
  return MAX + (MIN - MAX) * Math.log(scale / NEAR) / Math.log(FAR / NEAR);
}

/**
 * The map's page geometry. With bleed (the default) every data layer and the context are clipped to the frame plus a
 * margin on each side (job.bleedMm), so an artboard enlarged in Affinity already has map under it; coordinates in the
 * margin go negative or past width/height. { bleed: false } gives the frame-only job (previews, the 0.1.x golden).
 */
export function buildMapJob(project: Project, snap: ProjectSnapshot, mapId: string, opts: { bleed?: boolean } = {}): MapJob {
  const map = findMap(project, mapId);
  const data = dataFor(project, snap, map.locationId);
  const proj = areaProjection(project);
  const { width, height } = map.sizeMm;

  // Projected map centre (metres).
  const dst = proj.crs;
  if (!dst) throw new Error(TOO_BIG);
  const [cx, cy] = proj4(WGS84.proj4, dst.proj4, map.centre) as [number, number];

  // rotationDeg is the compass bearing that points up: rotate content counter-clockwise by it.
  const theta = (map.rotationDeg * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const rotate: Xf = ([x, y]) => {
    const dx = x - cx;
    const dy = y - cy;
    return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos];
  };

  const halfW = (width / 1000) * map.scale / 2;
  const halfH = (height / 1000) * map.scale / 2;
  const box: ClipBox = [cx - halfW, cy - halfH, cx + halfW, cy + halfH];
  const t: FrameTransform = { scale: 1000 / map.scale, tx: (-box[0] * 1000) / map.scale, ty: (box[3] * 1000) / map.scale };

  // The clip box: the frame plus the bleed margin (mm on the page -> metres on the ground). The transform stays on
  // the frame, so the frame's top-left is still (0, 0) mm.
  const bleed = opts.bleed !== false;
  const f = bleedFraction(map.scale);
  const bleedMm = bleed ? { x: r2(f * width), y: r2(f * height) } : { x: 0, y: 0 };
  const bx = (bleedMm.x / 1000) * map.scale;
  const by = (bleedMm.y / 1000) * map.scale;
  const clip: ClipBox = [box[0] - bx, box[1] - by, box[2] + bx, box[3] + by];

  // One layer per visible role that has geometry inside the clip box; shared by the main layers and the context.
  const buildLayers = (): MapLayerJob[] => {
    const layers: MapLayerJob[] = [];
    for (const role of ROLE_IDS) {
      const style = project.style.roles[role];
      const ds = data[role];
      if (!style.visible || !ds) continue;
      const projected = projectDataset(ds, proj);
      const features: GeoFeature[] = [];
      for (const feat of projected.features) {
        const geometry = clipGeometry(mapGeometry(feat.geometry, rotate), clip);
        if (geometry) features.push({ ...feat, geometry });
      }
      if (!features.length) continue;
      const layer: ProjectedLayer = { name: projected.name, kind: projected.kind, features, bbox: clip };
      const job = buildLayerJob(role, layer, t, style);
      if (!job.features.length) continue;
      layers.push({ role, name: ROLE_LABELS[role], kind: job.kind, style, features: job.features });
    }
    return layers;
  };
  const layers = buildLayers();

  // The location outline in frame-local mm: projected, rotated and scaled like the features, then trimmed to the
  // drawn area (frame plus bleed) so the mask never runs past what is sent. Outside the location entirely: no mask.
  const extras: Pick<MapJob, "mask" | "context"> = {};
  if (!isLegacyMap(project, map)) {
    const loc = findLocation(project, map);
    const full = loc.ring.map((pt) => worldToPage(t, ...(rotate(proj4(WGS84.proj4, dst.proj4, pt) as Position) as [number, number])));
    const drawn: ClipBox = [-bleedMm.x, -bleedMm.y, width + bleedMm.x, height + bleedMm.y];
    const ring = clipPolygon(full as ClipPoint[], drawn) as Position[];
    const last = ring[ring.length - 1], first = ring[0];
    if (last && first && last[0] === first[0] && last[1] === first[1]) ring.pop();
    if (ring.length >= 3) extras.mask = { ring: ring.map(([x, y]) => [r2(x!), r2(y!)]) };
    if (map.showContext) extras.context = { opacity: 0.5, layers: buildLayers() };
  }

  return {
    mapId: map.id, mapName: map.name, projectId: project.id, sizeMm: { ...map.sizeMm },
    ...(bleed ? { bleedMm } : {}),
    background: { fill: project.style.paper }, layers, ...extras,
    marker: map.marker ? { x: width / 2, y: height / 2, style: project.style.marker } : null,
    hash: mapStatusHash(project, mapId),
  };
}
