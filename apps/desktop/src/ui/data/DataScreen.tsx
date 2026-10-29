// The Data screen: a sortable, searchable, paged attribute table, a column picker, and "Select by attribute".
import { useEffect, useMemo, useRef, useState } from "react";
import { ROLE_IDS, ROLE_LABELS, type RoleId } from "@affinitygeo/geo-core/view";
import { ApiFail, api, isNotConnected, type FeatureRow } from "../api.js";
import { MapCanvas } from "../map/MapCanvas.js";
import { useAreaPreview } from "../map/useAreaPreview.js";
import { Section } from "../shell/Inspector.js";
import { Shell } from "../shell/Shell.js";
import { toast } from "../shell/Toast.js";
import type { TopBarProps } from "../shell/TopBar.js";
import { useApp } from "../store.js";

export const PAGE_SIZE = 100;
export const SEARCH_DEBOUNCE_MS = 300;
export const DEFAULT_COLUMNS = 6;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** Spaces to put the caret under UTF-16 index `position`: tabs are copied, each code point is one cell. */
export function pad(text: string, position: number): string {
  return [...text.slice(0, Math.max(0, position))].map((c) => (c === "\t" ? "\t" : " ")).join("");
}
const fmtCount =(n: number) => n.toLocaleString("en-GB");

function cell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(Math.round(v * 1000) / 1000);
  return String(v);
}

export interface DataScreenProps {
  /** The project buttons and Send from App. */
  topBar?: TopBarProps;
}

type Match = { state: "none" } | { state: "ok"; fids: string[] } | { state: "bad"; message: string; position?: number };

