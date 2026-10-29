// The Style screen: preset cards, the background (paper) colour, one row per map layer (fill, stroke, width, eye, order),
// the marker, and a live preview.
// Edits are optimistic: the local style changes at once (the preview redraws from it) and the PATCH follows 250 ms later.
import { useEffect, useMemo, useRef, useState } from "react";
import {
  PRESETS, PRESET_PAPER, ROLE_IDS, ROLE_LABELS, mapFrameCorners, type AreaSpec, type MapSpec, type ProjectStyle, type RoleId,
} from "@affinitygeo/geo-core/view";
import { api } from "../api.js";
import { MapCanvas } from "../map/MapCanvas.js";
import { useAreaPreview } from "../map/useAreaPreview.js";
import { confirm } from "../shell/Confirm.js";
import { Section } from "../shell/Inspector.js";
import { Shell } from "../shell/Shell.js";
import { toast } from "../shell/Toast.js";
import type { TopBarProps } from "../shell/TopBar.js";
import { getActions, getApp, registerPendingEdit, setApp, useApp } from "../store.js";

export const STYLE_DEBOUNCE_MS = 250;
/** The preview's margin around a map's frame, as a share of the frame's longer side. */
export const FOCUS_PAD = 0.1;

type Roles = ProjectStyle["roles"];
type RoleStyle = Roles[RoleId];
type MarkerStyle = ProjectStyle["marker"];
type Patch = { roles?: Partial<Record<RoleId, Partial<RoleStyle>>>; marker?: Partial<MarkerStyle>; paper?: string };

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const FALLBACK_COLOUR = "#808080";

/** Writes the values in `patch` over a copy of a style. Used to apply an edit and to put old values back. */
function overlay(style: ProjectStyle, patch: Patch): ProjectStyle {
  const next = structuredClone(style);
  for (const [role, fields] of Object.entries(patch.roles ?? {})) Object.assign(next.roles[role as RoleId], fields);
  if (patch.marker) Object.assign(next.marker, patch.marker);
  if (patch.paper !== undefined) next.paper = patch.paper;
  return next;
}

interface Bucket { patch: Patch; timer: number }

