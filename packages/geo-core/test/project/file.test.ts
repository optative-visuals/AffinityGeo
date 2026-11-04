import { mkdirSync, mkdtempSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { Dataset } from "../../src/types.js";
import { dataFor, loadProject, newProject, saveProject, setRoleSource, syncArea } from "../../src/project/file.js";
import { writeZip } from "../../src/project/zip.js";
import { boxRing, fetchRing, ringBbox } from "../../src/project/location.js";
import type { AreaSpec, LocationSpec, MapSpec, ProjectData, ProjectSnapshot } from "../../src/project/types.js";

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
  locationId: "loc-1", showContext: false,
});
const first: Omit<LocationSpec, "id" | "dataVersion" | "fetchedAt"> = {
  name: "Hyde Park", placeName: "Hyde Park", kind: "box", ring: boxRing(area.bboxWgs84), contextM: 0,
};
const mk = (name = "Parkland") => newProject(name, area, "Light", first);
const snapOf = (loc: ProjectData, files: ProjectData = {}): ProjectSnapshot => ({ locations: { "loc-1": loc }, files });
const tmp = () => mkdtempSync(join(tmpdir(), "afgeo-"));
const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));

describe("newProject", () => {
  it("starts with OSM sources, one location, no maps and no data", () => {
    const p = mk();
    expect(p.version).toBe(2);
    expect(p.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(p.locations).toEqual([{ id: "loc-1", ...first, dataVersion: 0, fetchedAt: null }]);
    expect(p.dataVersion).toBe(0);
    expect(p.maps).toEqual([]);
    expect(p.fetchedAt).toBeNull();
    expect(p.style.presetName).toBe("Light");
    expect(Object.keys(p.sources)).toHaveLength(12);
    expect(Object.values(p.sources).every((s) => s.kind === "osm")).toBe(true);
  });
});

describe("saveProject / loadProject", () => {
  it("round-trips v2: project and snapshot come back the same", async () => {
    const path = join(tmp(), "parkland.afgeo");
    const project = { ...mk(), maps: [map("a"), map("b")], dataVersion: 3, fetchedAt: "2026-10-28T10:00:00Z" };
    project.sources.paths = { kind: "file", path: "p.geojson", datasetName: "Paths" };
    const snap = snapOf({ water: ds("Water"), buildings: ds("Buildings") }, { paths: ds("Paths") });
    await saveProject(path, project, snap);
    expect(readdirSync(join(path, ".."))).toEqual(["parkland.afgeo"]); // no .tmp left behind
    const loaded = await loadProject(path);
    expect(loaded.project).toEqual(project);
    expect(loaded.snap).toEqual(snap);
  });

  it("saves to one path at once each use their own temp file: all succeed, none left behind", async () => {
    const dir = tmp();
    const path = join(dir, "parkland.afgeo");
    const snap = snapOf({ water: ds("Water") });
    const saves = Array.from({ length: 20 }, (_, n) => n).map((n) => saveProject(path, mk(`P${n}`), snap));
    await Promise.all(saves);
    expect(readdirSync(dir)).toEqual(["parkland.afgeo"]);
  });

  it("a failed save removes its temp file", async () => {
    const dir = tmp();
    const path = join(dir, "taken");
    mkdirSync(path); // the final rename onto a folder fails
    await expect(saveProject(path, mk("P"), snapOf({}))).rejects.toThrow();
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

  it("refuses version 3", async () => {
    const path = join(tmp(), "future.afgeo");
    const p = { ...mk("X"), version: 3 };
    writeFileSync(path, writeZip([{ name: "project.json", data: enc(p) }]));
    await expect(loadProject(path)).rejects.toThrow("This project was made by a newer AffinityGeo.");
  });

  it("gives an older project without a paper colour its preset's paper (or white)", async () => {
    const dir = tmp();
    const old = (presetName: string) => {
      const p = newProject("Old", area, "Dark", first) as unknown as { style: Record<string, unknown> };
      delete p.style.paper;
      p.style.presetName = presetName;
      return p;
    };
    const write = (name: string, p: unknown) => {
      const path = join(dir, name);
      writeFileSync(path, writeZip([{ name: "project.json", data: enc(p) }]));
      return path;
    };
    expect((await loadProject(write("dark.afgeo", old("Dark")))).project.style.paper).toBe("#1d2a33");
    expect((await loadProject(write("custom.afgeo", old("Mine")))).project.style.paper).toBe("#ffffff");
    const bad = newProject("Bad", area, "Dark", first) as unknown as { style: Record<string, unknown> };
    bad.style.paper = "red";
    expect((await loadProject(write("bad.afgeo", bad))).project.style.paper).toBe("#1d2a33");
    // a project that has one keeps it
    const kept = newProject("New", area, "Light", first);
    kept.style.paper = "#abcdef";
    expect((await loadProject(write("kept.afgeo", kept))).project.style.paper).toBe("#abcdef");
  });
});

describe("loading a v1 project", () => {
  const dir = tmp();
  const path = join(dir, "v1-hyde-park.afgeo");
  const v1Project = (placeName: string) => {
    // The 0.1.0 shape: version 1, no locations, maps without a location.
    const { locations: _l, ...rest } = mk("Parkland");
    const { locationId: _i, showContext: _s, ...v1Map } = map("a");
    return {
      ...rest, version: 1, maps: [v1Map], dataVersion: 4, fetchedAt: "2026-10-28T10:00:00Z",
      area: { ...area, placeName },
      sources: { ...rest.sources, paths: { kind: "file", path: "p.geojson", datasetName: "Paths" } },
    };
  };
  beforeAll(() => {
    // data/<role>.json, as saveProject 0.1.0 wrote it.
    writeFileSync(path, writeZip([
      { name: "project.json", data: enc(v1Project("Hyde Park, London")) },
      { name: "data/water.json", data: enc(ds("Water")) },
      { name: "data/paths.json", data: enc(ds("Paths")) },
    ]));
  });

  it("loads a v1 project as one box location", async () => {
    const { project, snap } = await loadProject(path);
    expect(project.version).toBe(2);
    expect(project.locations).toEqual([{
      id: "loc-1", name: "Hyde Park", placeName: "Hyde Park, London", kind: "box",
      ring: boxRing(area.bboxWgs84), contextM: 0, dataVersion: 4, fetchedAt: "2026-10-28T10:00:00Z",
    }]);
    expect(project.maps).toHaveLength(1);
    expect(project.maps[0]!.locationId).toBe("loc-1");
    expect(project.maps[0]!.showContext).toBe(false);
    expect(project.area).toEqual({ ...area, placeName: "Hyde Park, London" });
    expect(snap.locations["loc-1"]).toEqual({ water: ds("Water") });
    expect(snap.files).toEqual({ paths: ds("Paths") });
  });

  it("names the location 'Location 1' when the place name has no first part", async () => {
    const p2 = join(dir, "v1-blank.afgeo");
    writeFileSync(p2, writeZip([{ name: "project.json", data: enc(v1Project(" , x")) }]));
    expect((await loadProject(p2)).project.locations[0]!.name).toBe("Location 1");
  });
});

describe("syncArea", () => {
  it("syncArea unions fetch areas and takes the first place name", () => {
    const p = mk();
    p.locations.push({
      id: "loc-2", name: "Other", placeName: "Elsewhere, UK", kind: "box",
      ring: boxRing([0.1, 51.4, 0.2, 51.45]), contextM: 200, dataVersion: 0, fetchedAt: null,
    });
    syncArea(p);
    const a = ringBbox(fetchRing(p.locations[0]!)), b = ringBbox(fetchRing(p.locations[1]!));
    expect(p.area.bboxWgs84).toEqual([Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]);
    expect(p.area.bboxWgs84[0]).toBeLessThanOrEqual(-0.2);
    expect(p.area.bboxWgs84[2]).toBeGreaterThan(0.2);
    expect(p.area.placeName).toBe("Hyde Park");
    expect(p.area.projectionId).toBe("bng");
  });
});

describe("dataFor", () => {
  it("prefers file sources over the location's OSM snapshot", () => {
    const p = mk();
    p.sources.buildings = { kind: "file", path: "b.geojson", datasetName: "Mine" };
    const snap: ProjectSnapshot = {
      locations: { "loc-1": { water: ds("W1"), buildings: ds("OSM B") }, "loc-2": { water: ds("W2") } },
      files: { buildings: ds("Mine") },
    };
    expect(dataFor(p, snap, "loc-1")).toEqual({ water: ds("W1"), buildings: ds("Mine") });
    expect(dataFor(p, snap, "loc-2")).toEqual({ water: ds("W2"), buildings: ds("Mine") });
    expect(dataFor(p, snap, "nope")).toEqual({ buildings: ds("Mine") });
  });
});

describe("setRoleSource", () => {
  it("puts a file dataset in the snapshot's files and clears it when switched back to OSM", () => {
    const p0 = mk();
    const s0 = snapOf({ buildings: ds("OSM buildings"), water: ds("Water") });
    const mine = ds("My buildings");
    const src = { kind: "file", path: "b.geojson", datasetName: "My buildings" } as const;
    const r1 = setRoleSource(p0, s0, "buildings", src, mine);
    expect(r1.snap.files.buildings).toBe(mine);
    expect(r1.project.sources.buildings).toEqual(src);
    expect(r1.snap.locations["loc-1"]!.water).toBe(s0.locations["loc-1"]!.water);
    expect(s0.files.buildings).toBeUndefined(); // pure
    expect(p0.sources.buildings).toEqual({ kind: "osm" });
    const r2 = setRoleSource(r1.project, r1.snap, "buildings", { kind: "osm" });
    expect("buildings" in r2.snap.files).toBe(false);
    expect(r2.project.sources.buildings).toEqual({ kind: "osm" });
  });

  it("requires a dataset for a file source", () => {
    expect(() => setRoleSource(mk(), snapOf({}), "paths", { kind: "file", path: "p.geojson", datasetName: "P" })).toThrow(/dataset/i);
  });
});
