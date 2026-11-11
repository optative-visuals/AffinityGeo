import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import type { Dataset } from "../types.js";
import { ROLE_IDS } from "./roles.js";
import { paperFor, styleFromPreset } from "./styles.js";
import { readZip, writeZip } from "./zip.js";
import type { ZipEntry } from "./zip.js";
import { boxRing, fetchRing, ringBbox } from "./location.js";
import type {
  AreaSpec, LocationSpec, Project, ProjectData, ProjectSnapshot, RoleId, RoleSource,
} from "./types.js";

const NOT_A_PROJECT = "This isn't an AffinityGeo project file.";
const DAMAGED = "This project file is damaged and can't be opened.";
const TOO_NEW = "This project was made by a newer AffinityGeo.";

const ROLES: RoleId[] = ROLE_IDS;

/** The part of a place name before the first comma ("Hyde Park, London" -> "Hyde Park"). */
function firstPart(name: string): string {
  return (name.split(",")[0] ?? "").trim();
}

export function newProject(
  name: string, area: AreaSpec, presetName: string, first: Omit<LocationSpec, "id" | "dataVersion" | "fetchedAt">,
): Project {
  const sources = {} as Project["sources"];
  ROLES.forEach((r) => { sources[r] = { kind: "osm" }; });
  return {
    version: 2, id: randomUUID(), name, area,
    locations: [{ ...first, id: "loc-1", dataVersion: 0, fetchedAt: null }],
    sources, style: styleFromPreset(presetName),
    maps: [], dataVersion: 0, fetchedAt: null,
  };
}

/** Keeps area.bboxWgs84 (the union of every location's fetch area) and area.placeName (the first location's) in step. Mutates. */
export function syncArea(project: Project): void {
  const first = project.locations[0];
  if (!first) return;
  let [w, s, e, n] = ringBbox(fetchRing(first));
  for (const loc of project.locations.slice(1)) {
    const b = ringBbox(fetchRing(loc));
    w = Math.min(w, b[0]); s = Math.min(s, b[1]); e = Math.max(e, b[2]); n = Math.max(n, b[3]);
  }
  project.area.bboxWgs84 = [w, s, e, n];
  project.area.placeName = first.placeName;
}

/** What one location's maps draw: file-source roles come from the project-wide files, the rest from the location's OSM snapshot. */
export function dataFor(project: Project, snap: ProjectSnapshot, locationId: string): ProjectData {
  const out: ProjectData = {};
  for (const role of ROLES) {
    const ds = project.sources[role].kind === "file" ? snap.files[role] : snap.locations[locationId]?.[role];
    if (ds) out[role] = ds;
  }
  return out;
}

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

let tmpCounter = 0;

/** Windows refuses a rename (EPERM, EACCES, EBUSY) while another process or save briefly holds the file: retry a few times. */
async function renameRetrying(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { await rename(from, to); return; } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (attempt >= 6 || (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY")) throw e;
      await new Promise((r) => setTimeout(r, 20 * (attempt + 1)));
    }
  }
}


/**
 * Saves atomically: writes a temp file of its own (`<path>.<pid>.<n>.tmp`, so two saves never
 * share one), then renames it over `<path>`. A failed save removes its temp file.
 * Layout: project.json, data/<locationId>/<role>.json (OSM), files/<role>.json (file sources).
 */
