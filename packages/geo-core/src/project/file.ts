import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import type { Dataset } from "../types.js";
import { ROLE_IDS } from "./roles.js";
import { paperFor, styleFromPreset } from "./styles.js";
import { readZip, writeZip } from "./zip.js";
import type { ZipEntry } from "./zip.js";
import type {
  AreaSpec, Project, ProjectData, RoleId, RoleSource,
} from "./types.js";

const NOT_A_PROJECT = "This isn't an AffinityGeo project file.";
const TOO_NEW = "This project was made by a newer AffinityGeo.";

const ROLES: RoleId[] = ROLE_IDS;

export function newProject(name: string, area: AreaSpec, presetName: string): Project {
  const sources = {} as Project["sources"];
  ROLES.forEach((r) => { sources[r] = { kind: "osm" }; });
  return {
    version: 1, id: randomUUID(), name, area, sources,
    style: styleFromPreset(presetName),
    maps: [], dataVersion: 0, fetchedAt: null,
  };
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
 */
export async function saveProject(path: string, project: Project, data: ProjectData): Promise<void> {
  const entries: ZipEntry[] = [{ name: "project.json", data: enc(JSON.stringify(project)) }];
  for (const role of ROLES) {
    const ds = data[role];
    if (ds) entries.push({ name: `data/${role}.json`, data: enc(JSON.stringify(ds)) });
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

export async function loadProject(path: string): Promise<{ project: Project; data: ProjectData }> {
  const bytes = await readFile(path);
  let entries: ZipEntry[];
  try { entries = readZip(bytes); } catch { throw new Error(NOT_A_PROJECT); }
  const pj = entries.find((e) => e.name === "project.json");
  if (!pj) throw new Error(NOT_A_PROJECT);
  let project: Project;
  try { project = JSON.parse(dec(pj.data)) as Project; } catch { throw new Error(NOT_A_PROJECT); }
  if (typeof project !== "object" || project === null || typeof project.version !== "number") throw new Error(NOT_A_PROJECT);
  if (project.version > 1) throw new Error(TOO_NEW);
  // Projects saved before the map background existed have no paper: give them their preset's.
  // A paper that isn't a #rrggbb colour (hand-edited file) is treated the same way.
  if (project.style && typeof project.style === "object" &&
      (typeof project.style.paper !== "string" || !/^#[0-9a-f]{6}$/i.test(project.style.paper))) {
    project.style.paper = paperFor(String(project.style.presetName));
  }
  const data: ProjectData = {};
  for (const role of ROLES) {
    const e = entries.find((x) => x.name === `data/${role}.json`);
    if (e) data[role] = JSON.parse(dec(e.data)) as Dataset;
  }
  return { project, data };
}

/** Pure. A file source needs its dataset; switching back to OpenStreetMap clears that role's snapshot until the next refresh. */
export function setRoleSource(
  project: Project, data: ProjectData, role: RoleId, source: RoleSource, dataset?: Dataset,
): { project: Project; data: ProjectData } {
  const nextData: ProjectData = { ...data };
  if (source.kind === "file") {
    if (!dataset) throw new Error("A file source needs its dataset.");
    nextData[role] = dataset;
  } else {
    delete nextData[role];
  }
  return { project: { ...project, sources: { ...project.sources, [role]: source } }, data: nextData };
}
