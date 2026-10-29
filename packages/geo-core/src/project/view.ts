// Browser-safe map view maths for the app window. No node: imports allowed here (the UI bundles this file).
import proj4 from "proj4";
import { WGS84 } from "../crs.js";
import { getProjection } from "../projections.js";
import type { Bbox } from "../types.js";
import type { AreaSpec, MapSpec } from "./types.js";

export { ROLE_IDS, ROLE_LABELS } from "./roles.js";
export { PRESETS, PRESET_PAPER } from "./styles.js";
export { suggestProjection, utmParams } from "../projections.js";
export type { Bbox } from "../types.js";
export type { AreaSpec, MapSpec, ProjectStyle, RoleId } from "./types.js";

export const MAX_KM2 = 25;
export const WARN_KM2 = 3;
export const TOO_BIG = "That area is too big for a street-level map. Choose a smaller area.";
export const LARGE = "This is a large area. Fetching may take a while and maps may be slow to draw.";

/** Equirectangular approximation: width scaled by cos(mid-latitude), 111.32 km per degree. Plenty for a size check. */
export function areaKm2(b: Bbox): number {
  const k = 111.32;
  return Math.abs(b[2] - b[0]) * Math.cos(((b[1] + b[3]) / 2) * Math.PI / 180) * k * Math.abs(b[3] - b[1]) * k;
}

export function areaWarning(bboxWgs84: Bbox): string | null {
  return areaKm2(bboxWgs84) > WARN_KM2 ? LARGE : null;
}

function metricCrs(area: AreaSpec) {
  const crs = getProjection(area.projectionId, area.projectionParams ?? {}).crs;
  if (!crs) throw new Error("This area needs a metric projection.");
  return crs;
}

export function projector(area: AreaSpec): {
  forward(lonLat: [number, number]): [number, number];
  inverse(xy: [number, number]): [number, number];
} {
  const crs = metricCrs(area);
  return {
    forward: (p) => proj4(WGS84.proj4, crs.proj4, p) as [number, number],
    inverse: (p) => proj4(crs.proj4, WGS84.proj4, p) as [number, number],
  };
}

/**
 * The four projected corners of a map frame, top-left, top-right, bottom-right, bottom-left as the map is seen.
 * Matches buildMapJob: content is rotated by +rotationDeg (counter-clockwise) about the centre, then clipped to the
 * axis-aligned box, so the frame in world space is that box rotated by -rotationDeg.
 */
export function mapFrameCorners(
  area: AreaSpec, map: Pick<MapSpec, "centre" | "scale" | "rotationDeg" | "sizeMm">,
): [number, number][] {
  const [cx, cy] = projector(area).forward(map.centre);
  const hw = (map.sizeMm.width / 1000) * map.scale / 2;
  const hh = (map.sizeMm.height / 1000) * map.scale / 2;
  const theta = (map.rotationDeg * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  // Rotation by -theta.
  const at = (dx: number, dy: number): [number, number] => [cx + dx * cos + dy * sin, cy - dx * sin + dy * cos];
  return [at(-hw, hh), at(hw, hh), at(hw, -hh), at(-hw, -hh)];
}

export const SCALE_MIN = 500;
export const SCALE_MAX = 50000;
const NICE = [1, 1.25, 2, 2.5, 5, 10];

export function scaleToSlider(scale: number): number {
  const s = Math.min(SCALE_MAX, Math.max(SCALE_MIN, scale));
  return Math.round((1000 * Math.log(s / SCALE_MIN)) / Math.log(SCALE_MAX / SCALE_MIN));
}

export function sliderToScale(v: number): number {
  const t = Math.min(1000, Math.max(0, v)) / 1000;
  const raw = SCALE_MIN * Math.pow(SCALE_MAX / SCALE_MIN, t);
  const exp = Math.floor(Math.log10(raw));
  const base = 10 ** exp;
  const m = raw / base;
  let best = NICE[0]!;
  for (const n of NICE) if (Math.abs(Math.log(n / m)) < Math.abs(Math.log(best / m))) best = n;
  const out = Math.round(best * base * 100) / 100;
  return Math.min(SCALE_MAX, Math.max(SCALE_MIN, out));
}