/** The local style and the debounced, optimistic edits that change it. */
function useStyleEditing(serverStyle: ProjectStyle) {
  const [style, setStyle] = useState(serverStyle);
  const styleRef = useRef(style);
  const buckets = useRef(new Map<string, Bucket>());
  const inflight = useRef(0);
  const live = useRef(true);

  const put = (s: ProjectStyle) => { styleRef.current = s; setStyle(s); };
  const idle = () => buckets.current.size === 0 && inflight.current === 0;

  function mergedPending(): Patch {
    const out: Patch = {};
    for (const b of buckets.current.values()) {
      for (const [r, f] of Object.entries(b.patch.roles ?? {})) out.roles = { ...out.roles, [r]: { ...out.roles?.[r as RoleId], ...f } };
      if (b.patch.marker) out.marker = { ...out.marker, ...b.patch.marker };
      if (b.patch.paper !== undefined) out.paper = b.patch.paper;
    }
    return out;
  }

  async function send(patch: Patch): Promise<void> {
    inflight.current++;
    try {
      const returned = await api.updateStyle(patch);
      inflight.current--;
      const p = getApp().project;
      if (p) setApp({ project: { ...p, style: returned } });
      if (live.current && idle()) put(returned);
      void getActions().refreshProject().catch(() => undefined); // the dirty flag
    } catch (e) {
      inflight.current--;
      // Rebuild from the server's style plus the edits still waiting, so a newer edit stays and a refused value never returns.
      if (live.current) put(overlay(getApp().project?.style ?? styleRef.current, mergedPending()));
      toast(message(e), "error");
    }
  }

  // Follow the server's style (a preset, another change) while nothing of ours is outstanding.
  useEffect(() => { if (idle()) put(serverStyle); }, [serverStyle]);
  useEffect(() => {
    live.current = true;
    /** Sends every edit still waiting for its debounce, now. */
    const sendWaiting = () => {
      const sends = [...buckets.current.values()].map((b) => { window.clearTimeout(b.timer); return send(b.patch); });
      buckets.current.clear();
      return Promise.all(sends).then(() => undefined);
    };
    // The close guard and New/Open send waiting edits before deciding whether anything is unsaved.
    const unregister = registerPendingEdit(sendWaiting);
    return () => {
      live.current = false;
      unregister();
      // Leaving the screen: send what's waiting rather than lose it.
      void sendWaiting();
    };
    // Registered once for the life of the screen; `send` is read through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function flush(key: string): void {
    const b = buckets.current.get(key);
    if (!b) return;
    buckets.current.delete(key);
    void send(b.patch);
  }

  /** Applies `fields` to a role (or the marker) now, and sends them once the debounce settles. */
  function edit(target: RoleId | "marker", fields: Partial<RoleStyle> | Partial<MarkerStyle>): void {
    const cur = styleRef.current;
    const bucket = buckets.current.get(target) ?? { patch: {}, timer: 0 };
    const patchFields = ((target === "marker" ? bucket.patch.marker : bucket.patch.roles?.[target]) ?? {}) as Record<string, unknown>;
    Object.assign(patchFields, fields);
    if (target === "marker") {
      bucket.patch.marker = patchFields as Partial<MarkerStyle>;
    } else {
      bucket.patch.roles = { ...bucket.patch.roles, [target]: patchFields as Partial<RoleStyle> };
    }
    window.clearTimeout(bucket.timer);
    bucket.timer = window.setTimeout(() => flush(target), STYLE_DEBOUNCE_MS);
    buckets.current.set(target, bucket);
    put(overlay(cur, target === "marker" ? { marker: fields as Partial<MarkerStyle> } : { roles: { [target]: fields as Partial<RoleStyle> } }));
  }

  /** Sets the background (paper) colour now, and sends it once the debounce settles. */
  function editPaper(paper: string): void {
    const bucket = buckets.current.get("paper") ?? { patch: {}, timer: 0 };
    bucket.patch.paper = paper;
    window.clearTimeout(bucket.timer);
    bucket.timer = window.setTimeout(() => flush("paper"), STYLE_DEBOUNCE_MS);
    buckets.current.set("paper", bucket);
    put(overlay(styleRef.current, { paper }));
  }

  /** Swaps two layers' stacking order: one patch with both. */
  function swap(a: RoleId, b: RoleId): void {
    const cur = styleRef.current;
    const oa = cur.roles[a].order;
    const ob = cur.roles[b].order;
    put(overlay(cur, { roles: { [a]: { order: ob }, [b]: { order: oa } } }));
    void send({ roles: { [a]: { order: ob }, [b]: { order: oa } } });
  }

  return { style, edit, editPaper, swap, replace: put };
}

function Eye({ off }: { off: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="2.8" />
      {off && <path d="M4 4l16 16" />}
    </svg>
  );
}

function Arrow({ up }: { up: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={up ? "M6 15l6-6 6 6" : "M6 9l6 6 6-6"} />
    </svg>
  );
}

/** A colour swatch with a ∅ toggle. "None" shows as an empty box with a red slash; clicking it brings the colour back. */
function ColourCell({ role, part, value, restoreTo, onChange }: {
  role: string; part: "fill" | "stroke"; value: string | null; restoreTo: string; onChange(v: string | null): void;
}) {
  return (
    <div className="colour-cell">
      {value === null ? (
        <button type="button" className="swatch-none" data-testid={`${role} ${part}-none`} aria-label={`Choose a ${part} colour for ${role}`}
          onClick={() => onChange(restoreTo)} />
      ) : (
        <input type="color" aria-label={`${role} ${part}`} value={value} onChange={(e) => onChange(e.target.value)} />
      )}
      <button type="button" className="icon-btn none-toggle" aria-pressed={value === null} aria-label={`No ${part} for ${role}`}
        title={part === "fill" ? "No fill" : "No stroke"} onClick={() => onChange(value === null ? restoreTo : null)}>∅</button>
    </div>
  );
}

function PresetStrip({ names, current, onChoose }: { names: string[]; current: string; onChoose(name: string): void }) {
  return (
    <div className="preset-strip" role="group" aria-label="Presets">
      {names.map((name) => {
        const p = PRESETS.find((x) => x.presetName === name);
        const swatches = p
          ? [PRESET_PAPER[name], p.roles.water.fill, p.roles.green.fill, p.roles.buildings.fill, p.roles.mainRoads.stroke, p.roles.paths.stroke]
          : [];
        return (
          <button key={name} type="button" className={`preset-card${name === current ? " is-current" : ""}`}
            aria-pressed={name === current} onClick={() => onChoose(name)}>
            <span className="preset-swatches" aria-hidden="true">
              {swatches.map((c, i) => <span key={i} style={{ background: c ?? "transparent" }} />)}
            </span>
            <span className="preset-name">{name}</span>
          </button>
        );
      })}
    </div>
  );
}

/** The world box to fit for one map: its frame plus FOCUS_PAD. */
export function focusBox(area: AreaSpec, map: MapSpec): [number, number, number, number] | undefined {
  try {
    const c = mapFrameCorners(area, map);
    const xs = c.map((q) => q[0]);
    const ys = c.map((q) => q[1]);
    const pad = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) * FOCUS_PAD;
    return [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad];
  } catch { return undefined; }
}

