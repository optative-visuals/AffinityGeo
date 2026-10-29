// The area box: the place's outline drawn in local metres with a box you can resize by its edges or move by its body.
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { PlaceResult } from "@affinitygeo/geo-core";
import {
  MAX_KM2, TOO_BIG, areaKm2, areaWarning, projector, suggestProjection, utmParams, type AreaSpec, type Bbox,
} from "@affinitygeo/geo-core/view";

type XY = [number, number];
type Edge = "left" | "right" | "top" | "bottom";

/** The place's bbox grown by 10 % (5 % each side). A point-like result gets a small box so there is something to drag. */
export function initialBox(place: PlaceResult): Bbox {
  let [w, s, e, n] = place.bboxWgs84;
  const minSpan = 0.004;
  if (e - w < minSpan) { const c = (w + e) / 2; w = c - minSpan / 2; e = c + minSpan / 2; }
  if (n - s < minSpan) { const c = (s + n) / 2; s = c - minSpan / 2; n = c + minSpan / 2; }
  const gx = (e - w) * 0.05, gy = (n - s) * 0.05;
  return [w - gx, s - gy, e + gx, n + gy];
}

/** "1.4 km²", or whole numbers from 100. */
export function formatKm2(km2: number): string {
  return `${km2 >= 100 ? km2.toFixed(0) : km2.toFixed(1)} km²`;
}

/** Local metres around the place centre, on a metric grid: British National Grid in Great Britain, else UTM. */
function localFrame(place: PlaceResult) {
  const suggested = suggestProjection(place.bboxWgs84);
  const area: AreaSpec = suggested.id === "bng"
    ? { placeName: "", bboxWgs84: place.bboxWgs84, projectionId: "bng" }
    : { placeName: "", bboxWgs84: place.bboxWgs84, projectionId: "utm", projectionParams: utmParams(place.bboxWgs84) };
  const pr = projector(area);
  const [ox, oy] = pr.forward(place.centre);
  return {
    toLocal: (p: XY): XY => { const q = pr.forward(p); return [q[0] - ox, q[1] - oy]; },
    toLonLat: (p: XY): XY => pr.inverse([p[0] + ox, p[1] + oy]),
  };
}

type Ring = readonly (readonly number[])[];
function outlineRings(place: PlaceResult): Ring[] {
  const g = place.outline;
  if (!g) return [];
  if (g.type === "Polygon") return g.coordinates as unknown as Ring[];
  if (g.type === "MultiPolygon") return (g.coordinates as unknown as Ring[][]).flat();
  return [];
}

/** A square view: centre and half its side, in local metres. */
export interface BoxView { cx: number; cy: number; half: number }

/** Room around the fitted shapes, as a share of their extent (12.5 % each side), so the handles show whole. */
const VIEW_MARGIN = 1.25;
const MIN_VIEW_HALF_M = 200;

/** The square view around these points, with a margin. */
export function fitSquare(pts: readonly XY[]): BoxView {
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const half = Math.max(((Math.max(x1 - x0, y1 - y0)) / 2) * VIEW_MARGIN, MIN_VIEW_HALF_M);
  return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, half };
}

/** True when every point lies at least `pad` inside the view. */
function fitsIn(view: BoxView, pts: readonly XY[], pad: number): boolean {
  const lim = view.half - pad;
  return pts.every(([x, y]) => Math.abs(x - view.cx) <= lim && Math.abs(y - view.cy) <= lim);
}

const MIN_SPAN_DEG = 0.0002;
const HANDLE_PX = 14;
const FALLBACK_VIEW_PX = 260; // used until the real size is known

export interface BoxEditorProps {
  place: PlaceResult;
  /** The box, as west, south, east, north. */
  bbox: Bbox;
  onChange(bbox: Bbox): void;
}

