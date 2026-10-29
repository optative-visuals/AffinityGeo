// Drawing the Map view: the area's data in the project style, then each map's frame, pin and rotate handle.
// Area features are cached as Path2D in world metres and drawn under one world transform per frame.
import type { ProjectStyle, RoleId } from "@affinitygeo/geo-core/view";
import type { AreaPreview } from "../api.js";
import { pinPoint, type CornersById } from "./hit.js";
import { toScreen, worldTransform, type View } from "./viewport.js";

export const HIGHLIGHT = "#4AA3FF";
export const PIN_COLOUR = "#E4572E";
export const PIN_TEXT = "#FFFFFF";
export const PIN_RADIUS_PX = 9;
export const HANDLE_RADIUS_PX = 5;
/** Features smaller than this on screen (px, both ways) aren't drawn. */
export const MIN_FEATURE_PX = 0.5;

export interface Highlight { role: RoleId; fids: readonly string[] }

type Bbox = [number, number, number, number];
/** Each cached path's world bounding box, so a frame can cull without walking the coordinates again. */
const boxes = new WeakMap<object, Bbox>();

/** Canvas strokes stay readable at overview scale: a constant width, not the print width. */
export const strokePx = (strokePt: number) => Math.max(0.75, strokePt * 0.75);
export const pointPx = (radiusPt: number) => Math.max(1.5, radiusPt);

