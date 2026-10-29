// The new-project dialog: search for a place, adjust the box, name it, pick a look, then create and fetch the data.
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import type { PlaceResult } from "@affinitygeo/geo-core";
import { MAX_KM2, areaKm2, type Bbox } from "@affinitygeo/geo-core/view";
import { api } from "../api.js";
import { closeSummary } from "../maps/SendSummary.js";
import { toast } from "../shell/Toast.js";
import { getActions } from "../store.js";
import { BoxEditor, initialBox } from "./BoxEditor.js";
import { FetchPanel, useFetchData } from "./fetch.js";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const SEARCH_DEBOUNCE_MS = 400;
/** Nominatim's usage policy: at most one request a second. */
export const SEARCH_MIN_GAP_MS = 1000;
let lastSearchAt = -Infinity;
/** Forgets the last search time (tests). */
export function resetSearchClock(): void {
  lastSearchAt = -Infinity;
}

// ---- opening the dialog from anywhere ----

let open = false;
const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

export function openNewProject(): void {
  open = true;
  emit();
}

/** Mounted once by App: shows the dialog while it is open. */
export function NewProjectHost() {
  const isOpen = useSyncExternalStore(subscribe, () => open, () => open);
  if (!isOpen) return null;
  return <NewProject onClose={() => { open = false; emit(); }} />;
}

/** The place's first name part, e.g. "Hyde Park" from "Hyde Park, London, England". */
const firstPart = (name: string) => name.split(",")[0]!.trim() || name;

export interface NewProjectProps {
  onClose(): void;
}

export function NewProject({ onClose }: NewProjectProps) {
  const titleId = useId();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PlaceResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [place, setPlace] = useState<PlaceResult | null>(null);
  const [bbox, setBbox] = useState<Bbox | null>(null);
  const [name, setName] = useState("");
  const [presets, setPresets] = useState<string[]>([]);
  const [preset, setPreset] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [created, setCreated] = useState(false);
  const fetcher = useFetchData();
  const seq = useRef(0);

  // Search: wait for 400 ms of quiet, and never closer than a second to the previous request.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { seq.current += 1; setResults(null); setSearching(false); setSearchError(null); return; }
    const wait = Math.max(SEARCH_DEBOUNCE_MS, lastSearchAt + SEARCH_MIN_GAP_MS - Date.now());
    const timer = setTimeout(() => {
      lastSearchAt = Date.now();
      const mine = ++seq.current;
      setSearching(true);
      setSearchError(null);
      api.places(q).then(
        (r) => { if (mine === seq.current) { setResults(r); setSearching(false); } },
        (e) => { if (mine === seq.current) { setResults([]); setSearchError(message(e)); setSearching(false); } },
      );
    }, wait);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    api.presets().then(
      (list) => { const names = list.map((p) => p.name); setPresets(names); setPreset((p) => p ?? names[0] ?? null); },
      (e) => toast(message(e), "error"),
    );
  }, []);

  const working = creating || fetcher.state.status === "busy";

  useEffect(() => {
    if (working) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [working, onClose]);

  function choose(p: PlaceResult): void {
    setPlace(p);
    setBbox(initialBox(p));
    setName(firstPart(p.name));
    setCreateError(null);
  }

  const tooBig = bbox ? areaKm2(bbox) > MAX_KM2 : false;

  async function fetchData(): Promise<void> {
    if (await fetcher.run()) onClose();
  }

  async function create(): Promise<void> {
    if (!place || !bbox || !preset) return;
    setCreating(true);
    setCreateError(null);
    try {
      const project = await api.newProject(name.trim() || firstPart(place.name), { placeName: place.name, bboxWgs84: bbox }, preset);
      // A different project: the old project's send summary no longer applies.
      closeSummary();
      setCreated(true);
      const actions = getActions();
      await actions.refreshProject().catch(() => undefined); // the fetch below reads it again
      void actions.refreshStatuses().catch(() => undefined); // the new project's badges, without waiting 5 s
      actions.setScreen("area");
      if (project.warning) toast(project.warning, "info");
    } catch (e) {
      setCreateError(message(e));
      setCreating(false);
      return;
    }
    setCreating(false);
    await fetchData();
  }

  const failed = fetcher.state.status === "error";

  return (
    <div className="overlay">
      <div className="dialog dialog-wide" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h2 id={titleId} className="dialog-title">New project</h2>

        {!created && !place && (
          <div className="new-step">
            <div className="field">
              <label className="field-label" htmlFor={`${titleId}-search`}>Search for a place</label>
              <input id={`${titleId}-search`} type="search" autoFocus value={query} onChange={(e) => setQuery(e.target.value)}
                placeholder="For example: Hyde Park, London" />
              <span className="help">Type a town, a campus or a street. The map is drawn from OpenStreetMap.</span>
            </div>
            {searching && <p className="muted">Searching…</p>}
            {searchError && <p className="help help-bad" role="alert">{searchError}</p>}
            {results && results.length > 0 && (
              <ul className="place-list" aria-label="Places">
                {results.map((r, i) => (
                  <li key={`${i}-${r.name}`}>
                    <button type="button" className="place-item" onClick={() => choose(r)}>
                      <strong>{firstPart(r.name)}</strong>
                      <span className="muted">{r.name.slice(firstPart(r.name).length).replace(/^,\s*/, "")}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {results && results.length === 0 && !searching && !searchError && <p className="muted">No places found.</p>}
            <div className="dialog-buttons">
              <button type="button" className="btn" onClick={onClose}>Cancel</button>
            </div>
          </div>
        )}

        {place && bbox && !created && (
          <div className="new-step">
            <div className="new-place">
              <strong>{firstPart(place.name)}</strong>
              <button type="button" className="btn btn-small" disabled={working} onClick={() => setPlace(null)}>Search again</button>
            </div>
            <BoxEditor place={place} bbox={bbox} onChange={setBbox} />
            <p className="help">Drag an edge to resize the area, or drag inside the box to move it.</p>
            <div className="field">
              <label className="field-label" htmlFor={`${titleId}-name`}>Project name</label>
              <input id={`${titleId}-name`} type="text" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="field">
              <span className="field-label" id={`${titleId}-preset`}>Look</span>
              <div className="preset-strip" role="group" aria-labelledby={`${titleId}-preset`}>
                {presets.map((p) => (
                  <button key={p} type="button" aria-pressed={p === preset}
                    className={`preset${p === preset ? " is-selected" : ""}`} onClick={() => setPreset(p)}>{p}</button>
                ))}
              </div>
              <span className="help">You can change the colours and line weights later on the Style screen.</span>
            </div>
            {createError && <p className="help help-bad" role="alert">{createError}</p>}
            <div className="dialog-buttons">
              <button type="button" className="btn" disabled={working} onClick={onClose}>Cancel</button>
              <button type="button" className="btn btn-primary" disabled={working || tooBig || !preset}
                onClick={() => { void create(); }}>Create and fetch data</button>
            </div>
          </div>
        )}

        {created && (
          <div className="new-step">
            {fetcher.state.status === "busy" && <FetchPanel seconds={fetcher.seconds} />}
            {creating && <p className="muted">Creating the project…</p>}
            {failed && (
              <>
                <p>The project was created, but no data has been fetched yet.</p>
                <p className="help help-bad" role="alert">{fetcher.state.status === "error" ? fetcher.state.message : ""}</p>
                <div className="dialog-buttons">
                  <button type="button" className="btn" onClick={onClose}>Close</button>
                  <button type="button" className="btn btn-primary" onClick={() => { void fetchData(); }}>Try again</button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
