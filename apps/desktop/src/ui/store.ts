// The app's shared state: one small store read with useApp(). Polling lives in useAppPolling(), mounted once by App.
import { useEffect, useSyncExternalStore } from "react";
import type { Project } from "@affinitygeo/geo-core";
import { ApiFail, api, isNotConnected, type AreaPreview, type Counts, type MapStatus, type TargetDocument } from "./api.js";
import { platform } from "./platform.js";
import { confirm } from "./shell/Confirm.js";
import { toast } from "./shell/Toast.js";

export type Screen = "area" | "maps" | "style" | "data";
export type View = "map" | "gallery";
export interface Connection { connected: boolean; busy: boolean }
/** The Map view's data. "none": no data yet, or the last read failed (retried on the connection poll). */
export interface PreviewState { status: "loading" | "none" | "ready"; data?: AreaPreview }

export interface AppState {
  project: Project | null;
  dirty: boolean;
  counts: Counts | null;
  /** Server statuses by map id (last known; kept while Affinity is away). */
  statuses: Record<string, MapStatus>;
  /** Open Affinity documents and their artboards (last known). */
  targets: TargetDocument[];
  connection: Connection;
  /** The first /api/affinity poll has finished (either way), so `connection` means something. */
  connectionChecked: boolean;
  screen: Screen;
  view: View;
  selectedMapIds: string[];
  /** The area's data in projected metres for the Map view. */
  preview: PreviewState;
}

export interface AppActions {
  /** Re-reads the project, dirty flag and counts. Drops selected ids whose map is gone. */
  refreshProject(): Promise<void>;
  /** Re-reads map statuses and targets from Affinity. Quietly does nothing when Affinity isn't connected. */
  refreshStatuses(): Promise<void>;
  setScreen(screen: Screen): void;
  setView(view: View): void;
  select(ids: string[]): void;
  /**
   * Re-reads the area preview. The status stays as it is until the reply ("none" doesn't flash to "loading" on a retry).
   * No data yet (409) gives "none"; any other failure also gives "none" (keeping data
   * already shown) and rethrows. Only the newest call's reply counts.
   */
  refreshPreview(): Promise<void>;
}

export const CONNECTION_POLL_MS = 2000;
export const STATUS_POLL_MS = 5000;
/** How long the unsaved guard waits for waiting edits and a fresh dirty flag before going on the last known one. */
export const GUARD_READ_MS = 3000;

export const SCREEN_LABELS: Record<Screen, string> = { area: "Area", maps: "Maps", style: "Style", data: "Data" };

function initialState(): AppState {
  return {
    project: null, dirty: false, counts: null, statuses: {}, targets: [],
    connection: { connected: false, busy: false }, connectionChecked: false,
    screen: "maps", view: "map", selectedMapIds: [], preview: { status: "loading" },
  };
}

let state: AppState = initialState();
const listeners = new Set<() => void>();

/** The current state, for code outside React. */
export function getApp(): AppState {
  return state;
}