export function BoxEditor({ place, bbox, onChange }: BoxEditorProps) {
  const frame = useMemo(() => localFrame(place), [place]);
  const svg = useRef<SVGSVGElement>(null);
  // The drawn size of the square the view is fitted into, so the handles stay about 14 px on screen.
  const [fitted, setFitted] = useState(FALLBACK_VIEW_PX);
  useEffect(() => {
    const measure = () => {
      const r = svg.current?.getBoundingClientRect();
      const px = r ? Math.min(r.width, r.height) : 0;
      if (px > 0) setFitted(px);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  const [w, s, e, n] = bbox;
  const corners = [frame.toLocal([w, n]), frame.toLocal([e, n]), frame.toLocal([e, s]), frame.toLocal([w, s])];

  // The place's outline (or its bbox when there is none), in local metres.
  const placePts = useMemo(() => {
    const pts = outlineRings(place).flatMap((ring) => ring.map((p) => frame.toLocal([p[0]!, p[1]!])));
    if (pts.length) return pts;
    const [pw, ps, pe, pn] = place.bboxWgs84;
    return [frame.toLocal([pw, ps]), frame.toLocal([pe, ps]), frame.toLocal([pe, pn]), frame.toLocal([pw, pn])];
  }, [frame, place]);

  // The view fits the outline and the box together, and stays still while the box moves inside it, so the
  // box moves over the place. It refits when the box goes beyond it (after a drag, never during one).
  const [fit, setFit] = useState(() => ({ place, view: fitSquare([...placePts, ...corners]) }));
  const [dragging, setDragging] = useState(false);
  const view = fit.view;
  const side = (HANDLE_PX * 2 * view.half) / fitted;
  const needsRefit = fit.place !== place || (!dragging && !fitsIn(view, corners, side));
  useEffect(() => {
    if (!needsRefit) return;
    const next = fitSquare([...placePts, ...corners]);
    // The same view again (a very small svg, where the handles outgrow the margin): don't loop.
    if (fit.place === place && next.cx === view.cx && next.cy === view.cy && next.half === view.half) return;
    setFit({ place, view: next });
  });

  // SVG y runs down, so y is negated when drawing.
  const sv = ([x, y]: XY) => `${x.toFixed(1)} ${(-y).toFixed(1)}`;
  const mids: Record<Edge, XY> = {
    left: frame.toLocal([w, (s + n) / 2]), right: frame.toLocal([e, (s + n) / 2]),
    top: frame.toLocal([(w + e) / 2, n]), bottom: frame.toLocal([(w + e) / 2, s]),
  };

  const outline = outlineRings(place)
    .map((ring) => `M ${ring.map((p) => sv(frame.toLocal([p[0]!, p[1]!]))).join(" L ")} Z`)
    .join(" ");

  /** A pointer position in local metres. The view is fitted with "meet", so the larger ratio sets the scale. */
  function metres(clientX: number, clientY: number): XY {
    const r = svg.current!.getBoundingClientRect();
    const mpp = r.width > 0 && r.height > 0 ? (2 * view.half) / Math.min(r.width, r.height) : 1;
    return [view.cx + (clientX - (r.left + r.width / 2)) * mpp, view.cy - (clientY - (r.top + r.height / 2)) * mpp];
  }

  function startDrag(ev: ReactPointerEvent, kind: Edge | "body"): void {
    if (ev.button > 0) return;
    ev.preventDefault();
    setDragging(true);
    const start = metres(ev.clientX, ev.clientY);
    const from: Bbox = [...bbox];
    const midLat = (from[1] + from[3]) / 2, midLon = (from[0] + from[2]) / 2;

    const move = (m: PointerEvent): void => {
      const [mx, my] = metres(m.clientX, m.clientY);
      const dx = mx - start[0], dy = my - start[1];
      const next: Bbox = [...from];
      if (kind === "body") {
        // Move the whole box by the same shift, so its size doesn't drift.
        const c = frame.toLocal([midLon, midLat]);
        const moved = frame.toLonLat([c[0] + dx, c[1] + dy]);
        const dLon = moved[0] - midLon, dLat = moved[1] - midLat;
        next[0] += dLon; next[2] += dLon; next[1] += dLat; next[3] += dLat;
      } else if (kind === "left" || kind === "right") {
        const p = frame.toLocal([kind === "left" ? from[0] : from[2], midLat]);
        const moved = frame.toLonLat([p[0] + dx, p[1]])[0];
        if (kind === "left") next[0] = Math.min(moved, from[2] - MIN_SPAN_DEG);
        else next[2] = Math.max(moved, from[0] + MIN_SPAN_DEG);
      } else {
        const p = frame.toLocal([midLon, kind === "bottom" ? from[1] : from[3]]);
        const moved = frame.toLonLat([p[0], p[1] + dy])[1];
        if (kind === "bottom") next[1] = Math.min(moved, from[3] - MIN_SPAN_DEG);
        else next[3] = Math.max(moved, from[1] + MIN_SPAN_DEG);
      }
      onChange(next);
    };
    const up = (): void => {
      setDragging(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }

  const km2 = areaKm2(bbox);
  const tooBig = km2 > MAX_KM2;
  const warning = tooBig ? TOO_BIG : areaWarning(bbox);
  const labels: Record<Edge, string> = {
    left: "Drag the left edge", right: "Drag the right edge", top: "Drag the top edge", bottom: "Drag the bottom edge",
  };

  return (
    <div className="box-editor">
      <svg ref={svg} role="img" aria-label="Area box" className="box-svg"
        viewBox={`${view.cx - view.half} ${-view.cy - view.half} ${2 * view.half} ${2 * view.half}`}>
        {outline && <path d={outline} className="box-outline" fillRule="evenodd" vectorEffect="non-scaling-stroke" />}
        <polygon points={corners.map(sv).join(",")} className="box-body" vectorEffect="non-scaling-stroke"
          onPointerDown={(ev) => startDrag(ev, "body")} />
        {(Object.keys(mids) as Edge[]).map((edge) => {
          const [x, y] = mids[edge];
          return (
            <rect key={edge} aria-label={labels[edge]} className={`box-handle box-handle-${edge}`}
              x={x - side / 2} y={-y - side / 2} width={side} height={side} rx={side / 5}
              onPointerDown={(ev) => startDrag(ev, edge)} />
          );
        })}
      </svg>
      <div className="box-readout">
        <span data-testid="area-readout" className="readout">{formatKm2(km2)}</span>
        {warning && <span className={tooBig ? "help help-bad" : "help help-warn"}>{warning}</span>}
      </div>
    </div>
  );
}