export async function saveProject(path: string, project: Project, snap: ProjectSnapshot): Promise<void> {
  const entries: ZipEntry[] = [{ name: "project.json", data: enc(JSON.stringify(project)) }];
  for (const [locationId, data] of Object.entries(snap.locations)) {
    for (const role of ROLES) {
      const ds = data[role];
      if (ds) entries.push({ name: `data/${locationId}/${role}.json`, data: enc(JSON.stringify(ds)) });
    }
  }
  for (const role of ROLES) {
    const ds = snap.files[role];
    if (ds) entries.push({ name: `files/${role}.json`, data: enc(JSON.stringify(ds)) });
  }
  const tmp = `${path}.${process.pid}.${++tmpCounter}.tmp`;
  try {
    await writeFile(tmp, writeZip(entries));
    await renameRetrying(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isNums = (v: unknown, n: number): boolean => Array.isArray(v) && v.length === n && v.every(isNum);
const isRing = (v: unknown): boolean => Array.isArray(v) && v.length >= 3 && v.every((pt) => isNums(pt, 2));
const isArea = (v: unknown): boolean => isObj(v) && isNums(v.bboxWgs84, 4);

/** A version 1 project (0.1.0): one area, no locations, data/<role>.json. Becomes one box location called "loc-1". */
function migrateV1(project: Project): void {
  const old = project as unknown as { version: number; area: AreaSpec; maps: Project["maps"]; dataVersion: number; fetchedAt: string | null };
  if (!isArea(old.area) || !Array.isArray(old.maps) || !old.maps.every(isObj)) throw new Error(DAMAGED);
  const placeName = isStr(old.area.placeName) ? old.area.placeName : "";
  project.locations = [{
    id: "loc-1", name: firstPart(placeName) || "Location 1", placeName,
    kind: "box", ring: boxRing(old.area.bboxWgs84), contextM: 0,
    dataVersion: isNum(old.dataVersion) ? old.dataVersion : 0, fetchedAt: old.fetchedAt ?? null,
  }];
  for (const m of old.maps) { m.locationId = "loc-1"; m.showContext = false; }
  old.version = 2; // the area stays exactly as it was: no syncArea
}

/**
 * Checks the shape of a (migrated) project so a hand-edited or damaged file gives one friendly error
 * instead of a TypeError later. Optional newer fields that older files may lack are defaulted, not rejected.
 */
function validateProject(project: Project): void {
  const bad = (): never => { throw new Error(DAMAGED); };
  const p = project as unknown as Record<string, unknown>;
  if (!isStr(p.id) || !isStr(p.name)) bad();
  const area = p.area;
  if (!isObj(area) || !isNums(area.bboxWgs84, 4) || !isStr(area.projectionId)) bad();
  if (!isStr((area as Record<string, unknown>).placeName)) (area as Record<string, unknown>).placeName = "";

  const locations = p.locations;
  if (!Array.isArray(locations) || locations.length === 0) bad();
  const ids = new Set<string>();
  for (const l of locations as unknown[]) {
    if (!isObj(l) || !isStr(l.id) || !isStr(l.name) || (l.kind !== "box" && l.kind !== "shape") ||
        !isRing(l.ring) || !isNum(l.contextM)) bad();
    const loc = l as Record<string, unknown>;
    ids.add(loc.id as string);
    if (!isStr(loc.placeName)) loc.placeName = loc.name;
    if (!isNum(loc.dataVersion)) loc.dataVersion = 0;
    if (!isStr(loc.fetchedAt)) loc.fetchedAt = null;
  }

  const sources = p.sources;
  if (!isObj(sources) || !ROLES.every((r) => isObj(sources[r]) && isStr((sources[r] as Record<string, unknown>).kind))) bad();

  const style = p.style;
  if (!isObj(style) || !isObj(style.roles) || !ROLES.every((r) => isObj((style.roles as Record<string, unknown>)[r])) ||
      !isObj(style.marker)) bad();

  const maps = p.maps;
  if (!Array.isArray(maps)) bad();
  for (const m of maps as unknown[]) {
    if (!isObj(m) || !isStr(m.id) || !isStr(m.name) || !isNums(m.centre, 2) || !isNum(m.scale) || !isNum(m.rotationDeg) ||
        !isObj(m.sizeMm) || !isNum(m.sizeMm.width) || !isNum(m.sizeMm.height) ||
        !isStr(m.locationId) || !ids.has(m.locationId)) bad();
    const map = m as Record<string, unknown>;
    if (typeof map.showContext !== "boolean") map.showContext = false;
    if (typeof map.marker !== "boolean") map.marker = false; // a map with no marker setting drew none: keep that
    if (map.target === undefined) map.target = null;
    if (map.resizeArtboard === undefined) map.resizeArtboard = null;
    if (map.sent === undefined) map.sent = null;
  }

  if (p.dataVersion === undefined) p.dataVersion = 0;
  else if (!isNum(p.dataVersion)) bad();
  if (p.fetchedAt === undefined) p.fetchedAt = null;
}

export async function loadProject(path: string): Promise<{ project: Project; snap: ProjectSnapshot }> {
  const bytes = await readFile(path);
  let entries: ZipEntry[];
  try { entries = readZip(bytes); } catch { throw new Error(NOT_A_PROJECT); }
  const pj = entries.find((e) => e.name === "project.json");
  if (!pj) throw new Error(NOT_A_PROJECT);
  let project: Project;
  try { project = JSON.parse(dec(pj.data)) as Project; } catch { throw new Error(NOT_A_PROJECT); }
  if (typeof project !== "object" || project === null || typeof project.version !== "number") throw new Error(NOT_A_PROJECT);
  if (project.version > 2) throw new Error(TOO_NEW);
  // Projects saved before the map background existed have no paper: give them their preset's.
  // A paper that isn't a #rrggbb colour (hand-edited file) is treated the same way.
  if (project.style && typeof project.style === "object" &&
      (typeof project.style.paper !== "string" || !/^#[0-9a-f]{6}$/i.test(project.style.paper))) {
    project.style.paper = paperFor(String(project.style.presetName));
  }
  const wasV1 = project.version < 2;
  if (wasV1) migrateV1(project);
  validateProject(project);
  const read = (name: string, role: RoleId): Dataset | undefined => {
    const e = entries.find((x) => x.name === name);
    if (!e) return undefined;
    try {
      const ds = JSON.parse(dec(e.data)) as Dataset;
      if (isObj(ds) && Array.isArray(ds.features)) return ds;
    } catch { /* falls through to the friendly error */ }
    throw new Error(`This project's data for '${role}' is damaged and can't be read.`);
  };
  const snap: ProjectSnapshot = { locations: {}, files: {} };
  for (const loc of project.locations) snap.locations[loc.id] = {};
  for (const role of ROLES) {
    const isFile = project.sources[role].kind === "file";
    if (wasV1) {
      const ds = read(`data/${role}.json`, role);
      if (ds) (isFile ? snap.files : snap.locations["loc-1"]!)[role] = ds;
      continue;
    }
    const fileDs = read(`files/${role}.json`, role);
    if (fileDs) snap.files[role] = fileDs;
    for (const loc of project.locations) {
      const ds = read(`data/${loc.id}/${role}.json`, role);
      if (ds) snap.locations[loc.id]![role] = ds;
    }
  }
  return { project, snap };
}

/** Pure. A file source needs its dataset; switching back to OpenStreetMap clears that role's file dataset (each location's own snapshot is kept). */
export function setRoleSource(
  project: Project, snap: ProjectSnapshot, role: RoleId, source: RoleSource, dataset?: Dataset,
): { project: Project; snap: ProjectSnapshot } {
  const files: ProjectData = { ...snap.files };
  if (source.kind === "file") {
    if (!dataset) throw new Error("A file source needs its dataset.");
    files[role] = dataset;
  } else {
    delete files[role];
  }
  return {
    project: { ...project, sources: { ...project.sources, [role]: source } },
    snap: { locations: snap.locations, files },
  };
}