/** Merges a change and tells subscribers. */
export function setApp(patch: Partial<AppState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

/** Back to the initial state plus `patch`. For tests and for a fresh start. */
export function resetApp(patch: Partial<AppState> = {}): void {
  state = { ...initialState(), ...patch };
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

async function refreshProject(): Promise<void> {
  const r = await api.project();
  const ids = new Set(r.project?.maps.map((m) => m.id) ?? []);
  setApp({
    project: r.project, dirty: r.dirty, counts: r.counts,
    selectedMapIds: state.selectedMapIds.filter((id) => ids.has(id)),
  });
}

async function refreshStatuses(): Promise<void> {
  try {
    const [list, targets] = await Promise.all([
      state.project?.maps.length ? api.statuses() : Promise.resolve([]),
      api.targets(),
    ]);
    const statuses: Record<string, MapStatus> = {};
    for (const s of list) statuses[s.mapId] = s.status;
    setApp({ statuses, targets: targets.documents });
  } catch (e) {
    if (isNotConnected(e)) return; // keep the last known statuses
    throw e;
  }
}

let previewSeq = 0;
/** The project the preview on screen belongs to. */
let previewProjectId: string | null = null;

async function refreshPreview(): Promise<void> {
  const seq = ++previewSeq;
  const projectId = state.project?.id ?? null;
  try {
    const data = await api.areaPreview();
    if (seq === previewSeq) { previewProjectId = projectId; setApp({ preview: { status: "ready", data } }); }
  } catch (e) {
    if (seq !== previewSeq) return; // a newer request has the say
    if (e instanceof ApiFail && e.status === 409) { setApp({ preview: { status: "none" } }); return; } // no data yet
    // Keep data already shown only when it is this project's: never another project's area.
    if (state.preview.status !== "ready" || previewProjectId !== projectId) setApp({ preview: { status: "none" } });
    throw e;
  }
}

const actions: AppActions = {
  refreshProject,
  refreshStatuses,
  setScreen: (screen) => setApp({ screen }),
  setView: (view) => setApp({ view }),
  select: (ids) => setApp({ selectedMapIds: [...ids] }),
  refreshPreview,
};

/** The actions, for code outside React. */
export function getActions(): AppActions {
  return actions;
}

/** The app state and its actions. Re-renders when the state changes. */
export function useApp(): AppState & AppActions {
  const s = useSyncExternalStore(subscribe, getApp, getApp);
  return { ...s, ...actions };
}

/**
 * Loads the project, then polls /api/affinity every 2 s and the map statuses and targets every 5 s
 * while Affinity is connected and idle. Mount once (App does); the timers stop on unmount.
 */
export function useAppPolling(): void {
  useEffect(() => {
    let alive = true;
    let pollingConnection = false;
    let pollingStatuses = false;
    const quiet = (e: unknown) => { if (alive) console.warn(e); };

    async function pollStatuses(): Promise<void> {
      const { connected, busy } = state.connection;
      if (!connected || busy || pollingStatuses) return; // a busy Affinity would queue the list behind a drawing
      pollingStatuses = true;
      try { await refreshStatuses(); } catch (e) { quiet(e); } finally { pollingStatuses = false; }
    }

    async function pollConnection(): Promise<void> {
      if (pollingConnection) return;
      pollingConnection = true;
      try {
        const c = await api.affinity();
        if (!alive) return;
        const was = state.connection;
        if (was.connected !== c.connected || was.busy !== c.busy) setApp({ connection: { connected: c.connected, busy: c.busy } });
        if (c.connected && !was.connected) void pollStatuses(); // just connected: don't wait 5 s for the badges
        // No preview yet (no data, or the last read failed): try again on each tick.
        if (state.project && state.preview.status === "none") void refreshPreview().catch(quiet);
      } catch {
        if (alive && state.connection.connected) setApp({ connection: { connected: false, busy: false } });
      } finally {
        pollingConnection = false;
        if (alive && !state.connectionChecked) setApp({ connectionChecked: true });
      }
    }

    void refreshProject().catch(quiet).then(() => pollConnection());
    const c = window.setInterval(() => { void pollConnection(); }, CONNECTION_POLL_MS);
    const s = window.setInterval(() => { void pollStatuses(); }, STATUS_POLL_MS);
    // Changes made outside this page (another window, the CLI) show up when the user comes back.
    const onFocus = () => { void refreshProject().catch(quiet); };
    const onVisible = () => { if (document.visibilityState !== "hidden") onFocus(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
      alive = false;
      window.clearInterval(c);
      window.clearInterval(s);
    };
  }, []);
}

// ---- edits still waiting for a debounce (the Style screen, the scale slider) ----

type PendingEdit = () => Promise<void> | void;
const pendingEdits = new Set<PendingEdit>();

/**
 * Registers a debounced edit that hasn't been sent yet. `flush` sends it now (and cancels its timer).
 * Returns the unregister function. The close guard and New/Open flush these before deciding.
 */
export function registerPendingEdit(flush: PendingEdit): () => void {
  pendingEdits.add(flush);
  return () => { pendingEdits.delete(flush); };
}

/** Sends every debounced edit still waiting, and waits for the answers. Failures are the editors' to report. */
export async function flushPendingEdits(): Promise<void> {
  await Promise.all([...pendingEdits].map((f) => Promise.resolve().then(f).catch(() => undefined)));
}

/**
 * Save As: asks where (suggesting "<name>.afgeo"), saves there and adds it to the recent list.
 * False when there is no project or the dialog was cancelled.
 */
export async function saveProjectAs(): Promise<boolean> {
  const project = state.project;
  if (!project) return false;
  const path = await platform.saveProjectAs(`${project.name}.afgeo`);
  if (!path) return false;
  await api.save(path);
  await platform.addRecent(path);
  await refreshProject();
  toast("Project saved.", "success");
  return true;
}

/**
 * Save: to the project's file, or through Save As when it has none yet (the server's NEEDS_PATH).
 * False when there is no project or Save As was cancelled. Other failures (the file couldn't be
 * written, …) throw with the server's message.
 */
export async function saveProject(): Promise<boolean> {
  if (!state.project) return false;
  try {
    await api.save();
  } catch (e) {
    if (!(e instanceof ApiFail && e.code === "NEEDS_PATH")) throw e;
    return saveProjectAs();
  }
  await refreshProject();
  toast("Project saved.", "success");
  return true;
}

/**
 * Runs `action` once unsaved changes are dealt with. It first sends edits still waiting for a debounce and
 * re-reads the server's dirty flag (a send records maps without the app hearing of it), so it never trusts
 * a stale flag. A dirty project asks "Save changes to '<name>' first?" (ahead of any other question):
 * Save saves (through Save As for a new project) and goes ahead, Don't save goes ahead, Cancel (or Escape,
 * or cancelling Save As) doesn't. A clean project goes straight ahead. A failed save throws and stops.
 * New, Open, the recent list and closing the window all use it.
 */
export async function guardUnsaved(action: () => Promise<void>): Promise<void> {
  if (state.project) {
    // A server that doesn't answer mustn't hold the window open: after GUARD_READ_MS, go on the last known flag.
    const fresh = flushPendingEdits().then(() => refreshProject()).catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([fresh, new Promise<void>((r) => { timer = setTimeout(r, GUARD_READ_MS); })]);
    clearTimeout(timer);
  }
  const { project, dirty } = state;
  if (project && dirty) {
    const answer = await confirm({
      title: `Save changes to '${project.name}' first?`,
      body: "If you don't save, the changes since you last saved are lost.",
      buttons: [{ label: "Save", kind: "primary" }, "Don't save", "Cancel"],
      front: true,
    });
    if (answer === "Save") { if (!(await saveProject())) return; }
    else if (answer !== "Don't save") return;
  }
  await action();
}
