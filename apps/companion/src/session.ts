// The one open project: its file, its data snapshot and whether it has unsaved changes.
import { randomBytes } from "node:crypto";
import {
  DataError, PROJECTIONS, ROLE_IDS, TOO_BIG, areaWarning, fetchOsm as realFetchOsm, getProjection, loadProject, mapStatusHash,
  newProject, parseFilter, projectDataset, readDataset, saveProject, setRoleSource, simplifyLayerToTolerance, styleFromPreset,
  suggestProjection, utmParams,
  type AreaSpec, type Bbox, type Dataset, type GeometryKind, type Position, type MapSpec, type MapTarget, type MarkerStyle, type Project, type ProjectData,
  type ProjectStyle, type RoleId, type RoleSource, type RoleStyle,
} from "@affinitygeo/geo-core";

/** An error with the HTTP status the API answers with. Messages are shown to the designer as they are. */
export class ApiError extends Error {
  /** `code`: a stable marker the app can test for (e.g. "NEEDS_PATH"), sent beside the message. */
  constructor(public status: number, message: string, public code?: string) {
    super(message);
    this.name = "ApiError";
  }
}

export type MapStatus = "Not sent" | "Up to date" | "Changed since sent" | "Target not open";

/** The shape connect.js's listTargets returns. */
export interface Targets {
  documents: Array<{
    docId: string; title: string;
    artboards: Array<{ name: string; mapIds: Array<{ projectId: string; mapId: string }>; widthMm: number; heightMm: number }>;
  }>;
}

export interface NewMapInput {
  name: string; centre: [number, number]; scale?: number; rotationDeg?: number;
  sizeMm?: { width: number; height: number }; marker?: boolean;
}

export type FetchOsm = (bboxWgs84: Bbox) => Promise<ProjectData>;

const NO_PROJECT = "No project is open. Create or open a project first.";
const NO_MAP = "There's no map with that id in this project.";
const NEEDS_PATH = "Choose where to save the project first.";
const NO_FILE = "There's no project file at that path.";
const HEX = /^#[0-9a-f]{6}$/i;

const bad = (message: string) => new ApiError(400, message);

/** The area preview simplifies to this many metres: the UI draws it small, so finer detail is wasted bytes. */
const PREVIEW_TOLERANCE_M = 0.5;

export interface AreaPreview {
  bounds: [number, number, number, number];
  layers: Array<{ role: RoleId; kind: GeometryKind; features: Array<{ fid: string; name: string; paths: number[][][] }> }>;
}

export interface ProjectionOption {
  id: "bng" | "utm"; name: string; description: string; params?: Record<string, number>; suggested: boolean;
}

/** Every role's data in projected metres, simplified to 0.5 m, with no style or visibility (the UI applies those). */
export function buildAreaPreview(project: Project, data: ProjectData): AreaPreview {
  const proj = getProjection(project.area.projectionId, project.area.projectionParams ?? {});
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const layers: AreaPreview["layers"] = [];
  for (const role of ROLE_IDS) {
    const ds = data[role];
    if (!ds || !ds.features.length) continue;
    const { layer } = simplifyLayerToTolerance(projectDataset(ds, proj), PREVIEW_TOLERANCE_M);
    const features: AreaPreview["layers"][number]["features"] = [];
    for (const f of layer.features) {
      const paths = geometryPaths(f.geometry);
      for (const path of paths) for (const [x, y] of path) {
        if (x! < minX) minX = x!;
        if (x! > maxX) maxX = x!;
        if (y! < minY) minY = y!;
        if (y! > maxY) maxY = y!;
      }
      if (paths.length) features.push({ fid: f.fid, name: f.name, paths });
    }
    if (features.length) layers.push({ role, kind: layer.kind, features });
  }
  return { bounds: layers.length ? [minX, minY, maxX, maxY] : [0, 0, 0, 0], layers };
}

