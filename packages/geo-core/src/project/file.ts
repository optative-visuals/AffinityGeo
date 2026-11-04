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

/** A version 1 project (0.1.0): one area, no locations, data/<role>.json. Becomes one box location called "loc-1". */
function migrateV1(project: Project): void {
  const old = project as unknown as { version: number; area: AreaSpec; maps: Project["maps"]; dataVersion: number; fetchedAt: string | null };
  project.locations = [{
    id: "loc-1", name: firstPart(old.area.placeName) || "Location 1", placeName: old.area.placeName,
    kind: "box", ring: boxRing(old.area.bboxWgs84), contextM: 0,
    dataVersion: old.dataVersion, fetchedAt: old.fetchedAt,
  }];
  for (const m of old.maps) { m.locationId = "loc-1"; m.showContext = false; }
  old.version = 2; // the area stays exactly as it was: no syncArea
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
  const read = (name: string): Dataset | undefined => {
    const e = entries.find((x) => x.name === name);
    return e ? JSON.parse(dec(e.data)) as Dataset : undefined;
  };
  const wasV1 = project.version < 2;
  if (wasV1) migrateV1(project);
  const snap: ProjectSnapshot = { locations: {}, files: {} };
  for (const loc of project.locations) snap.locations[loc.id] = {};
  for (const role of ROLES) {
    const isFile = project.sources[role]?.kind === "file";
    if (wasV1) {
      const ds = read(`data/${role}.json`);
      if (ds) (isFile ? snap.files : snap.locations["loc-1"]!)[role] = ds;
      continue;
    }
    const fileDs = read(`files/${role}.json`);
    if (fileDs) snap.files[role] = fileDs;
    for (const loc of project.locations) {
      const ds = read(`data/${loc.id}/${role}.json`);
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
