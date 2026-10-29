// A typed client for the companion's /api routes. Every call adds X-Geo-App: 1 and throws ApiFail on an error.
// Types only from geo-core and the companion: nothing node-only reaches the UI bundle.
import type { MapJob, MapSpec, PlaceResult, Project, ProjectStyle, RoleId, RoleSource } from "@affinitygeo/geo-core";
import type { AreaPreview, MapStatus, NewMapInput, ProjectionOption, Targets } from "../../../companion/src/session.js";

export type { AreaPreview, MapStatus, NewMapInput, ProjectionOption, Targets };
export type Counts = Record<RoleId, number>;
export type TargetDocument = Targets["documents"][number];

/**
 * A failed API call. `status` is the HTTP status (0 when the server couldn't be reached).
 * `code` is the server's marker for a case the app handles specially ("NEEDS_PATH": save has no file yet).
 */
export class ApiFail extends Error {
  constructor(public status: number, message: string, public position?: number, public code?: string) {
    super(message);
    this.name = "ApiFail";
  }
}

/** True when Affinity isn't connected (the server's 503). */
export function isNotConnected(e: unknown): boolean {
  return e instanceof ApiFail && e.status === 503;
}

const UNREACHABLE = "AffinityGeo's server isn't answering. Restart the app.";

let pending = 0;
/** Writes (POST/PATCH/DELETE) still waiting for an answer. Polling GETs aren't counted. */
export function pendingRequests(): number {
  return pending;
}

async function call<T>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { "X-Geo-App": "1" };
  const init: RequestInit = { method, headers };
  if (method === "POST" || method === "PATCH") {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body ?? {});
  }
  const write = method !== "GET";
  if (write) pending += 1;
  try {
    let res: Response;
    try {
      res = await fetch(path, init);
    } catch {
      throw new ApiFail(0, UNREACHABLE);
    }
    let data: unknown = null;
    try { data = await res.json(); } catch { /* an empty or non-JSON body */ }
    if (!res.ok) {
      const d = (data ?? {}) as { error?: unknown; position?: unknown; code?: unknown };
      const message = typeof d.error === "string" ? d.error : `The request failed (${res.status}).`;
      throw new ApiFail(res.status, message, typeof d.position === "number" ? d.position : undefined, typeof d.code === "string" ? d.code : undefined);
    }
    return data as T;
  } finally {
    if (write) pending -= 1;
  }
}