/** Rings and lines become paths; a point is a one-position path. */
function geometryPaths(g: Dataset["features"][number]["geometry"]): number[][][] {
  const pos = (p: Position): number[] => [p[0], p[1]];
  switch (g.type) {
    case "Point": return [[pos(g.coordinates)]];
    case "MultiPoint": return g.coordinates.map((p) => [pos(p)]);
    case "LineString": return [g.coordinates.map(pos)];
    case "MultiLineString": case "Polygon": return g.coordinates.map((r) => r.map(pos));
    case "MultiPolygon": return g.coordinates.flatMap((p) => p.map((r) => r.map(pos)));
  }
}

function asNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && /^\s*-?\d+(\.\d+)?\s*$/.test(v)) return Number(v);
  return null;
}

/** Orders two non-null values for the features table: numbers (or numeric text) numerically, then text. */
function compareValues(a: unknown, b: unknown): number {
  const na = asNumber(a), nb = asNumber(b);
  if (na !== null && nb !== null) return na - nb;
  if (na !== null) return -1; // numbers before text
  if (nb !== null) return 1;
  return String(a).localeCompare(String(b), "en-GB", { numeric: true, sensitivity: "base" });
}

function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32).replace(/-+$/g, "") || "map";
}

function randomSuffix(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from(randomBytes(6), (b) => chars[b % chars.length]).join("");
}

export function checkRole(role: string): RoleId {
  if (!(ROLE_IDS as string[]).includes(role)) throw new ApiError(404, `There's no map layer called '${role}'.`);
  return role as RoleId;
}

function checkBbox(v: unknown): Bbox {
  if (!Array.isArray(v) || v.length !== 4 || !v.every(isNum)) throw bad("Choose an area on the map first.");
  const [w, s, e, n] = v as Bbox;
  if (w >= e || s >= n || w < -180 || e > 180 || s < -90 || n > 90) throw bad("Choose an area on the map first.");
  return [w, s, e, n];
}

function checkCentre(v: unknown): [number, number] {
  if (!Array.isArray(v) || v.length !== 2 || !v.every(isNum) || Math.abs(v[0]) > 180 || Math.abs(v[1]) > 90) {
    throw bad("The map centre must be a longitude and latitude, for example [-0.1665, 51.505].");
  }
  return [v[0], v[1]];
}

function checkSize(v: unknown): { width: number; height: number } {
  const s = v as { width?: unknown; height?: unknown } | null;
  if (!s || typeof s !== "object" || !isNum(s.width) || !isNum(s.height) || s.width <= 0 || s.height <= 0) {
    throw bad("The map size must be a width and height in millimetres.");
  }
  return { width: s.width, height: s.height };
}

function checkTarget(v: unknown): MapTarget | null {
  if (v === null) return null;
  const t = v as { docId?: unknown; docTitle?: unknown } | null;
  if (!t || typeof t !== "object" || typeof t.docId !== "string" || typeof t.docTitle !== "string") {
    throw bad("The target must be a document id and title.");
  }
  return { docId: t.docId, docTitle: t.docTitle };
}

const COLOUR = (key: string) => (v: unknown) => v === null || (typeof v === "string" && HEX.test(v)) ? null : `${key} must be a colour like #1a2b3c, or null for none.`;
const NUMBER = (key: string) => (v: unknown) => isNum(v) && v >= 0 ? null : `${key} must be a number of 0 or more.`;
const BOOL = (key: string) => (v: unknown) => typeof v === "boolean" ? null : `${key} must be true or false.`;

const ROLE_STYLE_CHECKS: Record<keyof RoleStyle, (v: unknown) => string | null> = {
  fill: COLOUR("Fill"), stroke: COLOUR("Stroke"), strokePt: NUMBER("Stroke width"),
  visible: BOOL("Visible"), order: NUMBER("Order"), pointRadiusPt: NUMBER("Point size"),
};
const MARKER_CHECKS: Record<keyof MarkerStyle, (v: unknown) => string | null> = {
  dot: (v) => typeof v === "string" && HEX.test(v) ? null : "The marker dot must be a colour like #1a2b3c.",
  ring: (v) => typeof v === "string" && HEX.test(v) ? null : "The marker ring must be a colour like #1a2b3c.",
  text: (v) => typeof v === "string" && HEX.test(v) ? null : "The marker text must be a colour like #1a2b3c.",
  textPt: (v) => isNum(v) && v > 0 ? null : "The marker text size must be a number above 0.",
  label: (v) => typeof v === "string" ? null : "The marker label must be text.",
};