export function DataScreen({ topBar }: DataScreenProps) {
  useAreaPreview();
  const { project, preview, counts, connection, selectedMapIds, select } = useApp();
  const maps = project?.maps ?? [];

  const [role, setRole] = useState<RoleId>(() => ROLE_IDS.find((r) => (counts?.[r] ?? 0) > 0) ?? ROLE_IDS[0]!);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ key: string; dir: "asc" | "desc" } | null>(null);
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<{ total: number; rows: FeatureRow[] }>({ total: 0, rows: [] });
  const [known, setKnown] = useState<Record<string, string[]>>({}); // attribute keys seen, per role
  const [chosen, setChosen] = useState<Record<string, string[]>>({}); // the picker's choices, per role
  const [picker, setPicker] = useState(false);
  const [filter, setFilter] = useState("");
  const [asked, setAsked] = useState(""); // the filter text the result belongs to
  const [match, setMatch] = useState<Match>({ state: "none" });
  const [mapId, setMapId] = useState("");
  const [selecting, setSelecting] = useState(false);
  const seq = useRef({ page: 0, match: 0 });

  // Debounced search; a new search goes back to the first page.
  useEffect(() => {
    if (search === query) return;
    const t = window.setTimeout(() => { setQuery(search); setOffset(0); }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [search, query]);

  useEffect(() => {
    const mine = ++seq.current.page;
    api.features(role, { q: query, offset, limit: PAGE_SIZE, sort: sort?.key, dir: sort?.dir }).then((r) => {
      if (mine !== seq.current.page) return;
      setPage(r);
      setKnown((k) => {
        const have = k[role] ?? [];
        const add = [...new Set(r.rows.flatMap((x) => Object.keys(x.attrs)))].filter((a) => a !== "name" && !have.includes(a));
        return add.length ? { ...k, [role]: [...have, ...add] } : k;
      });
    }, (e) => { if (mine === seq.current.page) toast(message(e), "error"); });
  }, [role, query, offset, sort, project?.dataVersion]);

  const attrKeys = known[role] ?? [];
  const shown = chosen[role] ?? attrKeys.slice(0, DEFAULT_COLUMNS);
  const columns = ["name", ...attrKeys.filter((k) => shown.includes(k))];

  function changeRole(next: RoleId): void {
    setRole(next);
    setPage({ total: 0, rows: [] });
    setOffset(0);
    setSort(null);
    setSearch(""); setQuery("");
    setFilter(""); setAsked(""); setMatch({ state: "none" });
    seq.current.match++;
  }

  function clickHeader(key: string): void {
    setOffset(0);
    setSort((s) => (s?.key === key && s.dir === "asc" ? { key, dir: "desc" } : { key, dir: "asc" }));
  }

  function toggleColumn(key: string): void {
    setChosen((c) => {
      const cur = c[role] ?? attrKeys.slice(0, DEFAULT_COLUMNS);
      return { ...c, [role]: cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key] };
    });
  }

  async function find(given?: string): Promise<void> {
    const text = (given ?? filter).trim();
    const mine = ++seq.current.match;
    if (!text) { setAsked(""); setMatch({ state: "none" }); return; }
    try {
      const r = await api.match(role, text);
      if (mine !== seq.current.match) return;
      setAsked(text); setMatch({ state: "ok", fids: r.fids });
    } catch (e) {
      if (mine !== seq.current.match) return;
      setAsked(text);
      if (e instanceof ApiFail && e.status === 400) setMatch({ state: "bad", message: e.message, position: e.position });
      else { setMatch({ state: "none" }); toast(message(e), "error"); }
    }
  }

  // New data under the same project: re-run the active match so the highlight follows it.
  const lastVersion = useRef(project?.dataVersion);
  useEffect(() => {
    if (lastVersion.current === project?.dataVersion) return;
    lastVersion.current = project?.dataVersion;
    if (asked) void find(asked);
  });

  const effectiveMap = maps.some((m) => m.id === mapId) ? mapId : (maps.find((m) => selectedMapIds.includes(m.id)) ?? maps[0])?.id ?? "";
  const matched = match.state === "ok" ? match.fids.length : 0;
  const canSelect = connection.connected && !connection.busy && matched > 0 && !!effectiveMap && !selecting;

  async function selectInAffinity(): Promise<void> {
    setSelecting(true);
    try {
      const r = await api.selectOnMap(role, effectiveMap, asked.trim());
      toast(`Selected ${fmtCount(r.selected)} in Affinity.`, "success");
    } catch (e) {
      toast(isNotConnected(e) ? "Affinity isn't connected. Run Geo – Connect in Affinity, then try again." : message(e), "error");
    } finally { setSelecting(false); }
  }

  const matchSet = useMemo(() => new Set(match.state === "ok" ? match.fids : []), [match]);
  const highlight = useMemo(() => (match.state === "ok" ? { role, fids: match.fids } : undefined), [match, role]);
  const first = page.rows.length ? offset + 1 : 0;
  const last = offset + page.rows.length;

  return (
    <Shell topBar={topBar}>
      <div className="data-screen">
        <div className="data-panel">
          <div className="data-bar">
            <select aria-label="Layer" value={role} onChange={(e) => changeRole(e.target.value as RoleId)}>
              {ROLE_IDS.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]} ({fmtCount(counts?.[r] ?? 0)})</option>)}
            </select>
            <input type="search" aria-label="Search" placeholder="Search names and values" value={search} onChange={(e) => setSearch(e.target.value)} />
            <span className="data-columns">
              <button type="button" className="btn btn-small" aria-expanded={picker} onClick={() => setPicker((p) => !p)}>Columns</button>
              {picker && (
                <div className="column-picker" role="group" aria-label="Columns">
                  {attrKeys.length === 0 && <span className="muted">No attributes.</span>}
                  {attrKeys.map((k) => (
                    <label key={k} className="check">
                      <input type="checkbox" checked={shown.includes(k)} onChange={() => toggleColumn(k)} aria-label={k} />
                      <span>{k}</span>
                    </label>
                  ))}
                </div>
              )}
            </span>
          </div>
          <Section chip="Select by attribute">
            <div className="select-box">
              <div className="select-row">
                <input type="text" className="mono" aria-label="Filter" spellCheck={false} placeholder="name starts with 'S' or area > 100"
                  value={filter} onChange={(e) => setFilter(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") void find(); }} />
                <button type="button" className="btn btn-small" onClick={() => { void find(); }}>Find</button>
              </div>
              {match.state === "bad" && (
                <div className="filter-error">
                  <pre className="filter-echo mono" data-testid="filter-echo">{`${asked}\n${pad(asked, match.position ?? 0)}^`}</pre>
                  <div role="alert" className="field-error">{match.message}</div>
                </div>
              )}
              {match.state === "ok" && (
                <div className="select-result">
                  <span className="match-count">{fmtCount(matched)} match</span>
                  <select aria-label="Map" value={effectiveMap} onChange={(e) => setMapId(e.target.value)} disabled={!maps.length}>
                    {maps.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </select>
                  <button type="button" className="btn btn-small btn-primary" disabled={!canSelect}
                    title={!connection.connected ? "Affinity isn't connected." : connection.busy ? "Affinity is busy drawing. Try again in a moment." : undefined} onClick={() => { void selectInAffinity(); }}>
                    Select in Affinity
                  </button>
                </div>
              )}
            </div>
          </Section>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  {columns.map((c) => (
                    <th key={c} aria-sort={sort?.key === c ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
                      <button type="button" onClick={() => clickHeader(c)}>{c}{sort?.key === c ? (sort.dir === "asc" ? " ▲" : " ▼") : ""}</button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {page.rows.map((r) => (
                  <tr key={r.fid} className={matchSet.has(r.fid) ? "is-match" : undefined}>
                    {columns.map((c) => <td key={c}>{cell(c === "name" ? r.name : r.attrs[c])}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
            {page.rows.length === 0 && <div className="muted data-empty">Nothing to show.</div>}
          </div>
          <div className="data-paging">
            <span>{first}–{last} of {fmtCount(page.total)}</span>
            <button type="button" className="btn btn-small" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>Prev</button>
            <button type="button" className="btn btn-small" disabled={offset + PAGE_SIZE >= page.total} onClick={() => setOffset(offset + PAGE_SIZE)}>Next</button>
          </div>
        </div>
        <div className="data-preview">
          <MapCanvas
            preview={preview.data ?? null} style={project!.style} maps={maps} selectedIds={selectedMapIds} mode="browse" highlight={highlight}
            onSelect={select} onAdd={() => undefined} onMove={() => undefined} onRotate={() => undefined} onPick={() => undefined}
          />
          {preview.status === "none" && <div className="map-canvas-note">No map data yet. Fetch it on the Area screen.</div>}
        </div>
      </div>
    </Shell>
  );
}
