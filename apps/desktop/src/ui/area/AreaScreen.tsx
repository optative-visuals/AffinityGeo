// The Area screen: the place and its data (refresh), where each kind of data comes from, and the projection.
import { useEffect, useId, useState } from "react";
import { ROLE_IDS, ROLE_LABELS, areaKm2, type RoleId } from "@affinitygeo/geo-core/view";
import { api, type ProjectionOption } from "../api.js";
import { confirm } from "../shell/Confirm.js";
import { Section } from "../shell/Inspector.js";
import { Shell } from "../shell/Shell.js";
import { toast } from "../shell/Toast.js";
import type { TopBarProps } from "../shell/TopBar.js";
import { getActions, useApp } from "../store.js";
import { formatKm2 } from "./BoxEditor.js";
import { FetchPanel, useFetchData } from "./fetch.js";
import { platform } from "../platform.js";
import { MapCanvas } from "../map/MapCanvas.js";
import { useAreaPreview } from "../map/useAreaPreview.js";

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
      const n = counts?.[role];
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

function AreaDetails() {
  const { project } = useApp();
  const fetcher = useFetchData();
  if (!project) return null;
  const { state, seconds } = fetcher;
  const busy = state.status === "busy";
  const changes = state.status === "done"
    ? ROLE_IDS.filter((r) => state.changed[r]).map((r) => {
      const c = state.changed[r]!;
      return `${ROLE_LABELS[r]} ${fmtCount(c.before)} → ${fmtCount(c.after)}`;
    })
    : [];

  return (
    <Section chip="Area">
      <div className="area-head">
        <div>
          <div className="area-place">{project.area.placeName}</div>
          <div className="muted" data-testid="area-size">{formatKm2(areaKm2(project.area.bboxWgs84))}</div>
        </div>
        <button type="button" className="btn" disabled={busy} onClick={() => { void fetcher.run(); }}>Refresh data</button>
      </div>
      <p className="help">Fetches the latest OpenStreetMap data for this area. Data from files is kept as it is.</p>
      {busy && <FetchPanel seconds={seconds} />}
      {state.status === "error" && <p className="help help-bad" role="alert">{state.message}</p>}
      {state.status === "done" && (changes.length === 0
        ? <p className="muted">Nothing changed</p>
        : <ul className="change-list" aria-label="Changes">{changes.map((c) => <li key={c}>{c}</li>)}</ul>)}
    </Section>
  );
}

export interface AreaScreenProps {
  topBar: TopBarProps;
}

const none = () => undefined;

/** The area map beside the settings: pan and zoom, with the map frames shown but not editable here. */
function AreaMap() {
  useAreaPreview();
  const { project, preview } = useApp();
  if (!project) return null;
  return (
    <div className="area-preview">
      <MapCanvas preview={preview.data ?? null} style={project.style} maps={project.maps} selectedIds={[]} mode="browse" readOnly
        onSelect={none} onAdd={none} onMove={none} onRotate={none} onPick={none} />
      {preview.status === "none" && <div className="map-canvas-note">No map data yet. Choose Refresh data to fetch it.</div>}
      {preview.status === "loading" && <div className="map-canvas-note">Loading the map…</div>}
    </div>
  );
}

export function AreaScreen({ topBar }: AreaScreenProps) {
  return (
    <Shell topBar={topBar}>
      <div className="area-screen">
        <div className="area-page">
          <AreaDetails />
          <Sources />
          <ProjectionChoice />
        </div>
        <AreaMap />
      </div>
    </Shell>
  );
}