function mergeChecked<T extends object>(base: T, patch: unknown, checks: Record<keyof T, (v: unknown) => string | null>, what: string): T {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw bad(`${what} must be a set of style settings.`);
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    const check = checks[k as keyof T];
    if (!check) throw bad(`${what} has no setting called '${k}'.`);
    const problem = check(v);
    if (problem) throw bad(problem);
    (out as Record<string, unknown>)[k] = typeof v === "string" && k !== "label" ? v.toLowerCase() : v;
  }
  return out;
}

export class ProjectSession {
  project: Project | null = null;
  data: ProjectData = {};
  path: string | null = null;
  dirty = false;
  /** Counts every change, so a save can tell whether something changed while it was writing. */
  private changes = 0;
  /** The save in progress, if any: saves run one at a time, each snapshotting the project when its turn comes. */
  private saving: Promise<unknown> | null = null;
  private fetchOsm: FetchOsm;
  private saveFile: typeof saveProject;
  private now: () => Date;
  private makePreview: typeof buildAreaPreview;
  /** Bumped by every source change, so the preview cache can't survive one. */
  private sourceEpoch = 0;
  private preview: { key: string; value: AreaPreview } | null = null;

  constructor(opts: { fetchOsm?: FetchOsm; now?: () => Date; saveProject?: typeof saveProject; buildAreaPreview?: typeof buildAreaPreview } = {}) {
    this.makePreview = opts.buildAreaPreview ?? buildAreaPreview;
    this.fetchOsm = opts.fetchOsm ?? ((b) => realFetchOsm(b));
    this.saveFile = opts.saveProject ?? saveProject;
    this.now = opts.now ?? (() => new Date());
  }

  /** The open project; throws 409 when there isn't one. */
  get current(): Project {
    if (!this.project) throw new ApiError(409, NO_PROJECT);
    return this.project;
  }

  private changed(): void { this.dirty = true; this.changes += 1; }

  // ---- project ----

  create(name: string, area: { placeName: string; bboxWgs84: unknown }, presetName: string): { project: Project; warning: string | null } {
    if (typeof name !== "string" || !name.trim()) throw bad('Please give the project a name.');
    if (!area || typeof area !== "object") throw bad("Choose an area on the map first.");
    const bbox = checkBbox(area.bboxWgs84);
    const placeName = typeof area.placeName === "string" ? area.placeName : "";
    // Street maps need a projection in metres: British National Grid in Great Britain, UTM elsewhere.
    const s = suggestProjection(bbox);
    if (s.id !== "bng" && s.id !== "utm") throw bad(TOO_BIG);
    const area2: AreaSpec = { placeName, bboxWgs84: bbox, projectionId: s.id, ...(s.params ? { projectionParams: s.params } : {}) };
    let made: Project;
    try { made = newProject(name.trim(), area2, presetName); } catch (e) { throw bad((e as Error).message); }
    this.project = made;
    this.data = {};
    this.path = null;
    this.preview = null;
    this.changed();
    return { project: made, warning: areaWarning(bbox) };
  }

  async open(path: string): Promise<Project> {
    if (typeof path !== "string" || !path.trim()) throw bad("Please provide the project file's path.");
    let loaded;
    try {
      loaded = await loadProject(path);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT") throw bad(NO_FILE);
      if (code === "EISDIR") throw bad("That path is a folder, not a project file.");
      throw bad((e as Error).message);
    }
    this.project = loaded.project;
    this.data = loaded.data;
    this.path = path;
    this.preview = null;
    this.dirty = false;
    this.changes += 1; // a save of the previous project that is still writing must not mark this one saved
    return loaded.project;
  }

