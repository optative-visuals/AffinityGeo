// The Map view: the whole area drawn in the project style, with each map's frame and numbered pin on top.
// Drag empty space to pan, wheel to zoom, drag a pin to move its map, drag the handle to rotate it.
// Reused by the Maps screen, the Style screen's live preview and the Data screen's highlight.
import { useEffect, useMemo, useRef, type PointerEvent as ReactPointerEvent } from "react";
import { mapFrameCorners, projector, type AreaSpec, type MapSpec, type ProjectStyle } from "@affinitygeo/geo-core/view";
import type { AreaPreview } from "../api.js";
import { useApp } from "../store.js";
import { drawArea, drawHighlight, drawMaps, paperColour, type Highlight } from "./draw.js";
import { bearingFrom, hitPin, hitRotateHandle, pinPoint, snapRotation, type Corners } from "./hit.js";
import { fit, panBy, toScreen, toWorld, zoomAt, type View, type XY } from "./viewport.js";

export type LonLat = [number, number];
export type MapCanvasMode = "browse" | "add" | "pick";

export interface MapCanvasProps {
  preview: AreaPreview | null;
  style: ProjectStyle;
  maps: MapSpec[];
  selectedIds: string[];
  /** browse: select, move and rotate maps. add: a click places a new map. pick: a click picks a point. */
  mode: MapCanvasMode;
  /** Features drawn in blue on top (the Data screen). */
  highlight?: { role: Highlight["role"]; fids: string[] };
  onSelect(ids: string[]): void;
  onAdd(lonLat: LonLat): void;
  /** Sent once, when a pin drag ends. */
  onMove(id: string, lonLat: LonLat): void;
  /** Sent once, when a handle drag ends: whole degrees (15° steps with Shift), −180 < deg ≤ 180. */
  onRotate(id: string, deg: number): void;
  onPick(lonLat: LonLat): void;
  /** The area to project with. Defaults to the open project's area. */
  area?: AreaSpec;
  /** Show the frames but don't let them be selected, moved or rotated: pan and zoom only (the Area screen). */
  readOnly?: boolean;
  /** A world box (projected metres) to fit instead of the whole area, e.g. one map's frame. */
  focus?: [number, number, number, number];
}

/** Pixels the pointer may wander before a press counts as a drag rather than a click. */
const CLICK_SLOP_PX = 3;

type Drag =
  | { kind: "pan"; id: number; start: XY; last: XY; moved: boolean }
  | { kind: "move"; id: number; mapId: string; startW: XY; centreW: XY; moved: boolean }
  | { kind: "rotate"; id: number; mapId: string; centreW: XY; offset: number };

interface Draft { mapId: string; centre?: LonLat; rotationDeg?: number }

