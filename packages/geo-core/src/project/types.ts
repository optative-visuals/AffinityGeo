import type { Bbox, Dataset, GeometryKind, JobFeature } from "../types.js";
import type { Ring } from "./location.js";

export type RoleId = "water" | "green" | "landuse" | "buildings" | "landmarks" | "paths" | "steps"
  | "minorRoads" | "mainRoads" | "rail" | "carParks" | "poi";
export interface RoleStyle { fill: string | null; stroke: string | null; strokePt: number; visible: boolean; order: number; pointRadiusPt: number; }
export interface MarkerStyle { dot: string; ring: string; text: string; textPt: number; label: string; } // label "You are here"
/** paper: the map background ("#rrggbb"), drawn as one rectangle filling the frame under every layer. */
export interface ProjectStyle { presetName: string; paper: string; roles: Record<RoleId, RoleStyle>; marker: MarkerStyle; }
export type RoleSource = { kind: "osm" } | { kind: "file"; path: string; datasetName: string };
export interface AreaSpec { placeName: string; bboxWgs84: Bbox; projectionId: "bng" | "utm"; projectionParams?: Record<string, number>; }
export interface MapTarget { docId: string; docTitle: string; }           // artboard found by its geo:map tag
export interface SentRecord { at: string; hash: string; objectIds: string[]; }
/** One place on the map: a box or a drawn shape, plus a margin of surrounding context. */
export interface LocationSpec {
  id: string; name: string; placeName: string;
  kind: "box" | "shape"; ring: Ring; contextM: number;
  dataVersion: number; fetchedAt: string | null;
}
export interface MapSpec {
  id: string; name: string; centre: [number, number];                   // [lon, lat]
  locationId: string; showContext: boolean;
  scale: number; rotationDeg: number; sizeMm: { width: number; height: number };
  marker: boolean; target: MapTarget | null; resizeArtboard: boolean | null; // null = not asked yet
  sent: SentRecord | null;
}
export interface Project {
  version: 2; id: string; name: string;
  area: AreaSpec;               // the projection, plus placeName/bboxWgs84 kept in step: see syncArea
  locations: LocationSpec[];
  sources: Record<RoleId, RoleSource>; style: ProjectStyle; maps: MapSpec[];
  dataVersion: number;          // bumps whenever any location's data or any source changes (UI cache key)
  fetchedAt: string | null;     // latest of the locations' fetchedAt
}
export type ProjectData = Partial<Record<RoleId, Dataset>>;                 // the snapshot, in each dataset's own CRS
/** OSM snapshots per location id, plus the datasets of file sources (project-wide). */
export interface ProjectSnapshot { locations: Record<string, ProjectData>; files: ProjectData }
export interface MapLayerJob { role: RoleId; name: string; kind: GeometryKind; style: RoleStyle; features: JobFeature[]; } // mm, frame-local
/**
 * background: the paper under the map, drawn by Affinity as a "Background" layer (geo:role "background")
 * holding one rectangle (geo:fid "background:frame") that fills the frame, (0,0)-(width,height) mm, with
 * this fill and no stroke. It is kept apart from `layers` (which only hold the 12 data roles) so layer
 * consumers are unchanged; draw-map.js turns it into one more polygon layer below them all.
 */
export interface MapJob { mapId: string; mapName: string; projectId: string; sizeMm: { width: number; height: number };
  background: { fill: string };
  layers: MapLayerJob[]; marker: { x: number; y: number; style: MarkerStyle } | null; hash: string; }