  save(path?: string): Promise<void> {
    // Nothing being saved: start now (the snapshot is taken straight away). Otherwise wait for it.
    const run = this.saving ? this.saving.then(() => this.saveNow(path)) : this.saveNow(path);
    const tail = run.catch(() => undefined);
    this.saving = tail;
    void tail.then(() => { if (this.saving === tail) this.saving = null; });
    return run;
  }

  private async saveNow(path?: string): Promise<void> {
    const project = this.current;
    const to = path ?? this.path;
    if (typeof to !== "string" || !to.trim()) throw new ApiError(400, NEEDS_PATH, "NEEDS_PATH");
    const at = this.changes;
    try {
      await this.saveFile(to, project, this.data);
    } catch (e) {
      throw bad(`The project couldn't be saved: ${(e as Error).message}`);
    }
    if (this.project !== project) return; // another project was opened meanwhile
    this.path = to;
    // Only clean if nothing changed while the file was being written.
    if (this.changes === at) this.dirty = false;
  }

  counts(): Record<RoleId, number> {
    this.current;
    const out = {} as Record<RoleId, number>;
    for (const r of ROLE_IDS) out[r] = this.data[r]?.features.length ?? 0;
    return out;
  }

  // ---- data ----

  /** Fetches OpenStreetMap again for every layer that uses it. On failure nothing changes. */
  async refresh(): Promise<{ counts: Record<RoleId, number>; changed: Partial<Record<RoleId, { before: number; after: number }>> }> {
    const project = this.current;
    let fresh: ProjectData;
    try {
      fresh = await this.fetchOsm(project.area.bboxWgs84);
    } catch (e) {
      if (e instanceof DataError) throw new ApiError(503, e.message);
      throw e;
    }
    if (this.project !== project) throw new ApiError(409, "The project was closed while its data was being fetched.");
    const before = this.counts();
    const data: ProjectData = { ...this.data };
    let dataChanged = false;
    for (const r of ROLE_IDS) {
      if (project.sources[r].kind !== "osm") continue; // the designer's own files stay as they are
      if (fresh[r]) data[r] = fresh[r]; else delete data[r];
      if (JSON.stringify(data[r] ?? null) !== JSON.stringify(this.data[r] ?? null)) dataChanged = true;
    }
    this.data = data;
    // Same data again: maps sent from it are still up to date.
    if (dataChanged) project.dataVersion += 1;
    project.fetchedAt = this.now().toISOString();
    this.changed();
    const counts = this.counts();
    const changed: Partial<Record<RoleId, { before: number; after: number }>> = {};
    for (const r of ROLE_IDS) if (before[r] !== counts[r]) changed[r] = { before: before[r], after: counts[r] };
    return { counts, changed };
  }

  /** Uses the designer's own file for one layer. `datasetName` picks a layer from a multi-layer file. */
  async importFile(path: string, roleIn: string, datasetName?: string): Promise<Record<RoleId, number>> {
    const project = this.current;
    const role = checkRole(roleIn);
    if (typeof path !== "string" || !path.trim()) throw bad("Please provide the file's path.");
    let sets: Dataset[];
    try { sets = await readDataset(path); } catch (e) { throw bad((e as Error).message); }
    const ds = datasetName ? sets.find((d) => d.name === datasetName) : sets.find((d) => d.features.length);
    if (!ds) throw bad(datasetName ? `That file has no layer called '${datasetName}'.` : "That file has no features to use.");
    if (this.project !== project) throw new ApiError(409, "The project was closed while the file was being read.");
    this.applySource(role, { kind: "file", path, datasetName: ds.name }, ds);
    return this.counts();
  }

  setSource(roleIn: string, source: RoleSource): Record<RoleId, number> {
    this.current;
    const role = checkRole(roleIn);
    if (!source || source.kind !== "osm") throw bad('To use a file, import it. Only { "kind": "osm" } can be set here.');
    this.applySource(role, source);
    return this.counts();
  }

