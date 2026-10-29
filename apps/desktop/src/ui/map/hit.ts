// What's under the pointer on the Map view: a map's pin or its rotate handle. Pure maths, no drawing.
import { toScreen, type View, type XY } from "./viewport.js";

/** How close (screen px) the pointer must be to a pin or handle to grab it. */
export const PIN_HIT_PX = 8;
export const HANDLE_HIT_PX = 8;

export type Corners = readonly (readonly [number, number])[];
export type CornersById = Readonly<Record<string, Corners | undefined>>;

/** Where a map's pin sits: the frame centre (the map's centre), in world metres. */
export function pinPoint(corners: Corners): XY {
  let x = 0, y = 0;
  for (const c of corners) { x += c[0]; y += c[1]; }
  return [x / corners.length, y / corners.length];
}

/** Nearest target within `radius` px; later maps are drawn on top, so they win a tie. */
function nearest(
  maps: readonly { id: string }[], view: View, w: number, h: number, p: readonly [number, number], radius: number,
  pointOf: (id: string) => readonly [number, number] | null,
): string | null {
  let best: string | null = null;
  let bestD = radius;
  for (let i = maps.length - 1; i >= 0; i--) {
    const id = maps[i]!.id;
    const world = pointOf(id);
    if (!world) continue;
    const [sx, sy] = toScreen(view, w, h, world);
    const d = Math.hypot(sx - p[0], sy - p[1]);
    if (d < bestD || (d <= radius && best === null)) { best = id; bestD = d; }
  }
  return best;
}

/** The id of the map whose pin is under [px, py] (within 8 px; nearest first, topmost on a tie), or null. */
export function hitPin(
  maps: readonly { id: string }[], corners: CornersById, view: View, w: number, h: number, p: readonly [number, number],
): string | null {
  return nearest(maps, view, w, h, p, PIN_HIT_PX, (id) => {
    const c = corners[id];
    return c && c.length ? pinPoint(c) : null;
  });
}

/**
 * The id of the map whose rotate handle (its frame's top-right corner, as the map is seen) is under [px, py],
 * within 8 px. Pass `onlyIds` to consider just those maps (the handle shows on selected maps only).
 */
export function hitRotateHandle(
  maps: readonly { id: string }[], corners: CornersById, view: View, w: number, h: number, p: readonly [number, number],
  onlyIds?: readonly string[],
): string | null {
  const allowed = onlyIds ? new Set(onlyIds) : null;
  return nearest(maps, view, w, h, p, HANDLE_HIT_PX, (id) => {
    if (allowed && !allowed.has(id)) return null;
    return corners[id]?.[1] ?? null;
  });
}

/**
 * The compass bearing (degrees, 0–360, clockwise from north) from `centre` towards `point`, both in world metres.
 * This is the meaning of rotationDeg: the bearing that points up on the map (0 = north up, 90 = east up).
 */
export function bearingFrom(centre: readonly [number, number], point: readonly [number, number]): number {
  const deg = (Math.atan2(point[0] - centre[0], point[1] - centre[1]) * 180) / Math.PI;
  return deg < 0 ? deg + 360 : deg;
}

/** Rounds a rotation to whole degrees, or to 15° steps (with Shift), and keeps it in −180 < r ≤ 180. */
export function snapRotation(deg: number, coarse: boolean): number {
  const step = coarse ? 15 : 1;
  let r = Math.round(deg / step) * step;
  r = ((r % 360) + 360) % 360;
  if (r > 180) r -= 360;
  return r === 0 ? 0 : r; // no −0
}
