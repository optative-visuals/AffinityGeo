// Sending maps to Affinity, one map per request so the progress panel is real, and the summary of what
// happened: counts, edits kept, warnings, failures, and the artboard-size question for a map whose
// artboard doesn't match it.
import { useEffect, useState, useSyncExternalStore } from "react";
import type { MapSpec } from "@affinitygeo/geo-core";
import { ROLE_LABELS } from "@affinitygeo/geo-core/view";
import { ApiFail, api, type SendResult } from "../api.js";
import { confirm } from "../shell/Confirm.js";
import { CloseIcon } from "../shell/icons.js";
import { getActions, getApp, useApp } from "../store.js";
import { fmtMm } from "./sizes.js";
import { refreshAfterChange } from "./status.js";

export interface SendOptions { mapIds?: string[]; reset?: boolean }

export interface SendSummaryState {
  results: SendResult[];
  /** The run stopped (Affinity not connected, still drawing, …): maps after `results` weren't sent. */
  failure?: string;
  /** Whether it was a reset ("Reset hand edits…"). */
  reset?: boolean;
  /** How many maps the run set out to send (defaults to the number of results). */
  total?: number;
  /** Maps whose artboard-size question is still to be answered. */
  waiting?: string[];
  /** Maps whose artboard-size question was asked and cancelled. */
  cancelled?: string[];
}

/** The map being drawn: `index` maps are done out of `total`. */
export interface SendProgress { mapId: string; index: number; total: number; startedAt: number }

export const NOT_CONNECTED = "Affinity isn't connected, so nothing was sent. Run Geo – Connect in Affinity, then send again.";
export const STILL_DRAWING = "Affinity is still drawing an earlier map. Try again in a moment.";
export const NOT_CONNECTED_REST = "Affinity isn't connected, so the remaining maps weren't sent. Run Geo – Connect in Affinity, then send again.";
export const CANCELLED_SIZE = "Not sent: you cancelled the size choice.";
export const NEEDS_SIZE_CHOICE = "Not sent: the artboard size needs a choice. Send again to choose.";
export const MAP_DELETED = "Not sent: the map was deleted.";
export const PROJECT_CHANGED = "Another project was opened, so the remaining maps weren't sent.";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function sendFailure(e: unknown): string {
  if (e instanceof ApiFail && e.status === 503) return NOT_CONNECTED;
  if (e instanceof ApiFail && e.status === 504) return STILL_DRAWING;
  return message(e);
}

/** The artboard-size question. Resolves true (resize), false (keep its size) or null (cancel). */
export async function askResize(map: Pick<MapSpec, "name" | "sizeMm">, artboardMm: { width: number; height: number }): Promise<boolean | null> {
  const answer = await confirm({
    title: `${map.name}: the artboard is a different size`,
    body: `The artboard is ${fmtMm(artboardMm.width)} × ${fmtMm(artboardMm.height)} mm; the map is ${fmtMm(map.sizeMm.width)} × ${fmtMm(map.sizeMm.height)} mm. Resize the artboard?`,
    buttons: ["Cancel", { label: "Keep its size", value: "keep" }, { label: "Resize", value: "resize", kind: "primary" }],
  });
  return answer === "resize" ? true : answer === "keep" ? false : null;
}

// The send state lives at module level, so Send works from any screen: App switches to Maps, whose
// SendSummary shows what happened.
interface SendState { sending: boolean; summary: SendSummaryState | null; progress: SendProgress | null }
let sendState: SendState = { sending: false, summary: null, progress: null };
const sendListeners = new Set<() => void>();
function setSend(patch: Partial<SendState>): void {
  sendState = { ...sendState, ...patch };
  for (const l of sendListeners) l();
}
function subscribeSend(l: () => void): () => void {
  sendListeners.add(l);
  return () => { sendListeners.delete(l); };
}

/** The current send state, for code outside React. */
export function getSendState(): SendState {
  return sendState;
}

/** Back to idle with no summary (tests). */
export function resetSend(): void {
  sendState = { sending: false, summary: null, progress: null };
  for (const l of sendListeners) l();
}

export function closeSummary(): void {
  setSend({ summary: null });
}

/** The maps "Send all changed" sends: every map whose status isn't "Up to date", in list order. Needs Affinity. */
async function changedMapIds(): Promise<string[]> {
  const maps = getApp().project?.maps ?? [];
  if (!maps.length) return [];
  const upToDate = new Set((await api.statuses()).filter((s) => s.status === "Up to date").map((s) => s.mapId));
  return maps.filter((m) => !upToDate.has(m.id)).map((m) => m.id);
}

function patchSummary(patch: (s: SendSummaryState) => SendSummaryState): void {
  const s = sendState.summary;
  if (s) setSend({ summary: patch(s) });
}