  private applySource(role: RoleId, source: RoleSource, ds?: Dataset): void {
    const next = setRoleSource(this.current, this.data, role, source, ds);
    // Keep the same project object (in-flight sends look it up by identity).
    Object.assign(this.current, next.project);
    this.current.dataVersion += 1;
    this.sourceEpoch += 1;
    this.data = next.data;
    this.changed();
  }

  features(roleIn: string, q: string, offset: number, limit: number, sort?: string, dir: string = "asc"): { total: number; rows: Array<{ fid: string; name: string; attrs: Dataset["features"][number]["attrs"] }> } {
    this.current;
    const role = checkRole(roleIn);
    const needle = q.trim().toLowerCase();
    const all = this.data[role]?.features ?? [];
    const hits = needle
      ? all.filter((f) => f.name.toLowerCase().includes(needle)
        || Object.values(f.attrs).some((v) => v !== null && String(v).toLowerCase().includes(needle)))
      : all;
    if (dir !== "asc" && dir !== "desc") throw bad("dir must be asc or desc.");
    let ordered = hits;
    if (sort) {
      const value = (f: Dataset["features"][number]) => sort === "name" ? f.name : f.attrs[sort] ?? null;
      const sign = dir === "desc" ? -1 : 1;
      // Array.prototype.sort is stable, so ties keep their file order. Nulls go last in both directions.
      ordered = [...hits].sort((x, y) => {
        const a = value(x), b = value(y);
        if (a === null && b === null) return 0;
        if (a === null) return 1;
        if (b === null) return -1;
        return sign * compareValues(a, b);
      });
    }
    return { total: ordered.length, rows: ordered.slice(offset, offset + limit).map((f) => ({ fid: f.fid, name: f.name, attrs: f.attrs })) };
  }

  /** fids in a layer matching a filter; throws FilterError (with its position) for a bad filter. */
  matching(roleIn: string, filter: string): { role: RoleId; fids: string[] } {
    this.current;
    const role = checkRole(roleIn);
    if (typeof filter !== "string") throw bad('Please provide "filter".');
    const predicate = parseFilter(filter);
    return { role, fids: (this.data[role]?.features ?? []).filter((f) => predicate(f.attrs)).map((f) => f.fid) };
  }

  // ---- area preview and projection ----

  /** The whole area in projected metres for the app's map view; cached until the data, projection or a source changes. */
  areaPreview(): AreaPreview {
    const project = this.current;
    if (!ROLE_IDS.some((r) => this.data[r]?.features.length)) throw new ApiError(409, "Fetch the data first.");
    const key = JSON.stringify([project.id, project.dataVersion, project.area.projectionId, project.area.projectionParams ?? null, this.sourceEpoch]);
    if (this.preview?.key === key) return this.preview.value;
    const value = this.makePreview(project, this.data);
    this.preview = { key, value };
    return value;
  }

  /** The metric projections that suit this area: British National Grid only inside its envelope, UTM always. */
  projections(): ProjectionOption[] {
    const { bboxWgs84 } = this.current.area;
    const pick = suggestProjection(bboxWgs84);
    const def = (id: string) => PROJECTIONS.find((p) => p.id === id)!;
    const out: ProjectionOption[] = [];
    if (pick.id === "bng") out.push({ id: "bng", name: def("bng").name, description: def("bng").description, suggested: true });
    out.push({
      id: "utm", name: def("utm").name, description: def("utm").description,
      params: { ...utmParams(bboxWgs84) }, suggested: pick.id === "utm",
    });
    return out;
  }

