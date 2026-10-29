import { mkdirSync, mkdtempSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Dataset } from "../../src/types.js";
import { loadProject, newProject, saveProject, setRoleSource } from "../../src/project/file.js";
import { writeZip } from "../../src/project/zip.js";
import type { AreaSpec, MapSpec, ProjectData } from "../../src/project/types.js";

const area: AreaSpec = { placeName: "Hyde Park", bboxWgs84: [-0.2, 51.47, -0.12, 51.53], projectionId: "bng" };
const ds = (name: string): Dataset => ({
  name, sourcePath: `${name}.geojson`, sourceFormat: "geojson",
  crs: { id: "EPSG:27700", proj4: "+proj=tmerc", label: "British National Grid" },
  kind: "polygon",
  features: [{ fid: "1", name: "A", geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }, attrs: { x: 1, y: null } }],
  report: { read: 1, skipped: 0, reasons: [] },
});
const map = (id: string): MapSpec => ({
  id, name: `Map ${id}`, centre: [-0.1665, 51.505], scale: 5000, rotationDeg: -30,
  sizeMm: { width: 297, height: 210 }, marker: true,
  target: { docId: "doc1", docTitle: "Sign.afdesign" }, resizeArtboard: null, sent: null,
});
const tmp = () => mkdtempSync(join(tmpdir(), "afgeo-"));

describe("newProject", () => {
  it("starts with OSM sources, no maps and no data", () => {
    const p = newProject("Campus", area, "Light");
    expect(p.version).toBe(1);
    expect(p.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(p.dataVersion).toBe(0);
    expect(p.maps).toEqual([]);
    expect(p.fetchedAt).toBeNull();
    expect(p.style.presetName).toBe("Light");
    expect(Object.keys(p.sources)).toHaveLength(12);
    expect(Object.values(p.sources).every((s) => s.kind === "osm")).toBe(true);
  });
});

describe("saveProject / loadProject", () => {
  it("round-trips a project with 2 maps and 3 roles of data", async () => {
    const path = join(tmp(), "campus.afgeo");
    const project = { ...newProject("Campus", area, "Light"), maps: [map("a"), map("b")], dataVersion: 3, fetchedAt: "2026-10-28T10:00:00Z" };
    const data: ProjectData = { water: ds("Water"), buildings: ds("Buildings"), paths: ds("Paths") };
    await saveProject(path, project, data);
    expect(readdirSync(join(path, ".."))).toEqual(["campus.afgeo"]); // no .tmp left behind
    const loaded = await loadProject(path);
    expect(loaded.project).toEqual(project);
    expect(loaded.data).toEqual(data);
    expect(Object.keys(loaded.data).sort()).toEqual(["buildings", "paths", "water"]);
  });

  it("saves to one path at once each use their own temp file: all succeed, none left behind", async () => {
    const dir = tmp();
    const path = join(dir, "campus.afgeo");
    const data: ProjectData = { water: ds("Water") };
    const saves = Array.from({ length: 20 }, (_, n) => n).map((n) => saveProject(path, { ...newProject(`P${n}`, area, "Light") }, data));
    await Promise.all(saves);
    expect(readdirSync(dir)).toEqual(["campus.afgeo"]);
  });

  it("a failed save removes its temp file", async () => {
    const dir = tmp();
    const path = join(dir, "taken");
    mkdirSync(path); // the final rename onto a folder fails
    await expect(saveProject(path, newProject("P", area, "Light"), {})).rejects.toThrow();
    expect(readdirSync(dir)).toEqual(["taken"]);
  });

  it("rejects a non-zip file", async () => {
    const path = join(tmp(), "notes.txt");
    writeFileSync(path, "hello");
    await expect(loadProject(path)).rejects.toThrow("This isn't an AffinityGeo project file.");
  });

  it("rejects a zip with no project.json", async () => {
    const path = join(tmp(), "other.afgeo");
    writeFileSync(path, writeZip([{ name: "readme.txt", data: new TextEncoder().encode("hi") }]));
    await expect(loadProject(path)).rejects.toThrow("This isn't an AffinityGeo project file.");
  });

  it("rejects a project made by a newer version", async () => {
    const path = join(tmp(), "future.afgeo");
    const p = { ...newProject("X", area, "Light"), version: 2 };
    writeFileSync(path, writeZip([{ name: "project.json", data: new TextEncoder().encode(JSON.stringify(p)) }]));
    await expect(loadProject(path)).rejects.toThrow("This project was made by a newer AffinityGeo.");
  });

  it("gives an older v1 project without a paper colour its preset's paper (or white)", async () => {
    const dir = tmp();
    const old = (presetName: string) => {
      const p = newProject("Old", area, "Dark") as unknown as { style: Record<string, unknown> };
      delete p.style.paper;
      p.style.presetName = presetName;
      return p;
    };
    const write = (name: string, p: unknown) => {
      const path = join(dir, name);
      writeFileSync(path, writeZip([{ name: "project.json", data: new TextEncoder().encode(JSON.stringify(p)) }]));
      return path;
    };
    expect((await loadProject(write("dark.afgeo", old("Dark")))).project.style.paper).toBe("#1d2a33");
    expect((await loadProject(write("custom.afgeo", old("Mine")))).project.style.paper).toBe("#ffffff");
    const bad = newProject("Bad", area, "Dark") as unknown as { style: Record<string, unknown> };
    bad.style.paper = "red";
    expect((await loadProject(write("bad.afgeo", bad))).project.style.paper).toBe("#1d2a33");
    // a project that has one keeps it
    const kept = newProject("New", area, "Light");
    kept.style.paper = "#abcdef";
    expect((await loadProject(write("kept.afgeo", kept))).project.style.paper).toBe("#abcdef");
  });
});

describe("setRoleSource", () => {
  it("puts a file dataset in the snapshot and clears it when switched back to OSM", () => {
    const p0 = newProject("Campus", area, "Light");
    const d0: ProjectData = { buildings: ds("OSM buildings"), water: ds("Water") };
    const mine = ds("My buildings");
    const src = { kind: "file", path: "b.geojson", datasetName: "My buildings" } as const;
    const r1 = setRoleSource(p0, d0, "buildings", src, mine);
    expect(r1.data.buildings).toBe(mine);
    expect(r1.project.sources.buildings).toEqual(src);
    expect(r1.data.water).toBe(d0.water);
    expect(d0.buildings?.name).toBe("OSM buildings"); // pure
    expect(p0.sources.buildings).toEqual({ kind: "osm" });
    const r2 = setRoleSource(r1.project, r1.data, "buildings", { kind: "osm" });
    expect("buildings" in r2.data).toBe(false);
    expect(r2.project.sources.buildings).toEqual({ kind: "osm" });
    expect(r2.data.water).toBe(d0.water);
  });

  it("requires a dataset for a file source", () => {
    const p = newProject("Campus", area, "Light");
    expect(() => setRoleSource(p, {}, "paths", { kind: "file", path: "p.geojson", datasetName: "P" })).toThrow(/dataset/i);
  });
});
