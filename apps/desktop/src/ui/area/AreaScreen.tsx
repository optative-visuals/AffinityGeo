// The Area screen: the project's locations (each a box or shape with its own data), where each kind of data comes
// from, and the projection. The selected location is edited on the street map beside the settings.
import { useEffect, useId, useRef, useState } from "react";
import type { LocationSpec, MapSpec } from "@affinitygeo/geo-core";
import { CONTEXT_DEFAULT_M, ROLE_IDS, ROLE_LABELS, boxRing, ringAreaKm2, ringBbox, type RoleId } from "@affinitygeo/geo-core/view";
import { api, type ProjectionOption } from "../api.js";
import { confirm } from "../shell/Confirm.js";
import { TextField } from "../shell/fields.js";
import { Section } from "../shell/Inspector.js";
import { Shell } from "../shell/Shell.js";
import { toast } from "../shell/Toast.js";
import type { TopBarProps } from "../shell/TopBar.js";
import { getActions, getApp, registerPendingEdit, useApp } from "../store.js";
import { AreaEditor, areaError, formatKm2, squareAround, type AreaValue } from "./AreaEditor.js";
import { FetchPanel, useFetchData, type FetchState } from "./fetch.js";
import { platform } from "../platform.js";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const fmtCount = (n: number) => n.toLocaleString("en-GB");
const fileName = (path: string) => path.split(/[\\/]/).pop() || path;