  setProjection(projectionId: unknown, params?: unknown): Project {
    const project = this.current;
    const option = this.projections().find((o) => o.id === projectionId);
    if (!option) throw bad("That projection doesn't suit this area. Choose one of the options offered.");
    if (params !== undefined && params !== null) {
      const given = params as Record<string, unknown>;
      const want = option.params ?? {};
      const same = typeof given === "object" && !Array.isArray(given)
        && Object.keys(want).every((k) => given[k] === want[k]) && Object.keys(given).every((k) => k in want);
      if (!same) throw bad("Those projection settings don't suit this area. Use the ones offered.");
    } // no settings given: the ones offered for this area are used
    const area: AreaSpec = { ...project.area, projectionId: option.id };
    if (option.params) area.projectionParams = { ...option.params }; else delete area.projectionParams;
    project.area = area;
    this.preview = null;
    this.changed();
    return project;
  }

  // ---- style ----

  updateStyle(patch: { roles?: unknown; marker?: unknown; paper?: unknown }): ProjectStyle {
    const project = this.current;
    if (!patch || typeof patch !== "object") throw bad("Send the style changes as an object.");
    const style = structuredClone(project.style);
    if (patch.paper !== undefined) {
      if (typeof patch.paper !== "string" || !HEX.test(patch.paper)) throw bad("The background must be a colour like #1a2b3c.");
      style.paper = patch.paper.toLowerCase();
    }
    if (patch.roles !== undefined) {
      if (!patch.roles || typeof patch.roles !== "object") throw bad("roles must be a set of map layers.");
      for (const [role, rp] of Object.entries(patch.roles)) {
        if (!(ROLE_IDS as string[]).includes(role)) throw bad(`There's no map layer called '${role}'.`);
        style.roles[role as RoleId] = mergeChecked(style.roles[role as RoleId], rp, ROLE_STYLE_CHECKS, "A layer style");
      }
    }
    if (patch.marker !== undefined) style.marker = mergeChecked(style.marker, patch.marker, MARKER_CHECKS, "The marker style");
    project.style = style;
    this.changed();
    return style;
  }

  applyPreset(name: string): ProjectStyle {
    const project = this.current;
    try { project.style = styleFromPreset(name); } catch (e) { throw bad((e as Error).message); }
    this.changed();
    return project.style;
  }

  // ---- maps ----

  map(id: string): MapSpec {
    const m = this.current.maps.find((x) => x.id === id);
    if (!m) throw new ApiError(404, NO_MAP);
    return m;
  }

  addMap(input: NewMapInput): MapSpec {
    const project = this.current;
    if (!input || typeof input.name !== "string" || !input.name.trim()) throw bad("Please give the map a name.");
    const draft: MapSpec = {
      id: "", name: input.name.trim(), centre: checkCentre(input.centre), scale: 2500, rotationDeg: 0,
      sizeMm: { width: 420, height: 297 }, marker: true, target: null, resizeArtboard: null, sent: null,
    };
    const { name: _n, centre: _c, ...rest } = input;
    const map = { ...draft, ...this.checkedPatch(rest as Partial<MapSpec>) };
    do { map.id = `${slug(map.name)}-${randomSuffix()}`; } while (project.maps.some((m) => m.id === map.id));
    project.maps.push(map);
    this.changed();
    return map;
  }

  patchMap(id: string, patch: Partial<MapSpec>): MapSpec {
    const map = this.map(id);
    Object.assign(map, this.checkedPatch(patch));
    this.changed();
    return map;
  }

  deleteMap(id: string): void {
    const project = this.current;
    this.map(id);
    project.maps = project.maps.filter((m) => m.id !== id);
    this.changed();
  }