export function MapCanvas(props: MapCanvasProps) {
  const app = useApp();
  const area = props.area ?? app.project?.area ?? null;
  const areaKey = area ? JSON.stringify([area.projectionId, area.projectionParams ?? null, area.bboxWgs84]) : "";
  const proj = useMemo(() => { try { return area ? projector(area) : null; } catch { return null; } }, [areaKey]);
  const cornerCache = useMemo(() => new WeakMap<MapSpec, Corners>(), [areaKey]);

  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const size = useRef({ w: 0, h: 0, dpr: 1 });
  const view = useRef<View | null>(null);
  const fittedKey = useRef("");
  /** The person has panned or zoomed: a resize then keeps their view instead of refitting. */
  const userMoved = useRef(false);
  const drag = useRef<Drag | null>(null);
  const draft = useRef<Draft | null>(null);
  const pathCache = useRef<{ preview: AreaPreview | null; paths: Map<string, Path2D> }>({ preview: null, paths: new Map() });
  const frame = useRef(0);
  const live = useRef({ props, area, proj, cornerCache });
  live.current = { props, area, proj, cornerCache };

  /** Maps as drawn: the props, with the map being dragged at its draft position. */
  function shownMaps(): MapSpec[] {
    const d = draft.current;
    const maps = live.current.props.maps;
    if (!d) return maps;
    return maps.map((m) => (m.id === d.mapId ? { ...m, ...(d.centre ? { centre: d.centre } : {}), ...(d.rotationDeg !== undefined ? { rotationDeg: d.rotationDeg } : {}) } : m));
  }

  function cornersOf(maps: MapSpec[]): Record<string, Corners> {
    const { area: a, cornerCache: cc } = live.current;
    const out: Record<string, Corners> = {};
    if (!a) return out;
    for (const m of maps) {
      let c = cc.get(m);
      if (!c) {
        try { c = mapFrameCorners(a, m); } catch { continue; }
        cc.set(m, c);
      }
      out[m.id] = c;
    }
    return out;
  }

  /** The world box to fit: the data, or the area's own box before there's data. */
  function fitBounds(): [number, number, number, number] | null {
    const { props: p, area: a, proj: pr } = live.current;
    if (p.focus) return p.focus;
    const b = p.preview?.bounds;
    if (b && (b[2] > b[0] || b[3] > b[1])) return b;
    if (!a || !pr) return null;
    const [w, s, e, n] = a.bboxWgs84;
    const pts = [pr.forward([w, s]), pr.forward([e, s]), pr.forward([e, n]), pr.forward([w, n])];
    return [Math.min(...pts.map((q) => q[0])), Math.min(...pts.map((q) => q[1])), Math.max(...pts.map((q) => q[0])), Math.max(...pts.map((q) => q[1]))];
  }

  function ensureView(): View | null {
    const { w, h } = size.current;
    if (!w || !h) return view.current;
    const b = fitBounds();
    const key = b ? b.join(",") : "";
    if (b && (key !== fittedKey.current || !view.current)) {
      view.current = fit(b, w, h);
      if (key !== fittedKey.current) userMoved.current = false; // new data: start from the whole area again
      fittedKey.current = key;
    }
    return view.current;
  }

  function draw(): void {
    const cv = canvasRef.current;
    const ctx = cv?.getContext("2d");
    const v = ensureView();
    if (!cv || !ctx || !v) return;
    const t0 = performance.now();
    const { w, h, dpr } = size.current;
    const p = live.current.props;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (p.preview) {
      if (pathCache.current.preview !== p.preview) pathCache.current = { preview: p.preview, paths: new Map() };
      const [minX, minY, maxX, maxY] = p.preview.bounds;
      const [x0, y0] = toScreen(v, w, h, [minX, maxY]);
      const [x1, y1] = toScreen(v, w, h, [maxX, minY]);
      ctx.fillStyle = paperColour(p.style);
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      drawArea(ctx, p.preview, p.style, v, w, h, pathCache.current.paths);
      if (p.highlight?.fids.length) drawHighlight(ctx, p.preview, p.highlight, v, w, h, pathCache.current.paths);
    }
    const maps = shownMaps();
    drawMaps(ctx, maps, cornersOf(maps), p.selectedIds, v, w, h, paperColour(p.style));
    cv.dataset.frameMs = (performance.now() - t0).toFixed(2);
  }

  function request(): void {
    if (frame.current) return;
    const run = () => { frame.current = 0; draw(); };
    frame.current = typeof requestAnimationFrame === "function" ? requestAnimationFrame(run) : (setTimeout(run, 16) as unknown as number);
  }

  // A drag in progress is only a draft: drop it when the maps come back from the server.
  // (Not mid-drag: a poll's fresh maps mustn't snap the map being dragged back.)
  useEffect(() => { if (!drag.current) draft.current = null; }, [props.maps]);
  // Any prop change redraws.
  useEffect(() => { request(); });

  // Size, device pixels, the wheel (non-passive so the page doesn't scroll) and cleanup.
  useEffect(() => {
    const wrap = wrapRef.current;
    const cv = canvasRef.current;
    if (!wrap || !cv) return;
    const measure = () => {
      const r = wrap.getBoundingClientRect();
      const w = r.width || wrap.clientWidth, h = r.height || wrap.clientHeight;
      const dpr = window.devicePixelRatio || 1;
      const resized = w !== size.current.w || h !== size.current.h;
      size.current = { w, h, dpr };
      // Until the person pans or zooms, the view follows the box: refit at the new size.
      // After that, keep their centre and zoom (the view stores the centre, so it stays put).
      if (resized && !userMoved.current) fittedKey.current = "";
      cv.width = Math.max(1, Math.round(w * dpr));
      cv.height = Math.max(1, Math.round(h * dpr));
      request();
    };
    measure();
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    ro?.observe(wrap);
    const onWheel = (e: WheelEvent) => {
      const v = ensureView();
      if (!v) return;
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1;
      const factor = Math.exp((-e.deltaY * unit) / 500);
      const { w, h } = size.current;
      view.current = zoomAt(v, w, h, local(e), factor);
      userMoved.current = true;
      request();
    };
    cv.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      ro?.disconnect();
      cv.removeEventListener("wheel", onWheel);
      if (frame.current && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame.current);
      frame.current = 0;
    };
  }, []);

  function local(e: { clientX: number; clientY: number }): XY {
    const r = canvasRef.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  function lonLatAt(world: XY): LonLat | null {
    const pr = live.current.proj;
    return pr ? pr.inverse(world) : null;
  }

  function setCursor(c: string): void {
    const cv = canvasRef.current;
    if (cv && cv.style.cursor !== c) cv.style.cursor = c;
  }

  function hover(p: XY): void {
    const v = ensureView();
    const { props: pr } = live.current;
    if (!v) return;
    if (pr.mode !== "browse") { setCursor("crosshair"); return; }
    if (pr.readOnly) { setCursor("grab"); return; }
    const { w, h } = size.current;
    const maps = shownMaps();
    const corners = cornersOf(maps);
    if (hitRotateHandle(maps, corners, v, w, h, p, pr.selectedIds)) setCursor("alias");
    else if (hitPin(maps, corners, v, w, h, p)) setCursor("move");
    else setCursor("grab");
  }

  function onPointerDown(e: ReactPointerEvent<HTMLCanvasElement>): void {
    const v = ensureView();
    if (!v || drag.current) return;
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* not supported */ }
    const p = local(e);
    const { w, h } = size.current;
    const pr = live.current.props;
    if (pr.mode === "browse" && e.button === 0 && !pr.readOnly) {
      const maps = shownMaps();
      const corners = cornersOf(maps);
      const rot = hitRotateHandle(maps, corners, v, w, h, p, pr.selectedIds);
      if (rot) {
        const map = maps.find((m) => m.id === rot)!;
        const centreW = pinPoint(corners[rot]!);
        drag.current = { kind: "rotate", id: e.pointerId, mapId: rot, centreW, offset: map.rotationDeg - bearingFrom(centreW, toWorld(v, w, h, p)) };
        return;
      }
      const pin = hitPin(maps, corners, v, w, h, p);
      if (pin) {
        const sel = pr.selectedIds;
        if (e.shiftKey || e.ctrlKey || e.metaKey) pr.onSelect(sel.includes(pin) ? sel.filter((s) => s !== pin) : [...sel, pin]);
        else if (!(sel.length === 1 && sel[0] === pin)) pr.onSelect([pin]);
        drag.current = { kind: "move", id: e.pointerId, mapId: pin, startW: toWorld(v, w, h, p), centreW: pinPoint(corners[pin]!), moved: false };
        setCursor("move");
        return;
      }
    }
    drag.current = { kind: "pan", id: e.pointerId, start: p, last: p, moved: false };
    if (pr.mode === "browse") setCursor("grabbing");
  }

  function onPointerMove(e: ReactPointerEvent<HTMLCanvasElement>): void {
    const p = local(e);
    const d = drag.current;
    const v = ensureView();
    if (!d || d.id !== e.pointerId || !v) { if (!d) hover(p); return; }
    const { w, h } = size.current;
    if (d.kind === "pan") {
      view.current = panBy(v, p[0] - d.last[0], p[1] - d.last[1]);
      userMoved.current = true;
      d.last = p;
      if (Math.hypot(p[0] - d.start[0], p[1] - d.start[1]) > CLICK_SLOP_PX) d.moved = true;
    } else if (d.kind === "move") {
      const wp = toWorld(v, w, h, p);
      const [sx, sy] = toScreen(v, w, h, d.startW);
      if (Math.hypot(p[0] - sx, p[1] - sy) > CLICK_SLOP_PX) d.moved = true;
      if (!d.moved) return;
      const centre = lonLatAt([d.centreW[0] + wp[0] - d.startW[0], d.centreW[1] + wp[1] - d.startW[1]]);
      if (centre) draft.current = { mapId: d.mapId, centre };
    } else {
      const raw = bearingFrom(d.centreW, toWorld(v, w, h, p)) + d.offset;
      draft.current = { mapId: d.mapId, rotationDeg: snapRotation(raw, e.shiftKey) };
    }
    request();
  }

  function onPointerUp(e: ReactPointerEvent<HTMLCanvasElement>): void {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    const pr = live.current.props;
    const v = ensureView();
    if (d.kind === "pan") {
      if (!d.moved && v) {
        const { w, h } = size.current;
        const ll = lonLatAt(toWorld(v, w, h, local(e)));
        if (pr.mode === "browse") { if (!pr.readOnly && pr.selectedIds.length) pr.onSelect([]); }
        else if (ll && pr.mode === "add") pr.onAdd(ll);
        else if (ll && pr.mode === "pick") pr.onPick(ll);
      }
    } else if (d.kind === "move") {
      const c = draft.current?.mapId === d.mapId ? draft.current.centre : undefined;
      if (d.moved && c) pr.onMove(d.mapId, c);
      else draft.current = null;
    } else {
      const deg = draft.current?.mapId === d.mapId ? draft.current.rotationDeg : undefined;
      const before = pr.maps.find((m) => m.id === d.mapId)?.rotationDeg;
      if (deg !== undefined && deg !== before) pr.onRotate(d.mapId, deg);
      else draft.current = null;
    }
    hover(local(e));
    request();
  }

  function onPointerCancel(): void {
    drag.current = null;
    draft.current = null;
    request();
  }

  return (
    <div ref={wrapRef} className="map-canvas">
      <canvas
        ref={canvasRef}
        aria-label="Map view"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onPointerLeave={() => { if (!drag.current) setCursor(""); }}
      />
    </div>
  );
}