function featurePath(role: string, kind: string, f: { fid: string; paths: number[][][] }, cache: Map<string, Path2D>): Path2D {
  const key = `${role}:${f.fid}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const p = new Path2D();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const ring of f.paths) {
    ring.forEach((c, i) => {
      const x = c[0]!, y = c[1]!;
      if (i === 0) p.moveTo(x, y); else p.lineTo(x, y);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    });
    if (kind === "polygon" && ring.length) p.closePath();
  }
  boxes.set(p, [minX, minY, maxX, maxY]);
  cache.set(key, p);
  return p;
}

/** The world box visible on screen. */
function visibleBox(view: View, w: number, h: number): Bbox {
  const hw = (w / 2) * view.mPerPx, hh = (h / 2) * view.mPerPx;
  return [view.cx - hw, view.cy - hh, view.cx + hw, view.cy + hh];
}

/** True when the path is on screen and at least half a pixel across. */
function worthDrawing(p: Path2D, view: View, vis: Bbox, padM: number): boolean {
  const b = boxes.get(p);
  if (!b) return true;
  if (b[2] < vis[0] - padM || b[0] > vis[2] + padM || b[3] < vis[1] - padM || b[1] > vis[3] + padM) return false;
  return Math.max(b[2] - b[0], b[3] - b[1]) / view.mPerPx >= MIN_FEATURE_PX;
}

type Layer = AreaPreview["layers"][number];

function drawPoints(ctx: CanvasRenderingContext2D, layer: Layer, fids: Set<string> | null, rPx: number, view: View, vis: Bbox) {
  const r = rPx * view.mPerPx;
  ctx.beginPath();
  for (const f of layer.features) {
    if (fids && !fids.has(f.fid)) continue;
    for (const ring of f.paths) for (const c of ring) {
      const x = c[0]!, y = c[1]!;
      if (x < vis[0] - r || x > vis[2] + r || y < vis[1] - r || y > vis[3] + r) continue;
      ctx.moveTo(x + r, y);
      ctx.arc(x, y, r, 0, Math.PI * 2);
    }
  }
}

/**
 * Draws the area's data in the project style: roles in style order (lowest first), hidden roles left out,
 * features under half a pixel skipped. `cache` maps "role:fid" to a world-unit Path2D; start a new one when the
 * preview changes.
 */
export function drawArea(
  ctx: CanvasRenderingContext2D, preview: AreaPreview, style: ProjectStyle, view: View, w: number, h: number,
  cache: Map<string, Path2D>,
): void {
  const layers = preview.layers
    .filter((l) => style.roles[l.role]?.visible)
    .sort((a, b) => style.roles[a.role].order - style.roles[b.role].order);
  const vis = visibleBox(view, w, h);
  ctx.save();
  ctx.transform(...worldTransform(view, w, h));
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  for (const layer of layers) {
    const rs = style.roles[layer.role];
    const stroke = rs.stroke && rs.strokePt > 0 ? rs.stroke : null;
    const lw = strokePx(rs.strokePt) * view.mPerPx;
    if (layer.kind === "point") {
      const fill = rs.fill ?? rs.stroke;
      if (!fill) continue;
      drawPoints(ctx, layer, null, pointPx(rs.pointRadiusPt), view, vis);
      ctx.fillStyle = fill;
      ctx.fill();
      if (stroke && rs.fill) { ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.stroke(); }
      continue;
    }
    const fill = layer.kind === "polygon" ? rs.fill : null;
    if (!fill && !stroke) continue;
    if (fill) ctx.fillStyle = fill;
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw; }
    for (const f of layer.features) {
      const p = featurePath(layer.role, layer.kind, f, cache);
      if (!worthDrawing(p, view, vis, lw)) continue;
      if (fill) ctx.fill(p, "evenodd");
      if (stroke) ctx.stroke(p);
    }
  }
  ctx.restore();
}

/** Draws the highlighted features of one role on top, in the highlight blue (Data screen). */
export function drawHighlight(
  ctx: CanvasRenderingContext2D, preview: AreaPreview, highlight: Highlight, view: View, w: number, h: number,
  cache: Map<string, Path2D>,
): void {
  const fids = new Set(highlight.fids);
  if (!fids.size) return;
  const vis = visibleBox(view, w, h);
  ctx.save();
  ctx.transform(...worldTransform(view, w, h));
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.fillStyle = HIGHLIGHT;
  ctx.strokeStyle = HIGHLIGHT;
  ctx.lineWidth = 2 * view.mPerPx;
  for (const layer of preview.layers) {
    if (layer.role !== highlight.role) continue;
    if (layer.kind === "point") {
      drawPoints(ctx, layer, fids, 4, view, vis);
      ctx.fill();
      continue;
    }
    for (const f of layer.features) {
      if (!fids.has(f.fid)) continue;
      const p = featurePath(layer.role, layer.kind, f, cache);
      if (layer.kind === "polygon") ctx.fill(p, "evenodd");
      ctx.stroke(p);
    }
  }
  ctx.restore();
}

/** Frame ink and its halo (casing), by paper: neutral, so a frame never reads as a road, path or marker. */
export const FRAME_INK = { light: "#1B252C", dark: "#FFFFFF" };
export const FRAME_CASING = { light: "rgba(255,255,255,0.85)", dark: "rgba(0,0,0,0.6)" };
export const FRAME_DASH = [5, 3];

/**
 * Draws every map's frame outline (dashed neutral ink over a halo; selected ones solid 2 px blue), its numbered pin (1-based, white on red)
 * and, on selected maps, the rotate handle at the frame's top-right corner. Screen pixels, no world transform.
 */
export function drawMaps(
  ctx: CanvasRenderingContext2D, maps: readonly { id: string }[], cornersById: CornersById,
  selectedIds: readonly string[], view: View, w: number, h: number, paper = "#FFFFFF",
): void {
  const selected = new Set(selectedIds);
  const tone = (luminance(paper) ?? 1) < 0.4 ? "dark" : "light";
  const screen = (p: readonly [number, number]) => toScreen(view, w, h, p);
  ctx.save();
  ctx.lineJoin = "miter";
  // Frames first, so every pin sits above every frame.
  maps.forEach((m) => {
    const c = cornersById[m.id];
    if (!c || c.length < 2) return;
    const on = selected.has(m.id);
    ctx.beginPath();
    c.forEach((pt, i) => { const [x, y] = screen(pt); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
    ctx.closePath();
    ctx.setLineDash([]);
    ctx.strokeStyle = FRAME_CASING[tone];
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.setLineDash(on ? [] : FRAME_DASH);
    ctx.strokeStyle = on ? HIGHLIGHT : FRAME_INK[tone];
    ctx.lineWidth = on ? 2 : 1;
    ctx.stroke();
  });
  ctx.setLineDash([]);
  ctx.font = "600 11px system-ui, -apple-system, 'Segoe UI', sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  maps.forEach((m, i) => {
    const c = cornersById[m.id];
    if (!c || !c.length) return;
    const [x, y] = screen(pinPoint(c));
    ctx.beginPath();
    ctx.arc(x, y, PIN_RADIUS_PX, 0, Math.PI * 2);
    ctx.fillStyle = PIN_COLOUR;
    ctx.fill();
    ctx.strokeStyle = selected.has(m.id) ? HIGHLIGHT : PIN_TEXT;
    ctx.lineWidth = selected.has(m.id) ? 2 : 1.5;
    ctx.stroke();
    ctx.fillStyle = PIN_TEXT;
    ctx.fillText(String(i + 1), x, y + 0.5);
  });
  for (const m of maps) {
    const c = cornersById[m.id];
    if (!selected.has(m.id) || !c || c.length < 2) continue;
    const [x, y] = screen(c[1]!);
    ctx.beginPath();
    ctx.arc(x, y, HANDLE_RADIUS_PX, 0, Math.PI * 2);
    ctx.fillStyle = "#FFFFFF";
    ctx.fill();
    ctx.strokeStyle = HIGHLIGHT;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  ctx.restore();
}

function luminance(hex: string): number | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
}

/**
 * The paper under the map: the style's own paper colour (what Affinity draws as the map background).
 * A style without one (from an older companion) falls back to a guess: white for light fills, a deep slate for dark ones.
 */
export function paperColour(style: ProjectStyle): string {
  if (typeof style.paper === "string" && luminance(style.paper) !== null) return style.paper;
  const ls = Object.values(style.roles).map((r) => (r.fill ? luminance(r.fill) : null)).filter((v): v is number => v !== null);
  if (!ls.length) return "#FFFFFF";
  return ls.reduce((a, b) => a + b, 0) / ls.length < 0.4 ? "#1B252C" : "#FFFFFF";
}
