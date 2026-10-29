import type { Bbox, FrameTransform, PageRect, Position } from "./types.js";

/** Fit a world bbox into a page rectangle: uniform scale, centred, y flipped. */
export function fitFrame(worldBbox: Bbox, rect: PageRect, paddingPx = 0): FrameTransform {
  const [minX, minY, maxX, maxY] = worldBbox;
  const dx = maxX - minX;
  const dy = maxY - minY;
  const w = Math.max(rect.width - 2 * paddingPx, 0);
  const h = Math.max(rect.height - 2 * paddingPx, 0);
  let scale: number;
  if (dx > 0 && dy > 0) scale = Math.min(w / dx, h / dy);
  else if (dx > 0) scale = w / dx;
  else if (dy > 0) scale = h / dy;
  else scale = 1;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  // page = (x*scale + tx, -y*scale + ty); the bbox centre lands on the rect centre.
  return {
    scale,
    tx: rect.x + rect.width / 2 - cx * scale,
    ty: rect.y + rect.height / 2 + cy * scale,
  };
}

export function worldToPage(t: FrameTransform, x: number, y: number): Position {
  return [x * t.scale + t.tx, -y * t.scale + t.ty];
}

export function pageToWorld(t: FrameTransform, px: number, py: number): Position {
  return [(px - t.tx) / t.scale, (t.ty - py) / t.scale];
}
