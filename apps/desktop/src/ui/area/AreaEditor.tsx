// The area editor: a box or a shape drawn over the street map, plus the surrounding context fetched around it.
// The overlay is in screen pixels (from the Basemap's projection); the value is always WGS84.
import { useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { PlaceResult } from "@affinitygeo/geo-core";
import {
  CONTEXT_DEFAULT_M, CONTEXT_MAX_M, CONTEXT_STEP_M, LARGE, MAX_KM2, OUTLINE_MAX_VERTICES, RING_MAX_VERTICES, TOO_BIG,
  WARN_KM2, boxRing, fetchKm2, fetchRing, ringAreaKm2, ringBbox, simplifyRing, validateRing, type Bbox, type Ring,
} from "@affinitygeo/geo-core/view";
import { Basemap, type BasemapApi } from "../map/Basemap.js";

type XY = [number, number];
type Edge = "left" | "right" | "top" | "bottom";

export interface AreaValue { kind: "box" | "shape"; ring: Ring; contextM: number }

export interface AreaEditorProps {
  value: AreaValue;
  onChange(v: AreaValue): void;
  /** Its outline is drawn faintly, and enables "Fit to place outline". */
  place?: PlaceResult | null;
  /** Other locations, drawn faintly. */
  others?: Array<{ name: string; ring: Ring }>;
  /** The map fits the area again whenever this changes. */
  fitKey: string;
}

/** "1.4 km²", or whole numbers from 100. */
export function formatKm2(km2: number): string {
  return `${km2 >= 100 ? km2.toFixed(0) : km2.toFixed(1)} km²`;
}

/** Why this area can't be created or fetched: crossing edges, or too big with its context. Null when it can. */
export function areaError(v: AreaValue): string | null {
  return (v.kind === "shape" ? validateRing(v.ring) : null) ?? (fetchKm2(v) > MAX_KM2 ? TOO_BIG : null);
}

const KM_PER_DEG = 111.32;
const RAD = Math.PI / 180;

/** A square of `km2` centred on a point. */
function squareAround([lon, lat]: XY, km2: number): Bbox {
  const half = Math.sqrt(km2) / 2;
  const dLat = half / KM_PER_DEG, dLon = half / (KM_PER_DEG * Math.cos(lat * RAD));
  return [lon - dLon, lat - dLat, lon + dLon, lat + dLat];
}

/**
 * The place's bbox grown by 10 % (5 % each side), as a box with the default context. A point-like result gets a
 * small box so there is something to drag. A place too big to fetch gets a square of 80 % of the limit around its
 * centre instead, shrunk until it fits with its context.
 */
export function initialArea(place: PlaceResult): AreaValue {
  let [w, s, e, n] = place.bboxWgs84;
  const minSpan = 0.004;
  if (e - w < minSpan) { const c = (w + e) / 2; w = c - minSpan / 2; e = c + minSpan / 2; }
  if (n - s < minSpan) { const c = (s + n) / 2; s = c - minSpan / 2; n = c + minSpan / 2; }
  const gx = (e - w) * 0.05, gy = (n - s) * 0.05;
  const area: AreaValue = { kind: "box", ring: boxRing([w - gx, s - gy, e + gx, n + gy]), contextM: CONTEXT_DEFAULT_M };
  if (ringAreaKm2(area.ring) <= MAX_KM2 && fetchKm2(area) <= MAX_KM2) return area;
  let km2 = MAX_KM2 * 0.8;
  for (;;) {
    const sq: AreaValue = { ...area, ring: boxRing(squareAround(place.centre, km2)) };
    if (fetchKm2(sq) <= MAX_KM2 || km2 < 0.01) return sq;
    km2 *= 0.9;
  }
}

/** The place's outer rings, open (GeoJSON repeats the first vertex at the end). */
function outlineRings(place: PlaceResult | null | undefined): Ring[] {
  const g = place?.outline;
  if (!g) return [];
  const polys = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
  return (polys as number[][][][]).map((poly) => {
    const ring = (poly[0] ?? []).map((p) => [p[0]!, p[1]!] as XY);
    const a = ring[0], z = ring[ring.length - 1];
    if (ring.length > 1 && a && z && a[0] === z[0] && a[1] === z[1]) ring.pop();
    return ring;
  }).filter((r) => r.length >= 3);
}

/** The place's largest outline, simplified to a shape that doesn't cross itself; its bbox as a fallback. */
function outlineShape(place: PlaceResult): Ring | null {
  const rings = outlineRings(place);
  if (!rings.length) return null;
  const outer = rings.reduce((a, b) => (ringAreaKm2(b) > ringAreaKm2(a) ? b : a));
  // Simplifying can make edges cross: fewer corners until it doesn't.
  for (let max = OUTLINE_MAX_VERTICES; max >= 3; max--) {
    const ring = simplifyRing(outer, max);
    if (!validateRing(ring)) return ring;
  }
  return boxRing(ringBbox(outer));
}

/** The view to fit: the fetched area with 10 % room on each side. */
function viewBbox(v: AreaValue): Bbox {
  const [w, s, e, n] = ringBbox(fetchRing(v));
  const gx = (e - w) * 0.1, gy = (n - s) * 0.1;
  return [w - gx, s - gy, e + gx, n + gy];
}

const MIN_SPAN_DEG = 0.0002;
const KEY_STEP_PX = 5;
const HANDLE_PX = 14;

const EDGE_LABELS: Record<Edge, string> = {
  left: "Drag the left edge", right: "Drag the right edge", top: "Drag the top edge", bottom: "Drag the bottom edge",
};
const HINTS = {
  box: "Drag an edge to resize the area, or drag inside the box to move it.",
  shape: "Drag a corner to move it. Click a dot on an edge to add a corner. Double-click a corner to remove it.",
};

const pathOf = (ring: readonly XY[]) => (ring.length ? `M ${ring.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join(" L ")} Z` : "");

/** A box edge moved by a pixel shift, kept at least MIN_SPAN_DEG from the opposite edge. */
function moveEdge(map: BasemapApi, b: Bbox, edge: Edge, [dx, dy]: XY): Bbox {
  const [w, s, e, n] = b;
  const midLat = (s + n) / 2, midLon = (w + e) / 2;
  const next: Bbox = [w, s, e, n];
  if (edge === "left" || edge === "right") {
    const [px, py] = map.project([edge === "left" ? w : e, midLat]);
    const lon = map.unproject([px + dx, py])[0];
    if (edge === "left") next[0] = Math.min(lon, e - MIN_SPAN_DEG);
    else next[2] = Math.max(lon, w + MIN_SPAN_DEG);
  } else {
    const [px, py] = map.project([midLon, edge === "bottom" ? s : n]);
    const lat = map.unproject([px, py + dy])[1];
    if (edge === "bottom") next[1] = Math.min(lat, n - MIN_SPAN_DEG);
    else next[3] = Math.max(lat, s + MIN_SPAN_DEG);
  }
  return next;
}

/** Points moved by a pixel shift on the map. */
const shift = (map: BasemapApi, pts: readonly XY[], [dx, dy]: XY): Ring =>
  pts.map((p) => { const [x, y] = map.project(p); return map.unproject([x + dx, y + dy]); });

const ARROWS: Record<string, XY> = {
  ArrowLeft: [-KEY_STEP_PX, 0], ArrowRight: [KEY_STEP_PX, 0], ArrowUp: [0, -KEY_STEP_PX], ArrowDown: [0, KEY_STEP_PX],
};

type Drag = { kind: "body" } | { kind: "edge"; edge: Edge } | { kind: "corner"; index: number };

export function AreaEditor({ value, onChange, place, others = [], fitKey }: AreaEditorProps) {
  const id = useId();
  const [selected, setSelected] = useState<number | null>(null);
  // The view is fitted when the parent's fitKey changes, and after Fit to place outline.
  const [view, setView] = useState(() => ({ fitKey, n: 0, bbox: viewBbox(value) }));
  if (view.fitKey !== fitKey) setView({ fitKey, n: view.n + 1, bbox: viewBbox(value) });

  const canFit = outlineRings(place).length > 0;
  const shapeKm2 = ringAreaKm2(value.ring);
  const fetchedKm2 = fetchKm2(value);
  const crossing = value.kind === "shape" ? validateRing(value.ring) : null;
  const sizeLine = formatKm2(shapeKm2) === formatKm2(fetchedKm2)
    ? formatKm2(shapeKm2)
    : `${formatKm2(shapeKm2)} · ${formatKm2(fetchedKm2)} with context`;
  const tooBig = fetchedKm2 > MAX_KM2;
  const warning = tooBig ? TOO_BIG : fetchedKm2 > WARN_KM2 ? LARGE : null;

  function setKind(kind: AreaValue["kind"]): void {
    if (kind === value.kind) return;
    setSelected(null);
    onChange({ ...value, kind, ring: kind === "box" ? boxRing(ringBbox(value.ring)) : value.ring });
  }

  function fitOutline(): void {
    if (!place) return;
    const ring = outlineShape(place);
    if (!ring) return;
    const next: AreaValue = { ...value, kind: "shape", ring };
    setSelected(null);
    setView({ fitKey, n: view.n + 1, bbox: viewBbox(next) });
    onChange(next);
  }

  return (
    <div className="area-editor">
      <div className="area-editor-bar">
        <div className="segmented" role="group" aria-label="Area type">
          {(["box", "shape"] as const).map((k) => (
            <button key={k} type="button" aria-pressed={value.kind === k} className={value.kind === k ? "is-on" : ""}
              onClick={() => setKind(k)}>{k === "box" ? "Box" : "Shape"}</button>
          ))}
        </div>
        {canFit && <button type="button" className="btn btn-small" onClick={fitOutline}>Fit to place outline</button>}
      </div>
      <div className="area-map">
        <Basemap fit={{ bbox: view.bbox }} fitKey={`${fitKey}#${view.n}`}>
          {(map) => (
            <Overlay map={map} value={value} onChange={onChange} place={place} others={others}
              selected={selected} onSelect={setSelected} />
          )}
        </Basemap>
      </div>
      <p className="help">{HINTS[value.kind]}</p>
      <div className="area-size">
        <span data-testid="area-readout" className="readout">{sizeLine}</span>
        {warning && <span className={tooBig ? "help help-bad" : "help help-warn"}>{warning}</span>}
      </div>
      {crossing && <p className="help help-bad">{crossing}</p>}
      <div className="field">
        <div className="area-context-label">
          <label className="field-label" htmlFor={`${id}-context`}>Surrounding context</label>
          <span className="area-context-value">{value.contextM} m</span>
        </div>
        <input id={`${id}-context`} className="range" type="range"
          min={0} max={CONTEXT_MAX_M} step={CONTEXT_STEP_M} value={value.contextM}
          onChange={(e) => onChange({ ...value, contextM: Number(e.target.value) })} />
        <span className="help">The map data around the area, fetched too, so a map can show it faded behind the shape.</span>
      </div>
    </div>
  );
}

interface OverlayProps {
  map: BasemapApi;
  value: AreaValue;
  onChange(v: AreaValue): void;
  place?: PlaceResult | null;
  others: Array<{ name: string; ring: Ring }>;
  selected: number | null;
  onSelect(i: number | null): void;
}

function Overlay({ map, value, onChange, place, others, selected, onSelect }: OverlayProps) {
  const svg = useRef<SVGSVGElement>(null);
  // The latest map and value, for a drag that outlives this render.
  const live = useRef({ map, value, onChange });
  live.current = { map, value, onChange };

  const px = (p: XY) => map.project(p);
  const ring = value.ring;
  const pts = ring.map(px);
  const fetched = fetchRing(value).map(px);
  const shape = value.kind === "shape";
  const canRemove = ring.length > 3;
  const canAdd = ring.length < RING_MAX_VERTICES;

  function pointer(ev: { clientX: number; clientY: number }): XY {
    const r = svg.current!.getBoundingClientRect();
    return [ev.clientX - r.left, ev.clientY - r.top];
  }

  /** The value after a drag (or key press) moved this part by a pixel shift. */
  function moved(from: AreaValue, drag: Drag, d: XY): AreaValue {
    const m = live.current.map;
    if (drag.kind === "body") return { ...from, ring: shift(m, from.ring, d) };
    if (drag.kind === "edge") return { ...from, ring: boxRing(moveEdge(m, ringBbox(from.ring), drag.edge, d)) };
    const ring = [...from.ring];
    ring[drag.index] = shift(m, [ring[drag.index]!], d)[0]!;
    return { ...from, ring };
  }

  function startDrag(ev: ReactPointerEvent<SVGElement>, drag: Drag): void {
    if (ev.button > 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    if (drag.kind !== "body") ev.currentTarget.focus();
    onSelect(drag.kind === "corner" ? drag.index : null);
    const start = pointer(ev);
    const from = live.current.value;
    const move = (m: PointerEvent): void => {
      const [x, y] = pointer(m);
      live.current.onChange(moved(from, drag, [x - start[0], y - start[1]]));
    };
    const up = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }

  function removeCorner(i: number): void {
    if (!canRemove) return;
    onSelect(null);
    onChange({ ...value, ring: ring.filter((_, j) => j !== i) });
  }

  function addCorner(i: number): void {
    if (!canAdd) return;
    const a = ring[i]!, b = ring[(i + 1) % ring.length]!;
    const next = [...ring];
    next.splice(i + 1, 0, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
    onSelect(i + 1);
    onChange({ ...value, ring: next });
  }

  function onKey(ev: ReactKeyboardEvent, drag: Drag): void {
    if (drag.kind === "corner" && (ev.key === "Delete" || ev.key === "Backspace")) {
      ev.preventDefault();
      removeCorner(drag.index);
      return;
    }
    const d = ARROWS[ev.key];
    if (!d) return;
    // A box edge only moves across itself.
    if (drag.kind === "edge" && ((drag.edge === "left" || drag.edge === "right") ? d[0] === 0 : d[1] === 0)) return;
    ev.preventDefault();
    onChange(moved(value, drag, d));
  }

  const [w, s, e, n] = ringBbox(ring);
  const edgeMids: Record<Edge, XY> = {
    left: px([w, (s + n) / 2]), right: px([e, (s + n) / 2]), top: px([(w + e) / 2, n]), bottom: px([(w + e) / 2, s]),
  };

  return (
    <svg ref={svg} className="area-overlay" aria-label="Area editor" width="100%" height="100%"
      style={{ pointerEvents: "none" }}>
      {outlineRings(place).map((r, i) => <path key={`p${i}`} className="area-place" d={pathOf(r.map(px))} />)}
      {others.map((o, i) => {
        const opts = o.ring.map(px);
        const [ow, os, oe, on] = ringBbox(o.ring);
        const [lx, ly] = px([(ow + oe) / 2, (os + on) / 2]);
        return (
          <g key={`o${i}`} className="area-other">
            <path d={pathOf(opts)} />
            <text x={lx} y={ly} textAnchor="middle" dominantBaseline="middle">{o.name}</text>
          </g>
        );
      })}
      <path className="area-fetched" d={pathOf(fetched)} />
      <path className={`area-shape${shape ? " is-shape" : ""}`} d={pathOf(pts)}
        onPointerDown={(ev) => startDrag(ev, { kind: "body" })} />
      {!shape && (Object.keys(edgeMids) as Edge[]).map((edge) => {
        const [x, y] = edgeMids[edge];
        return (
          <rect key={edge} role="button" tabIndex={0} aria-label={EDGE_LABELS[edge]}
            className={`area-handle area-handle-${edge}`}
            x={x - HANDLE_PX / 2} y={y - HANDLE_PX / 2} width={HANDLE_PX} height={HANDLE_PX} rx={3}
            onPointerDown={(ev) => startDrag(ev, { kind: "edge", edge })}
            onKeyDown={(ev) => onKey(ev, { kind: "edge", edge })} />
        );
      })}
      {shape && canAdd && pts.map((a, i) => {
        const b = pts[(i + 1) % pts.length]!;
        return (
          <circle key={`m${i}`} role="button" aria-label={`Add a corner after corner ${i + 1}`} className="area-add"
            cx={(a[0] + b[0]) / 2} cy={(a[1] + b[1]) / 2} r={4}
            onPointerDown={(ev) => { ev.stopPropagation(); ev.preventDefault(); }}
            onClick={() => addCorner(i)} />
        );
      })}
      {shape && pts.map(([x, y], i) => (
        <circle key={`c${i}`} role="button" tabIndex={0} aria-label={`Corner ${i + 1}`}
          className={`area-corner${selected === i ? " is-selected" : ""}`} cx={x} cy={y} r={6}
          onPointerDown={(ev) => startDrag(ev, { kind: "corner", index: i })}
          onDoubleClick={() => removeCorner(i)}
          onKeyDown={(ev) => onKey(ev, { kind: "corner", index: i })} />
      ))}
    </svg>
  );
}