/**
 * Sends maps one at a time (one POST each), with the progress panel showing which map is drawing,
 * then keeps the summary. The given maps, or every changed map. A failed request (Affinity not
 * connected, still drawing) stops the run: later maps aren't posted, what was sent stays listed, and
 * no size question is asked. A map deleted mid-run (404) only fails that map.
 * The project is re-read after each map (the server has recorded it, so the project is unsaved), and
 * a different project showing up stops the run: the old project's map ids are never posted.
 * One send at a time: a second call while one runs is ignored.
 */
export async function sendMaps(opts: SendOptions = {}): Promise<void> {
  if (sendState.sending) return;
  const startedAt = Date.now();
  const projectId = getApp().project?.id;
  const switched = () => getApp().project?.id !== projectId;
  const reread = () => getActions().refreshProject().catch(() => undefined);
  setSend({ sending: true, summary: null, progress: null });
  const post = (mapId: string) => api.send(opts.reset ? { mapIds: [mapId], reset: true } : { mapIds: [mapId] });
  const results: SendResult[] = [];
  let failure: string | undefined;
  let queue: string[] = [];
  try {
    try {
      queue = opts.mapIds ? [...opts.mapIds] : await changedMapIds();
    } catch (e) {
      failure = sendFailure(e);
    }
    for (let i = 0; !failure && i < queue.length; i++) {
      if (switched()) { failure = PROJECT_CHANGED; break; }
      const mapId = queue[i]!;
      setSend({ progress: { mapId, index: i, total: queue.length, startedAt } });
      try {
        const out = await post(mapId);
        results.push(out.results.find((r) => r.mapId === mapId) ?? { mapId, ok: false, error: "Not sent." });
      } catch (e) {
        // A map deleted since the run began (404) is that map's failure; the others still go.
        if (e instanceof ApiFail && e.status === 404) { results.push({ mapId, ok: false, error: MAP_DELETED }); continue; }
        const notConnected = e instanceof ApiFail && e.status === 503;
        failure = notConnected && results.some((r) => r.ok) ? NOT_CONNECTED_REST : sendFailure(e);
        break;
      }
      // The server recorded the map: the project is unsaved now, and the unsaved dot (and the close guard) must know.
      await reread();
      if (switched()) failure = PROJECT_CHANGED;
    }
    const asking = results.filter((r) => r.needsResizeChoice && r.artboardMm).map((r) => r.mapId);
    setSend({
      progress: null,
      summary: { results: [...results], failure, reset: opts.reset, total: queue.length, waiting: failure ? [] : asking },
    });
    if (failure) {
      // Statuses stay as they were unless something was really sent: Affinity may just be away.
      refreshAfterChange(results.some((r) => r.ok));
      return;
    }

    // Maps whose artboard size needs a choice, one question at a time.
    for (const mapId of asking) {
      if (switched()) {
        // Another project now: its maps aren't these, so ask nothing more and post nothing.
        patchSummary((s) => ({ ...s, failure: PROJECT_CHANGED, waiting: [] }));
        break;
      }
      const r = results.find((x) => x.mapId === mapId)!;
      const map = getApp().project?.maps.find((m) => m.id === mapId);
      const done = (s: SendSummaryState) => (s.waiting ?? []).filter((id) => id !== mapId);
      if (!map) {
        // Deleted before its question came up: nothing to ask.
        patchSummary((s) => ({ ...s, waiting: done(s), results: s.results.map((x) => (x.mapId === mapId ? { mapId, ok: false, error: MAP_DELETED } : x)) }));
        continue;
      }
      const resize = await askResize(map, r.artboardMm!);
      if (switched()) {
        patchSummary((s) => ({ ...s, failure: PROJECT_CHANGED, waiting: [] }));
        break;
      }
      patchSummary((s) => ({ ...s, waiting: done(s), cancelled: resize === null ? [...(s.cancelled ?? []), mapId] : s.cancelled }));
      if (resize === null) continue;
      let next: SendResult;
      setSend({ progress: { mapId, index: 0, total: 1, startedAt: Date.now() } });
      try {
        await api.patchMap(mapId, { resizeArtboard: resize });
        const out = await post(mapId);
        next = out.results.find((x) => x.mapId === mapId) ?? { mapId, ok: false, error: "Not sent." };
      } catch (e) {
        next = { mapId, ok: false, error: sendFailure(e) };
      }
      setSend({ progress: null });
      patchSummary((s) => ({ ...s, results: s.results.map((x) => (x.mapId === mapId ? next : x)) }));
      await reread();
    }
    refreshAfterChange(true);
  } finally {
    setSend({ sending: false, progress: null });
  }
}

/** The send state and its actions. */
export function useSend() {
  const s = useSyncExternalStore(subscribeSend, getSendState, getSendState);
  return { sending: s.sending, summary: s.summary, progress: s.progress, send: sendMaps, close: closeSummary };
}

/** The summary's title: says only what really happened. */
export function summaryTitle(summary: SendSummaryState): string {
  const done = summary.results.filter((r) => r.ok).length;
  if (summary.failure && !done) return "Not sent";
  const total = summary.total ?? summary.results.length;
  if (!total) return "Nothing to send";
  if (!done) return "Not sent";
  const verb = summary.reset ? "Reset" : "Sent";
  if (done < total) return `${verb} ${done} of ${total} maps`;
  return done === 1 ? `${verb} 1 map` : `${verb} ${done} maps`;
}