/** Asks which kind of data a file holds. Resolves to the role, or null on Cancel. */
function RolePicker({ file, initialRole, onDone }: { file: string; initialRole: RoleId; onDone(role: RoleId | null): void }) {
  const titleId = useId();
  const [role, setRole] = useState<RoleId | null>(initialRole);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(): Promise<void> {
    if (!role) return;
    setBusy(true);
    setError(null);
    try {
      const { counts } = await api.importFile(file, role);
      await getActions().refreshProject();
      // The reply counts the first location; the store has the selected one's.
      const n = (getApp().counts ?? counts)?.[role];
      toast(n === undefined ? `Imported ${fileName(file)}.` : `Imported ${fileName(file)}: ${fmtCount(n)} objects.`, "success");
      onDone(role);
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  }

  useEffect(() => {
    if (busy) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onDone(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onDone]);

  return (
    <div className="overlay">
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h2 id={titleId} className="dialog-title">Which data is this file?</h2>
        <div className="dialog-body">
          <p>{fileName(file)} will replace the OpenStreetMap data for the kind you choose.</p>
          <div className="role-options" role="radiogroup" aria-label="Kind of data">
            {ROLE_IDS.map((id) => (
              <label key={id} className="radio-row">
                <input type="radio" name="role" checked={role === id} onChange={() => setRole(id)} />
                <span>{ROLE_LABELS[id]}</span>
              </label>
            ))}
          </div>
          {error && <p className="help help-bad" role="alert">{error}</p>}
        </div>
        <div className="dialog-buttons">
          <button type="button" className="btn" disabled={busy} onClick={() => onDone(null)}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={!role || busy} onClick={() => { void run(); }}>Import</button>
        </div>
      </div>
    </div>
  );
}

function Sources() {
  const { project, counts } = useApp();
  const [pick, setPick] = useState<{ file: string; role: RoleId } | null>(null);
  if (!project) return null;

  async function chooseFile(role: RoleId): Promise<void> {
    try {
      const path = await platform.openDataFile();
      if (path) setPick({ file: path, role });
    } catch (e) {
      toast(message(e), "error");
    }
  }

  async function switchToOsm(role: RoleId): Promise<void> {
    try {
      await api.setSource(role, { kind: "osm" });
      await getActions().refreshProject();
    } catch (e) {
      toast(message(e), "error");
    }
  }

  return (
    <Section chip="Sources">
      <ul className="source-list" aria-label="Sources">
        {ROLE_IDS.map((role) => {
          const src = project.sources[role];
          const isFile = src?.kind === "file";
          return (
            <li key={role} className="source-row" aria-label={ROLE_LABELS[role]}>
              <span className="source-role">{ROLE_LABELS[role]}</span>
              <span className="source-name">{src?.kind === "file" ? fileName(src.path) : "OpenStreetMap"}</span>
              {counts && <span className="muted source-count">{fmtCount(counts[role] ?? 0)}</span>}
              <button type="button" className="btn btn-small" onClick={() => { void chooseFile(role); }}>Use a file…</button>
              {isFile && <button type="button" className="btn btn-small" onClick={() => { void switchToOsm(role); }}>Use OpenStreetMap</button>}
            </li>
          );
        })}
      </ul>
      <p className="help">Shapefile, GeoJSON, KML, GPX or CSV. A file replaces the OpenStreetMap data for that kind of data.</p>
      {pick && <RolePicker file={pick.file} initialRole={pick.role} onDone={() => setPick(null)} />}
    </Section>
  );
}

function ProjectionChoice() {
  const { project } = useApp();
  const [options, setOptions] = useState<ProjectionOption[]>([]);
  const dataVersion = project?.dataVersion;
  const current = project?.area.projectionId;

  useEffect(() => {
    let live = true;
    api.projections().then((list) => { if (live) setOptions(list); }, (e) => toast(message(e), "error"));
    return () => { live = false; };
  }, [project?.id, dataVersion, current]);

  async function choose(option: ProjectionOption): Promise<void> {
    if (option.id === current) return;
    const answer = await confirm({
      title: "Change projection?",
      body: "Changing the projection changes every map. Sent maps will show 'Changed since sent'.",
      buttons: ["Cancel", { label: "Change projection", kind: "primary" }],
    });
    if (answer !== "Change projection") return;
    try {
      await api.setArea(option.id, option.params);
      await getActions().refreshProject();
      toast(`Projection changed to ${option.name}.`, "success");
    } catch (e) {
      toast(message(e), "error");
    }
  }

  return (
    <Section chip="Projection">
      <p className="help">A projection flattens the curved Earth onto a page. Pick the one that suits where your map is.</p>
      <div className="projection-list" role="radiogroup" aria-label="Projection">
        {options.map((o) => (
          <label key={o.id} className="radio-row radio-block">
            <input type="radio" name="projection" checked={o.id === current} onChange={() => { void choose(o); }} />
            <span className="radio-text">
              <span className="radio-title">
                {o.name}
                {o.suggested && <span className="chip">Suggested</span>}
              </span>
              <span className="help">{o.description}</span>
            </span>
          </label>
        ))}
      </div>
    </Section>
  );
}

const fmtDay = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
const mapsLabel = (n: number) => (n === 0 ? "No maps" : n === 1 ? "1 map" : `${n} maps`);
const valueOf = (l: LocationSpec): AreaValue => ({ kind: l.kind, ring: l.ring, contextM: l.contextM });

/** A changed shape or context is saved after this pause. */
export const LOCATION_DEBOUNCE_MS = 400;
/** A new location starts as a box of about this size. */
const NEW_LOCATION_KM2 = 0.5;
export const CHANGED_NOTE = "Changed: refresh to fetch the new area";

/** Locations reshaped since their last fetch ("projectId:locationId"), kept while the person visits other screens. */
const changedSinceFetch = new Set<string>();

function LocationList({ locations, maps, selectedId, onSelect }: {
  locations: LocationSpec[]; maps: MapSpec[]; selectedId: string | null; onSelect(id: string): void;
}) {
  return (
    <ul className="location-list" aria-label="Locations">
      {locations.map((l) => {
        const count = maps.filter((m) => m.locationId === l.id).length;
        return (
          <li key={l.id}>
            <button type="button" className={`location-row${l.id === selectedId ? " is-selected" : ""}`}
              aria-pressed={l.id === selectedId} onClick={() => onSelect(l.id)}>
              <span className="location-name">{l.name}</span>
              <span className="muted location-meta">
                {formatKm2(ringAreaKm2(l.ring))} · {mapsLabel(count)} · {l.fetchedAt ? `Fetched ${fmtDay(l.fetchedAt)}` : "Not fetched"}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export interface AreaScreenProps {
  topBar: TopBarProps;
}

export function AreaScreen({ topBar }: AreaScreenProps) {
  const { project, selectedLocationId } = useApp();
  const fetcher = useFetchData();
  /** The location the fetch result on screen belongs to. */
  const [fetchedFor, setFetchedFor] = useState<string | null>(null);
  /** A new location being drawn, not saved yet. */
  const [adding, setAdding] = useState<AreaValue | null>(null);
  const [saving, setSaving] = useState(false);
  /** The selected location's shape while its change waits to be saved. */
  const [draft, setDraft] = useState<{ id: string; value: AreaValue } | null>(null);
  const [changed, setChanged] = useState(() => new Set(changedSinceFetch));
  const timer = useRef<number | undefined>(undefined);
  /** Saves the waiting change now; null when nothing waits. */
  const pending = useRef<(() => Promise<void>) | null>(null);
  const unregister = useRef<(() => void) | null>(null);

  function cancelPending(): void {
    window.clearTimeout(timer.current);
    pending.current = null;
    unregister.current?.();
    unregister.current = null;
  }
  const flushPending = () => pending.current?.() ?? Promise.resolve();

  // Leaving the screen saves a change still waiting.
  useEffect(() => () => { void pending.current?.(); }, []);

  const locations = project?.locations ?? [];
  const selected = locations.find((l) => l.id === selectedLocationId) ?? locations[0] ?? null;
  const keyOf = (id: string) => `${project?.id}:${id}`;

  function markChanged(id: string, on: boolean): void {
    if (on) changedSinceFetch.add(keyOf(id)); else changedSinceFetch.delete(keyOf(id));
    setChanged(new Set(changedSinceFetch));
  }

  function edit(v: AreaValue): void {
    if (adding) { setAdding(v); return; }
    if (!selected) return;
    const id = selected.id;
    setDraft({ id, value: v });
    markChanged(id, true);
    cancelPending();
    const save = async (): Promise<void> => {
      cancelPending();
      if (areaError(v)) return; // shown under the editor; the server would refuse it
      try {
        await api.patchLocation(id, v);
        await getActions().refreshProject();
      } catch (e) {
        toast(message(e), "error");
      }
      setDraft((d) => (d?.value === v ? null : d));
    };
    pending.current = save;
    // The close guard and New/Open save it before deciding whether anything is unsaved.
    unregister.current = registerPendingEdit(save);
    timer.current = window.setTimeout(() => { void save(); }, LOCATION_DEBOUNCE_MS);
  }

  function select(id: string): void {
    void flushPending();
    setAdding(null);
    getActions().selectLocation(id);
  }

  function startAdding(): void {
    if (!selected) return;
    void flushPending();
    // The editor is fitted to the selected location, so its centre is the view's centre.
    const [w, s, e, n] = ringBbox(selected.ring);
    setAdding({ kind: "box", ring: boxRing(squareAround([(w + e) / 2, (s + n) / 2], NEW_LOCATION_KM2)), contextM: CONTEXT_DEFAULT_M });
  }

  async function saveNew(): Promise<void> {
    if (!adding) return;
    setSaving(true);
    try {
      const created = await api.addLocation({ placeName: "", kind: adding.kind, ring: adding.ring, contextM: adding.contextM });
      await getActions().refreshProject();
      getActions().selectLocation(created.id);
      setAdding(null);
      if (created.warning) toast(created.warning, "info");
    } catch (e) {
      toast(message(e), "error");
    } finally {
      setSaving(false);
    }
  }

  async function refresh(): Promise<void> {
    if (!selected) return;
    const id = selected.id;
    await flushPending();
    setFetchedFor(id);
    if (await fetcher.run(id)) markChanged(id, false);
  }

  async function remove(): Promise<void> {
    if (!selected) return;
    const { id, name } = selected;
    const answer = await confirm({
      title: "Delete location?",
      body: `Delete '${name}' and its fetched data from this project?`,
      buttons: ["Cancel", { label: "Delete", kind: "danger" }],
    });
    if (answer !== "Delete") return;
    try {
      await api.deleteLocation(id);
    } catch (e) {
      toast(message(e), "error"); // maps still use it, or it is the last one
      return;
    }
    if (draft?.id === id) { cancelPending(); setDraft(null); }
    markChanged(id, false);
    try { await getActions().refreshProject(); } catch (e) { toast(message(e), "error"); }
  }

  const value = adding ?? (selected ? (draft?.id === selected.id ? draft.value : valueOf(selected)) : null);
  const others = locations.filter((l) => adding || l.id !== selected?.id).map((l) => ({ name: l.name, ring: l.ring }));
  const { state, seconds } = fetcher;
  const busy = state.status === "busy";
  const result: FetchState = fetchedFor === selected?.id ? state : { status: "idle" };
  const changes = result.status === "done"
    ? ROLE_IDS.filter((r) => result.changed[r]).map((r) => {
      const c = result.changed[r]!;
      return `${ROLE_LABELS[r]} ${fmtCount(c.before)} → ${fmtCount(c.after)}`;
    })
    : [];

  return (
    <Shell topBar={topBar}>
      <div className="area-screen">
        <div className="area-page">
          {project && (
            <Section chip="Locations">
              <LocationList locations={locations} maps={project.maps} selectedId={adding ? null : selected?.id ?? null} onSelect={select} />
              {adding ? (
                <div className="location-adding">
                  <p className="help">Drag the new box into place, or switch to Shape, then save it.</p>
                  <div className="location-buttons">
                    <button type="button" className="btn" disabled={saving} onClick={() => setAdding(null)}>Cancel</button>
                    <button type="button" className="btn btn-primary" disabled={saving || areaError(adding) !== null}
                      onClick={() => { void saveNew(); }}>Save location</button>
                  </div>
                </div>
              ) : (
                <button type="button" className="btn location-add" onClick={startAdding}>Add location</button>
              )}
            </Section>
          )}
          {selected && !adding && (
            <Section chip="Location">
              <TextField label="Name" value={selected.name}
                onCommit={async (name) => { await api.patchLocation(selected.id, { name }); await getActions().refreshProject(); }} />
              {changed.has(keyOf(selected.id)) && <p className="help help-warn">{CHANGED_NOTE}</p>}
              <div className="location-buttons">
                <button type="button" className="btn" disabled={busy || (value !== null && areaError(value) !== null)}
                  onClick={() => { void refresh(); }}>Refresh data</button>
                <button type="button" className="btn btn-danger" disabled={busy} onClick={() => { void remove(); }}>Delete location…</button>
              </div>
              <p className="help">Fetches the latest OpenStreetMap data for this location. Data from files is kept as it is.</p>
              {busy && fetchedFor === selected.id && <FetchPanel seconds={seconds} />}
              {result.status === "error" && <p className="help help-bad" role="alert">{result.message}</p>}
              {result.status === "done" && (changes.length === 0
                ? <p className="muted">Nothing changed</p>
                : <ul className="change-list" aria-label="Changes">{changes.map((c) => <li key={c}>{c}</li>)}</ul>)}
            </Section>
          )}
          <Sources />
          <ProjectionChoice />
        </div>
        <div className="area-preview area-stage">
          {value && (
            <AreaEditor value={value} onChange={edit} others={others}
              fitKey={adding ? `${project?.id}:new` : `${project?.id}:${selected?.id}`} />
          )}
        </div>
      </div>
    </Shell>
  );
}