export interface StyleScreenProps {
  /** The project buttons and Send from App. */
  topBar?: TopBarProps;
}

export function StyleScreen({ topBar }: StyleScreenProps) {
  useAreaPreview();
  const { project, preview, selectedMapIds, select } = useApp();
  const { style, edit, editPaper, swap, replace } = useStyleEditing(project!.style);
  const [names, setNames] = useState<string[]>([]);
  const remembered = useRef<Record<string, string>>({});

  useEffect(() => {
    let gone = false;
    api.presets().then((l) => { if (!gone) setNames(l.map((p) => p.name)); }, (e) => toast(message(e), "error"));
    return () => { gone = true; };
  }, []);

  async function choosePreset(name: string): Promise<void> {
    if (name === style.presetName) return;
    const answer = await confirm({
      title: `Replace your style tweaks with '${name}'?`,
      body: "Every colour, width and setting on this screen goes back to the preset.",
      buttons: ["Cancel", { label: "Replace", kind: "primary" }],
    });
    if (answer !== "Replace") return;
    try {
      const next = await api.applyPreset(name);
      const p = getApp().project;
      if (p) setApp({ project: { ...p, style: next } });
      replace(next);
      void getActions().refreshProject().catch(() => undefined);
    } catch (e) {
      toast(message(e), "error");
    }
  }

  // The selected map's frame, as a world box to fit; the whole area when nothing is selected.
  const maps = project?.maps ?? [];
  const focusMap = maps.find((m) => selectedMapIds.includes(m.id));
  const area = project?.area;
  const focus = useMemo(() => {
    if (!area || !focusMap) return undefined;
    return focusBox(area, focusMap);
  }, [area, focusMap]);

  const order = ROLE_IDS.slice().sort((a, b) => style.roles[b].order - style.roles[a].order);
  for (const id of ROLE_IDS) {
    const r = style.roles[id];
    if (r.fill) remembered.current[`${id}:fill`] = r.fill;
    if (r.stroke) remembered.current[`${id}:stroke`] = r.stroke;
  }

  /** The colour a "none" goes back to: the last one shown, else the preset's, else grey. */
  function restoreFor(id: RoleId, part: "fill" | "stroke"): string {
    const preset = PRESETS.find((p) => p.presetName === style.presetName)?.roles[id][part];
    return remembered.current[`${id}:${part}`] ?? preset ?? FALLBACK_COLOUR;
  }

  return (
    <Shell topBar={topBar}>
      <div className="style-screen">
        <div className="style-panel">
          <Section chip="Presets">
            <PresetStrip names={names} current={style.presetName} onChoose={(n) => { void choosePreset(n); }} />
          </Section>
          <Section chip="Background">
            <label className="field paper-field">
              <span className="field-label">Background colour</span>
              <input type="color" aria-label="Background colour" aria-describedby="paper-help" value={style.paper ?? "#ffffff"} onChange={(e) => editPaper(e.target.value)} />
              <span id="paper-help" className="field-help">Fills each map's frame, under every layer.</span>
            </label>
          </Section>
          <Section chip="Layers">
            <div className="role-rows" role="list">
              <div className="role-head" aria-hidden="true">
                <span>Layer</span><span>Fill</span><span>Stroke</span><span>Width (pt)</span><span /><span />
              </div>
              {order.map((id, i) => {
                const r = style.roles[id];
                const label = ROLE_LABELS[id];
                return (
                  <div key={id} className={`role-row${r.visible ? "" : " is-hidden"}`} role="listitem">
                    <span className="role-label">{label}</span>
                    <ColourCell role={label} part="fill" value={r.fill} restoreTo={restoreFor(id, "fill")}
                      onChange={(fill) => edit(id, { fill })} />
                    <ColourCell role={label} part="stroke" value={r.stroke} restoreTo={restoreFor(id, "stroke")}
                      onChange={(stroke) => edit(id, { stroke })} />
                    <input type="number" className="width-input" aria-label={`${label} width`} min={0} max={20} step={0.1} value={r.strokePt}
                      onChange={(e) => {
                        const n = e.target.valueAsNumber;
                        if (Number.isFinite(n)) edit(id, { strokePt: Math.round(Math.min(20, Math.max(0, n)) * 10) / 10 });
                      }} />
                    <button type="button" className="icon-btn" aria-label={`${r.visible ? "Hide" : "Show"} ${label}`} aria-pressed={r.visible}
                      title={r.visible ? "Hide" : "Show"} onClick={() => edit(id, { visible: !r.visible })}>
                      <Eye off={!r.visible} />
                    </button>
                    <span className="role-order">
                      <button type="button" className="icon-btn" aria-label={`Move ${label} up`} title="Bring forward" disabled={i === 0}
                        onClick={() => swap(id, order[i - 1]!)}><Arrow up /></button>
                      <button type="button" className="icon-btn" aria-label={`Move ${label} down`} title="Send back" disabled={i === order.length - 1}
                        onClick={() => swap(id, order[i + 1]!)}><Arrow up={false} /></button>
                    </span>
                  </div>
                );
              })}
            </div>
          </Section>
          <Section chip="Marker">
            <div className="marker-grid">
              {(["dot", "ring", "text"] as const).map((k) => (
                <label key={k} className="field">
                  <span className="field-label">{k === "dot" ? "Dot" : k === "ring" ? "Ring" : "Text"} colour</span>
                  <input type="color" aria-label={`Marker ${k}`} value={style.marker[k]} onChange={(e) => edit("marker", { [k]: e.target.value })} />
                </label>
              ))}
              <label className="field">
                <span className="field-label">Text size (pt)</span>
                <input type="number" aria-label="Marker text size" min={1} max={200} step={0.5} value={style.marker.textPt}
                  onChange={(e) => { const n = e.target.valueAsNumber; if (Number.isFinite(n) && n > 0) edit("marker", { textPt: n }); }} />
              </label>
              <label className="field marker-label">
                <span className="field-label">Label</span>
                <input type="text" aria-label="Marker label" value={style.marker.label} onChange={(e) => edit("marker", { label: e.target.value })} />
              </label>
            </div>
          </Section>
        </div>
        <div className="style-preview">
          <MapCanvas
            preview={preview.data ?? null} style={style} maps={maps} selectedIds={selectedMapIds} mode="browse" focus={focus}
            onSelect={select} onAdd={() => undefined} onMove={() => undefined} onRotate={() => undefined} onPick={() => undefined}
          />
          {preview.status === "none" && <div className="map-canvas-note">No map data yet. Fetch it on the Area screen.</div>}
          {preview.status === "loading" && <div className="map-canvas-note">Loading the map…</div>}
        </div>
      </div>
    </Shell>
  );
}
