// Turns project data into page geometry for one map: project -> rotate -> clip to the frame -> millimetres.
import proj4 from "proj4";
import { clipPolygon, clipPolyline } from "lineclip";
import type { ClipBox, ClipPoint } from "lineclip";
import { WGS84 } from "../crs.js";
import { buildLayerJob } from "../job.js";
import { projectDataset } from "../project.js";
import { getProjection } from "../projections.js";
import type { ResolvedProjection } from "../projections.js";
import type { FrameTransform, GeoFeature, Geometry, Position, ProjectedLayer } from "../types.js";
import { TOO_BIG } from "./osm.js";
import { ROLE_IDS, ROLE_LABELS } from "./roles.js";
import { fnv, stable, styleHash } from "./styles.js";
import type { MapJob, MapLayerJob, MapSpec, Project, ProjectData } from "./types.js";

function findMap(project: Project, mapId: string): MapSpec {
  const map = project.maps.find((m) => m.id === mapId);
  if (!map) throw new Error("That map isn't in this project any more.");
  return map;
}

function areaProjection(project: Project): ResolvedProjection {
  return getProjection(project.area.projectionId, project.area.projectionParams ?? {});
}

/** The hash a sent map is compared against: everything that changes its drawing, nothing about where it was sent. */
export function mapStatusHash(project: Project, mapId: string): string {
  const { sent: _sent, target: _target, ...spec } = findMap(project, mapId);
  return fnv(stable({
    map: spec, style: styleHash(project.style), dataVersion: project.dataVersion,
    sources: project.sources, area: project.area,
  }));
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

export function buildMapJob(project: Project, data: ProjectData, mapId: string): MapJob {
  const map = findMap(project, mapId);
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

  const layers: MapLayerJob[] = [];
  for (const role of ROLE_IDS) {
    const style = project.style.roles[role];
    const ds = data[role];
    if (!style.visible || !ds) continue;
    const projected = projectDataset(ds, proj);
    const features: GeoFeature[] = [];
    for (const f of projected.features) {
      const geometry = clipGeometry(mapGeometry(f.geometry, rotate), box);
      if (geometry) features.push({ ...f, geometry });
    }
    if (!features.length) continue;
    const layer: ProjectedLayer = { name: projected.name, kind: projected.kind, features, bbox: box };
    const job = buildLayerJob(role, layer, t, style);
    if (!job.features.length) continue;
    layers.push({ role, name: ROLE_LABELS[role], kind: job.kind, style, features: job.features });
  }

  return {
    mapId: map.id, mapName: map.name, projectId: project.id, sizeMm: { ...map.sizeMm },
    background: { fill: project.style.paper }, layers,
    marker: map.marker ? { x: width / 2, y: height / 2, style: project.style.marker } : null,
    hash: mapStatusHash(project, mapId),
  };
}