  private checkedPatch(patch: Partial<MapSpec>): Partial<MapSpec> {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw bad("Send the map settings as an object.");
    const out: Partial<MapSpec> = {};
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      switch (k) {
        case "name":
          if (typeof v !== "string" || !v.trim()) throw bad("Please give the map a name.");
          out.name = v.trim(); break;
        case "centre": out.centre = checkCentre(v); break;
        case "scale":
          if (!isNum(v) || v < 100 || v > 1_000_000) throw bad("The scale must be a number from 100 to 1,000,000 (as in 1:2500).");
          out.scale = v; break;
        case "rotationDeg":
          if (!isNum(v)) throw bad("The rotation must be a number of degrees.");
          out.rotationDeg = v; break;
        case "sizeMm": out.sizeMm = checkSize(v); break;
        case "marker":
          if (typeof v !== "boolean") throw bad("marker must be true or false.");
          out.marker = v; break;
        case "target": out.target = checkTarget(v); break;
        case "resizeArtboard":
          if (v !== null && typeof v !== "boolean") throw bad("resizeArtboard must be true, false or null.");
          out.resizeArtboard = v; break;
        default:
          throw bad(`A map has no setting called '${k}' that can be changed.`);
      }
    }
    return out;
  }

  /**
   * Points a map at a chosen artboard (the link route, after Affinity tagged it). The size question is
   * asked again. When the map moved to another artboard, that artboard holds none of its drawing, so the
   * sent hash is cleared ("Changed since sent"); the sent object ids stay (the next send ignores them there).
   */
  linkMap(id: string, target: { docId: string; docTitle: string }, moved: boolean): MapSpec {
    const map = this.patchMap(id, { target, resizeArtboard: null });
    if (moved && map.sent) map.sent = { ...map.sent, hash: "" };
    return map;
  }

  // ---- sending ----

  statusHash(mapId: string): string {
    return mapStatusHash(this.current, mapId);
  }

  /** The open artboard tagged with this map, preferring one in the map's target document. */
  artboardFor(targets: Targets, mapId: string): { docId: string; index: number; widthMm: number; heightMm: number } | null {
    const project = this.current;
    const target = this.map(mapId).target;
    const hits: Array<{ docId: string; index: number; widthMm: number; heightMm: number }> = [];
    for (const d of targets.documents ?? []) {
      (d.artboards ?? []).forEach((ab, index) => {
        if ((ab.mapIds ?? []).some((m) => m.projectId === project.id && m.mapId === mapId)) {
          hits.push({ docId: d.docId, index, widthMm: ab.widthMm, heightMm: ab.heightMm });
        }
      });
    }
    // A target with a document id means that document only (never a Save-As copy elsewhere).
    if (target && target.docId) return hits.find((h) => h.docId === target.docId) ?? null;
    return hits[0] ?? null;
  }

  statusOf(targets: Targets, mapId: string): MapStatus {
    const map = this.map(mapId);
    if (map.target) {
      const t = map.target;
      // The document id survives save and reopen; a title only counts for a target recorded without one.
      const docOpen = (targets.documents ?? []).some((d) => (t.docId ? d.docId === t.docId : d.title === t.docTitle));
      if (!docOpen && !this.artboardFor(targets, mapId)) return "Target not open";
    }
    if (!map.sent) return "Not sent";
    return this.statusHash(mapId) === map.sent.hash ? "Up to date" : "Changed since sent";
  }

  statuses(targets: Targets): Array<{ mapId: string; status: MapStatus }> {
    return this.current.maps.map((m) => ({ mapId: m.id, status: this.statusOf(targets, m.id) }));
  }

  /**
   * Records a successful send. Ignored when the project or map has gone since the job was built.
   * A map with no target (or one without a document id) takes the document Affinity drew into;
   * a target with an id only ever has its title refreshed, never another document's id.
   */
  recordSent(projectId: string, mapId: string, hash: string, result: { objectIds?: unknown; docId?: unknown; docTitle?: unknown }): void {
    if (!this.project || this.project.id !== projectId) return;
    const map = this.project.maps.find((m) => m.id === mapId);
    if (!map) return;
    const objectIds = Array.isArray(result.objectIds) ? result.objectIds.filter((x): x is string => typeof x === "string") : [];
    map.sent = { at: this.now().toISOString(), hash, objectIds };
    if (typeof result.docId === "string" && result.docId && typeof result.docTitle === "string"
      && (!map.target || !map.target.docId || map.target.docId === result.docId)) {
      map.target = { docId: result.docId, docTitle: result.docTitle };
    }
    this.changed();
  }
}

