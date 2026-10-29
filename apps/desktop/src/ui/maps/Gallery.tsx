// The Gallery: a card per map with a drawn thumbnail, its name, where it goes, and its status.
// Thumbnails come from GET /api/maps/:id/preview, fetched only while the Gallery is shown and cached until the map,
// the style or the data change.
import { useEffect, useRef, useState } from "react";
import type { MapJob, MapSpec, Project, ProjectStyle } from "@affinitygeo/geo-core";
import { api } from "../api.js";
import { paperColour } from "../map/draw.js";
import { useApp } from "../store.js";
import { StatusBadge, badgeFor, targetLine } from "./status.js";
import { TargetPicker } from "./TargetPicker.js";

const PT_MM = 25.4 / 72;
const MARGIN_PX = 8;

/** What a thumbnail depends on: when this changes, it's fetched again. */
export function thumbKey(project: Project, map: MapSpec, counts: unknown): string {
  return JSON.stringify([project.id, project.dataVersion, project.area, project.style, counts,
    map.centre, map.scale, map.rotationDeg, map.sizeMm, map.marker]);
}

const cache = new Map<string, { key: string; job: MapJob }>();

/** Forgets every cached thumbnail (tests, or a different project). */
export function clearThumbCache(): void {
  cache.clear();
}

/** Draws a map job (mm, y down) centred in a w × h box, on its paper colour. */
export function drawThumb(ctx: CanvasRenderingContext2D, job: MapJob, style: ProjectStyle, w: number, h: number): void {
  ctx.clearRect(0, 0, w, h);
  const { width, height } = job.sizeMm;
  if (width <= 0 || height <= 0) return;
  const k = Math.min((w - 2 * MARGIN_PX) / width, (h - 2 * MARGIN_PX) / height);
  if (!(k > 0)) return;
  const ox = (w - width * k) / 2;
  const oy = (h - height * k) / 2;
  ctx.save();
  ctx.fillStyle = paperColour(style);
  ctx.fillRect(ox, oy, width * k, height * k);
  ctx.beginPath();
  ctx.rect(ox, oy, width * k, height * k);
  ctx.clip();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  const layers = [...job.layers].sort((a, b) => a.style.order - b.style.order);
  for (const layer of layers) {
    const s = layer.style;
    if (!s.visible) continue;
    if (layer.kind === "point") {
      const r = Math.max(0.8, s.pointRadiusPt * PT_MM * k);
      ctx.beginPath();
      for (const f of layer.features) {
        const p = f.paths[0];
        if (!p || p.length < 2) continue;
        ctx.moveTo(ox + p[0]! * k + r, oy + p[1]! * k);
        ctx.arc(ox + p[0]! * k, oy + p[1]! * k, r, 0, Math.PI * 2);
      }
      if (s.fill) { ctx.fillStyle = s.fill; ctx.fill(); }
      if (s.stroke && s.strokePt > 0) { ctx.strokeStyle = s.stroke; ctx.lineWidth = Math.max(0.4, s.strokePt * PT_MM * k); ctx.stroke(); }
      continue;
    }
    const lw = Math.max(0.4, s.strokePt * PT_MM * k);
    for (const f of layer.features) {
      ctx.beginPath();
      for (const path of f.paths) {
        for (let i = 0; i + 1 < path.length; i += 2) {
          const x = ox + path[i]! * k;
          const y = oy + path[i + 1]! * k;
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        if (layer.kind === "polygon" || f.closed) ctx.closePath();
      }
      if (layer.kind === "polygon" && s.fill) { ctx.fillStyle = s.fill; ctx.fill("evenodd"); }
      if (s.stroke && s.strokePt > 0) { ctx.strokeStyle = s.stroke; ctx.lineWidth = lw; ctx.stroke(); }
    }
  }

  if (job.marker) {
    const m = job.marker;
    const r = Math.max(2, 2.5 * k);
    ctx.beginPath();
    ctx.arc(ox + m.x * k, oy + m.y * k, r, 0, Math.PI * 2);
    ctx.fillStyle = m.style.dot;
    ctx.fill();
    ctx.strokeStyle = m.style.ring;
    ctx.lineWidth = Math.max(1, r / 3);
    ctx.stroke();
  }
  ctx.restore();
}

function Thumb({ project, map }: { project: Project; map: MapSpec }) {
  const { counts } = useApp();
  const key = thumbKey(project, map, counts);
  const hit = cache.get(map.id);
  const [job, setJob] = useState<MapJob | null>(hit?.key === key ? hit.job : null);
  const [failed, setFailed] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const cached = cache.get(map.id);
    if (cached?.key === key) { setJob(cached.job); return; }
    let alive = true;
    // The old picture is out of date: don't leave it up while (or if) the new one fails.
    setJob(null);
    setFailed(false);
    api.mapPreview(map.id).then((j) => {
      cache.set(map.id, { key, job: j });
      if (alive) setJob(j);
    }, () => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [map.id, key]);

  useEffect(() => {
    const cv = canvas.current;
    if (!cv || !job) return;
    const paint = () => {
      const box = cv.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      cv.width = Math.max(1, Math.round(box.width * dpr));
      cv.height = Math.max(1, Math.round(box.height * dpr));
      const ctx = cv.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawThumb(ctx, job, project.style, box.width, box.height);
    };
    paint();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(paint);
    ro.observe(cv);
    return () => ro.disconnect();
  }, [job, project.style]);

  return (
    <div className="thumb">
      <canvas ref={canvas} aria-hidden="true" />
      {!job && <span className="thumb-note">{failed ? "No preview" : "Drawing…"}</span>}
    </div>
  );
}

export interface GalleryProps {
  /** Selects a map (Shift/Ctrl adds to the selection). */
  onSelect(id: string, additive: boolean): void;
}

export function Gallery({ onSelect }: GalleryProps) {
  const { project, statuses, targets, selectedMapIds } = useApp();
  const [picking, setPicking] = useState<string | null>(null);
  if (!project) return null;
  if (!project.maps.length) {
    return <div className="empty"><div><h1>No maps yet</h1><p>Choose + Add map, then click the map where it goes.</p></div></div>;
  }
  return (
    <div className="gallery">
      {project.maps.map((m, i) => {
        const status = badgeFor(m, statuses[m.id]);
        const selected = selectedMapIds.includes(m.id);
        return (
          <article key={m.id} aria-label={m.name} className={`gallery-card${selected ? " is-selected" : ""}`}
            onClick={(e) => onSelect(m.id, e.shiftKey || e.ctrlKey || e.metaKey)}>
            <Thumb project={project} map={m} />
            <div className="gallery-card-text">
              <div className="gallery-card-name"><span className="map-number">{i + 1}</span><strong>{m.name}</strong></div>
              <div className="muted gallery-card-target">{targetLine(m, targets, project.id)}</div>
              <div className="gallery-card-foot">
                <StatusBadge status={status} />
                {(status === "Target not open" || !m.target) && (
                  <button type="button" className="btn btn-small" aria-expanded={picking === m.id}
                    onClick={(e) => { e.stopPropagation(); setPicking(picking === m.id ? null : m.id); }}>
                    {m.target ? "Change document…" : "Choose document…"}
                  </button>
                )}
              </div>
              {picking === m.id && (
                <div className="gallery-card-picker" onClick={(e) => e.stopPropagation()}>
                  <TargetPicker map={m} compact />
                </div>
              )}
            </div>
          </article>
        );
      })}
    </div>
  );
}