interface Kept { fid: string; role: string; name: string; reason: string }

const asKept = (v: unknown): Kept | null => {
  const k = v as Partial<Kept> | null;
  if (!k || typeof k !== "object") return null;
  return { fid: String(k.fid ?? ""), role: String(k.role ?? ""), name: String(k.name ?? ""), reason: String(k.reason ?? "edited by hand") };
};

const keptName = (k: Kept) => k.name || (ROLE_LABELS as Record<string, string>)[k.role] || k.fid;

/** Kept edits grouped by reason, in first-seen order. */
export function groupKept(list: unknown[] | undefined): Array<{ reason: string; names: string[] }> {
  const groups = new Map<string, string[]>();
  for (const v of list ?? []) {
    const k = asKept(v);
    if (!k) continue;
    const names = groups.get(k.reason) ?? [];
    names.push(keptName(k));
    groups.set(k.reason, names);
  }
  return [...groups].map(([reason, names]) => ({ reason, names }));
}

function ResultRow({ r, name, choice }: { r: SendResult; name: string; choice: "waiting" | "cancelled" | "unasked" }) {
  if (r.needsResizeChoice) {
    // "unasked": the run stopped before the question came up.
    const text = choice === "waiting" ? "Waiting for your choice…" : choice === "cancelled" ? CANCELLED_SIZE : NEEDS_SIZE_CHOICE;
    return (
      <li className="send-row">
        <strong>{name}</strong>
        <span className="muted">{text}</span>
      </li>
    );
  }
  if (!r.ok) {
    return (
      <li className="send-row">
        <strong>{name}</strong>
        <span className="is-error">{r.error ?? "Not sent."}</span>
      </li>
    );
  }
  const kept = groupKept(r.keptEdited);
  return (
    <li className="send-row">
      <strong>{name}</strong>
      <span>{`${r.created ?? 0} created · ${r.updated ?? 0} updated · ${r.removed ?? 0} removed`}</span>
      {r.resized && <span className="muted">The artboard was resized to fit.</span>}
      {kept.map((g) => (
        <span key={g.reason} className="muted">{`Kept your edits (${g.reason}): ${g.names.join(", ")}`}</span>
      ))}
      {(r.warnings ?? []).map((w, i) => <span key={i} className="is-warning">{w}</span>)}
    </li>
  );
}

export interface SendSummaryProps {
  summary: SendSummaryState;
  onClose(): void;
}

export function SendSummary({ summary, onClose }: SendSummaryProps) {
  const maps = useApp().project?.maps ?? [];
  const nameOf = (id: string) => maps.find((m) => m.id === id)?.name ?? "A deleted map";
  const title = summaryTitle(summary);
  return (
    <section className="send-summary" aria-label="Send summary">
      <header className="send-summary-head">
        <strong>{title}</strong>
        <button type="button" className="icon-btn" aria-label="Close the summary" onClick={onClose}><CloseIcon size={14} /></button>
      </header>
      {summary.failure && <p className="is-error">{summary.failure}</p>}
      {!summary.failure && !summary.results.length && <p className="muted">Every map is up to date.</p>}
      {summary.results.length > 0 && (
        <ul className="send-list">
          {summary.results.map((r) => (
            <ResultRow key={r.mapId} r={r} name={nameOf(r.mapId)}
              choice={(summary.waiting ?? []).includes(r.mapId) ? "waiting" : (summary.cancelled ?? []).includes(r.mapId) ? "cancelled" : "unasked"} />
          ))}
        </ul>
      )}
    </section>
  );
}

/** Seconds since `since`, ticking once a second. */
function useElapsed(since: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  return Math.max(0, Math.floor((now - since) / 1000));
}

/**
 * Where the summary goes while a send runs: "Drawing Lake (2 of 3)…", the elapsed seconds, and a bar
 * that fills per finished map, with a shimmer over the map being drawn.
 */
export function SendProgressPanel({ progress }: { progress: SendProgress }) {
  const maps = useApp().project?.maps ?? [];
  const name = maps.find((m) => m.id === progress.mapId)?.name ?? "a map";
  const seconds = useElapsed(progress.startedAt);
  const share = 100 / progress.total;
  return (
    <section className="send-summary send-progress" aria-label="Send progress">
      <div className="send-progress-head">
        <strong>{`Drawing ${name} (${progress.index + 1} of ${progress.total})…`}</strong>
        <span className="muted">{`${seconds} s`}</span>
      </div>
      <div className="send-bar" role="progressbar" aria-label="Maps drawn"
        aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.index}>
        <span className="send-bar-done" style={{ width: `${progress.index * share}%` }} />
        <span className="send-bar-current" style={{ left: `${progress.index * share}%`, width: `${share}%` }} />
      </div>
    </section>
  );
}