const enc = encodeURIComponent;
function query(params: Record<string, string | number | undefined>): string {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${enc(k)}=${enc(String(v))}`);
  return parts.length ? `?${parts.join("&")}` : "";
}

export interface ProjectState { project: Project | null; dirty: boolean; counts: Counts | null }
export interface RefreshResult { counts: Counts; changed: Partial<Record<RoleId, { before: number; after: number }>> }
export interface FeaturesQuery { q?: string; offset?: number; limit?: number; sort?: string; dir?: "asc" | "desc" }
export interface FeatureRow { fid: string; name: string; attrs: Record<string, unknown> }
export interface SendResult {
  mapId: string; ok: boolean;
  created?: number; updated?: number; removed?: number;
  keptEdited?: unknown[]; resized?: boolean; warnings?: string[];
  error?: string; needsResizeChoice?: true; artboardMm?: { width: number; height: number };
}
export interface ArtboardLink { docId: string; artboardIndex: number; artboardName: string }
export interface ScriptsInfo { loader: string; home: string; installed: boolean; scriptsNote?: string | null }

export const api = {
  // ---- project ----
  /** The open project. No project open (the server's 409) reads as `project: null`. */
  async project(): Promise<ProjectState> {
    try {
      return await call<ProjectState>("GET", "/api/project");
    } catch (e) {
      if (e instanceof ApiFail && e.status === 409) return { project: null, dirty: false, counts: null };
      throw e;
    }
  },
  /** Starts a new project (not saved yet). `warning` is set for a large area. */
  newProject: (name: string, area: { placeName: string; bboxWgs84: [number, number, number, number] }, preset: string) =>
    call<Project & { warning?: string }>("POST", "/api/project/new", { name, area, preset }),
  open: (path: string) => call<Project>("POST", "/api/project/open", { path }),
  /** Saves to `path`, or to the file it was opened from / last saved to. A new project needs a path (400, code NEEDS_PATH). */
  save: (path?: string) => call<{ ok: true }>("POST", "/api/project/save", path === undefined ? {} : { path }),

  // ---- area and data ----
  places: (q: string) => call<PlaceResult[]>("GET", `/api/places${query({ q })}`),
  refresh: () => call<RefreshResult>("POST", "/api/data/refresh"),
  importFile: (path: string, role: RoleId, datasetName?: string) =>
    call<{ counts: Counts }>("POST", "/api/data/import", { path, role, ...(datasetName ? { datasetName } : {}) }),
  setSource: (role: RoleId, source: RoleSource) => call<{ counts: Counts }>("POST", "/api/data/source", { role, source }),
  projections: () => call<ProjectionOption[]>("GET", "/api/projections"),
  setArea: (projectionId: "bng" | "utm", params?: Record<string, number>) =>
    call<Project>("POST", "/api/project/area", { projectionId, ...(params ? { projectionParams: params } : {}) }),
  areaPreview: () => call<AreaPreview>("GET", "/api/preview/area"),

  // ---- style ----
  presets: () => call<Array<{ name: string }>>("GET", "/api/presets"),
  applyPreset: (name: string) => call<ProjectStyle>("POST", "/api/style/preset", { name }),
  updateStyle: (patch: { roles?: Partial<Record<RoleId, Partial<ProjectStyle["roles"][RoleId]>>>; marker?: Partial<ProjectStyle["marker"]>; paper?: string }) =>
    call<ProjectStyle>("POST", "/api/style", patch),

  // ---- maps ----
  addMap: (input: NewMapInput) => call<MapSpec>("POST", "/api/maps", input),
  patchMap: (id: string, patch: Partial<MapSpec>) => call<MapSpec>("PATCH", `/api/maps/${enc(id)}`, patch),
  deleteMap: (id: string) => call<{ ok: true }>("DELETE", `/api/maps/${enc(id)}`),
  /** The map as it would be drawn: layers in mm, frame-local. */
  mapPreview: (id: string) => call<MapJob>("GET", `/api/maps/${enc(id)}/preview`),
  /** Needs Affinity (503 when not connected). */
  statuses: () => call<Array<{ mapId: string; status: MapStatus }>>("GET", "/api/maps/status"),
  /** Needs Affinity (503 when not connected). */
  targets: () => call<Targets>("GET", "/api/targets"),
  linkArtboard: (id: string, link: ArtboardLink) => call<{ map: MapSpec }>("POST", `/api/maps/${enc(id)}/link`, link),
  /** Sends the given maps, or every map that isn't up to date. */
  send: (opts: { mapIds?: string[]; reset?: boolean } = {}) => call<{ results: SendResult[] }>("POST", "/api/send", opts),

  // ---- data ----
  features: (role: RoleId, opts: FeaturesQuery = {}) =>
    call<{ total: number; rows: FeatureRow[] }>("GET", `/api/data/${enc(role)}/features${query({ ...opts })}`),
  match: (role: RoleId, filter: string) => call<{ fids: string[] }>("GET", `/api/data/${enc(role)}/match${query({ filter })}`),
  /** Selects the matching objects on that map in Affinity. Needs Affinity. */
  selectOnMap: (role: RoleId, mapId: string, filter: string) =>
    call<{ matched: number; selected: number }>("POST", `/api/data/${enc(role)}/select`, { mapId, filter }),

  // ---- other ----
  affinity: () => call<{ connected: boolean; busy: boolean }>("GET", "/api/affinity"),
  scripts: () => call<ScriptsInfo>("GET", "/api/scripts"),
};
