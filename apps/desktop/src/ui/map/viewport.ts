// The Map view's camera: a centre in projected metres and a zoom in metres per screen pixel.
// World y points up (north), screen y points down: this file is the only place that flips it.

export interface View { cx: number; cy: number; mPerPx: number }
export type XY = [number, number];

export const MIN_M_PER_PX = 0.05;
export const MAX_M_PER_PX = 50;
/** Space left on each side when fitting, as a share of the canvas. */
export const FIT_MARGIN = 0.05;

const clampZoom = (m: number) => Math.min(MAX_M_PER_PX, Math.max(MIN_M_PER_PX, m));

/** A view that shows the whole of `bounds` [minX, minY, maxX, maxY], centred, with a 5 % margin on each side. */
export function fit(bounds: readonly [number, number, number, number], w: number, h: number): View {
  const [minX, minY, maxX, maxY] = bounds;
  const usable = 1 - 2 * FIT_MARGIN;
  const mx = (maxX - minX) / Math.max(1, w * usable);
  const my = (maxY - minY) / Math.max(1, h * usable);
  return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, mPerPx: clampZoom(Math.max(mx, my)) };
}

export function toScreen(v: View, w: number, h: number, [x, y]: readonly [number, number]): XY {
  return [w / 2 + (x - v.cx) / v.mPerPx, h / 2 - (y - v.cy) / v.mPerPx];
}

export function toWorld(v: View, w: number, h: number, [px, py]: readonly [number, number]): XY {
  return [v.cx + (px - w / 2) * v.mPerPx, v.cy - (py - h / 2) * v.mPerPx];
}

/** Zooms in by `factor` (2 = twice as close) about the screen point [px, py], which stays where it is. */
export function zoomAt(v: View, w: number, h: number, p: readonly [number, number], factor: number): View {
  const [wx, wy] = toWorld(v, w, h, p);
  const mPerPx = clampZoom(v.mPerPx / factor);
  return { cx: wx - (p[0] - w / 2) * mPerPx, cy: wy + (p[1] - h / 2) * mPerPx, mPerPx };
}

/** Moves the view so the content follows a drag of (dx, dy) screen pixels. */
export function panBy(v: View, dx: number, dy: number): View {
  return { cx: v.cx - dx * v.mPerPx, cy: v.cy + dy * v.mPerPx, mPerPx: v.mPerPx };
}

/**
 * The canvas transform from world metres to screen pixels, for ctx.transform(a, b, c, d, e, f).
 * Applied once per frame, so cached world-unit paths can be drawn as they are.
 */
export function worldTransform(v: View, w: number, h: number): [number, number, number, number, number, number] {
  const k = 1 / v.mPerPx;
  return [k, 0, 0, -k, w / 2 - v.cx * k, h / 2 + v.cy * k];
}
