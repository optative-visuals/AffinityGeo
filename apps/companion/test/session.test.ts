import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  TOO_BIG, boxRing, fetchOsm, fetchRing, fnv, parseOverpass, readZip, stable, styleHash, writeZip,
  type Bbox, type FetchArea, type Project, type Ring,
} from "@affinitygeo/geo-core";
import { ApiError, ProjectSession, buildAreaPreview } from "../src/session.js";

const PARKLAND: Bbox = [-0.1690, 51.5040, -0.1640, 51.5065];
const CENTRE: [number, number] = [-0.1665, 51.505];
const OSM = JSON.parse(readFileSync(resolve("packages/geo-core/test/project/fixtures/osm-parkland.json"), "utf8"));
const BNG = resolve("packages/geo-core/test/fixtures/bng3/bng3.shp");
const AREA = { placeName: "Parkland", bboxWgs84: PARKLAND };

const okOsm = async () => parseOverpass(OSM);
const busyOsm = (area: FetchArea) => fetchOsm(area, async () => new Response("", { status: 429 }));

function err(fn: () => unknown): ApiError {
  try { fn(); } catch (e) { if (e instanceof ApiError) return e; throw e; }
  throw new Error("expected an ApiError");
}
async function errAsync(p: Promise<unknown>): Promise<ApiError> {
  try { await p; } catch (e) { if (e instanceof ApiError) return e; throw e; }
  throw new Error("expected an ApiError");
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ageo-session-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("ProjectSession", () => {
  it("needs a project before anything else", () => {
    const s = new ProjectSession();
    expect(err(() => s.counts()).status).toBe(409);
    expect(err(() => s.counts()).message).toBe("No project is open. Create or open a project first.");
  });

  it("creates a metric project and refuses an area that is too wide", () => {
    const s = new ProjectSession();
    const { project, warning } = s.create("Parkland maps", AREA, "Light");
    expect(project.area.projectionId).toBe("bng");
    expect(project.style.presetName).toBe("Light");
    expect(warning).toBeNull();
    expect(s.dirty).toBe(true);
    expect(s.path).toBeNull();
    expect(Object.values(s.counts()).every((n) => n === 0)).toBe(true);

    const utm = s.create("Paris", { placeName: "Paris", bboxWgs84: [2.33, 48.85, 2.37, 48.87] }, "Dark");
    expect(utm.project.area.projectionId).toBe("utm");
    expect(utm.warning).toBe("This is a large area. Fetching may take a while and maps may be slow to draw.");

    const wide = err(() => s.create("Europe", { placeName: "Europe", bboxWgs84: [-5, 45, 10, 50] }, "Light"));
    expect(wide.status).toBe(400);
    expect(wide.message).toBe(TOO_BIG);
    expect(s.project!.name).toBe("Paris"); // the open project is untouched
  });

  it("refresh replaces OpenStreetMap layers only, and a busy server changes nothing", async () => {
    let fetcher: (a: FetchArea) => Promise<any> = okOsm;
    const s = new ProjectSession({ fetchOsm: (b) => fetcher(b) });
    s.create("Parkland", AREA, "Light");
    await s.importFile(BNG, "buildings");
    const r = await s.refresh();
    expect(r.counts.buildings).toBe(3); // from the file, not OpenStreetMap
    expect(r.counts.paths).toBeGreaterThan(0);
    expect(r.changed.paths).toEqual({ before: 0, after: r.counts.paths });
    expect(r.changed.buildings).toBeUndefined();
    expect(s.project!.dataVersion).toBe(2); // import + refresh
    expect(s.project!.fetchedAt).not.toBeNull();
    expect(s.dirty).toBe(true);

    fetcher = busyOsm;
    const before = { counts: s.counts(), version: s.project!.dataVersion, at: s.project!.fetchedAt };
    const e = await errAsync(s.refresh());
    expect(e.status).toBe(503);
    expect(e.message).toBe("OpenStreetMap is busy right now. Try again in a minute — your current data is unchanged.");
    expect(s.counts()).toEqual(before.counts);
    expect(s.project!.dataVersion).toBe(before.version);
    expect(s.project!.fetchedAt).toBe(before.at);
  });

  it("switching a layer back to OpenStreetMap drops the file data until the next refresh", async () => {
    const s = new ProjectSession({ fetchOsm: okOsm });
    s.create("Parkland", AREA, "Light");
    await s.importFile(BNG, "buildings");
    expect(s.project!.sources.buildings).toMatchObject({ kind: "file", datasetName: "Bng3" });
    s.setSource("buildings", { kind: "osm" });
    expect(s.counts().buildings).toBe(0);
    await s.refresh();
    expect(s.counts().buildings).toBeGreaterThan(0);
    const bad = await errAsync(s.importFile(join(dir, "missing.shp"), "water"));
    expect(bad.status).toBe(400);
    expect(err(() => s.setSource("nope" as any, { kind: "osm" })).status).toBe(404);
  });

  it("saves and opens an equal project; the first save needs a path", async () => {
    const s = new ProjectSession({ fetchOsm: okOsm });
    s.create("Parkland", AREA, "Light");
    await s.refresh();
    s.addMap({ name: "Entrance", centre: CENTRE });
    await expect(s.save()).rejects.toThrow("Choose where to save the project first.");
    const path = join(dir, "parkland.afgeo");
    await s.save(path);
    expect(s.dirty).toBe(false);
    expect(s.path).toBe(path);
    s.addMap({ name: "Library", centre: CENTRE });
    await s.save(); // same path again
    const saved = structuredClone(s.project);
    const counts = s.counts();

    const t = new ProjectSession();
    const opened = await t.open(path);
    expect(opened).toEqual(saved);
    expect(t.counts()).toEqual(counts);
    expect(t.dirty).toBe(false);
    const missing = await errAsync(t.open(join(dir, "nope.afgeo")));
    expect(missing.status).toBe(400);
    expect(missing.message).toBe("There's no project file at that path.");
  });

  it("lists features with a search, offset and limit", async () => {
    const s = new ProjectSession({ fetchOsm: okOsm });
    s.create("Parkland", AREA, "Light");
    await s.importFile(BNG, "buildings");
    const all = s.features("buildings", "", 0, 100);
    expect(all.total).toBe(3);
    expect(all.rows[0]).toEqual({ fid: expect.any(String), name: expect.any(String), attrs: expect.any(Object) });
    const page = s.features("buildings", "", 1, 1);
    expect(page.total).toBe(3);
    expect(page.rows).toEqual([all.rows[1]]);
    const q = s.features("buildings", all.rows[2]!.name.toUpperCase(), 0, 100);
    expect(q.rows.map((r) => r.fid)).toContain(all.rows[2]!.fid);
    expect(s.features("water", "", 0, 100)).toEqual({ total: 0, rows: [] });
  });

  it("adds, edits and deletes maps with defaults and checks", () => {
    const s = new ProjectSession();
    s.create("Parkland", AREA, "Light");
    const m = s.addMap({ name: "Entrance", centre: CENTRE });
    expect(m).toMatchObject({
      name: "Entrance", centre: CENTRE, scale: 2500, rotationDeg: 0, sizeMm: { width: 420, height: 297 },
      marker: true, target: null, resizeArtboard: null, sent: null,
    });
    expect(s.patchMap(m.id, { scale: 1250, rotationDeg: -30 })).toMatchObject({ scale: 1250, rotationDeg: -30 });
    expect(err(() => s.patchMap(m.id, { scale: -1 })).status).toBe(400);
    expect(err(() => s.patchMap(m.id, { sent: null } as any)).status).toBe(400);
    expect(err(() => s.addMap({ name: "", centre: CENTRE })).status).toBe(400);
    expect(err(() => s.patchMap("nope", {})).status).toBe(404);
    s.deleteMap(m.id);
    expect(s.project!.maps).toEqual([]);
  });

  it("keeps map size and rotation within sensible bounds", () => {
    const s = new ProjectSession();
    s.create("Parkland", AREA, "Light");
    const m = s.addMap({ name: "Entrance", centre: CENTRE });
    expect(s.patchMap(m.id, { sizeMm: { width: 10, height: 5000 } }).sizeMm).toEqual({ width: 10, height: 5000 });
    for (const sizeMm of [{ width: 9.9, height: 100 }, { width: 100, height: 5000.1 }, { width: 42000, height: 297 }, { width: 1e9, height: 1e9 }]) {
      const e = err(() => s.patchMap(m.id, { sizeMm }));
      expect(e.status).toBe(400);
      expect(e.message).toBe("The map size must be from 10 to 5,000 mm on each side.");
    }
    expect(s.map(m.id).sizeMm).toEqual({ width: 10, height: 5000 });
    // Any finite rotation up to ±3600 is kept as sent (not normalised: it feeds the change hash).
    expect(s.patchMap(m.id, { rotationDeg: 370 }).rotationDeg).toBe(370);
    expect(s.patchMap(m.id, { rotationDeg: -3600 }).rotationDeg).toBe(-3600);
    for (const rotationDeg of [3600.5, -3601, 1e9]) {
      const e = err(() => s.patchMap(m.id, { rotationDeg }));
      expect(e.status).toBe(400);
      expect(e.message).toMatch(/rotation.*3,600/);
    }
    expect(s.map(m.id).rotationDeg).toBe(-3600);
  });

  it("merges style changes and checks them", () => {
    const s = new ProjectSession();
    s.create("Parkland", AREA, "Light");
    const st = s.updateStyle({ roles: { paths: { stroke: "#123456" } }, marker: { label: "Vous êtes ici" } });
    expect(st.roles.paths.stroke).toBe("#123456");
    expect(st.roles.paths.strokePt).toBe(0.75);
    expect(st.marker.label).toBe("Vous êtes ici");
    expect(err(() => s.updateStyle({ roles: { paths: { stroke: "red" } } } as any)).status).toBe(400);
    expect(err(() => s.updateStyle({ roles: { nope: {} } } as any)).status).toBe(400);
    expect(s.applyPreset("Dark").presetName).toBe("Dark");
    expect(err(() => s.applyPreset("Nope")).status).toBe(400);
  });

  it("sets the map background (paper) colour, checked like the others; a preset brings its own", () => {
    const s = new ProjectSession();
    s.create("Parkland", AREA, "Light");
    expect(s.project!.style.paper).toBe("#f4f1ea");
    expect(s.updateStyle({ paper: "#ABCDEF" }).paper).toBe("#abcdef");
    expect(err(() => s.updateStyle({ paper: "white" } as any)).message).toBe("The background must be a colour like #1a2b3c.");
    expect(err(() => s.updateStyle({ paper: null } as any)).status).toBe(400);
    expect(s.project!.style.paper).toBe("#abcdef");
    expect(s.applyPreset("Dark").paper).toBe("#1d2a33");
  });

  it("works out each map's status against the open documents", async () => {
    const s = new ProjectSession({ fetchOsm: okOsm });
    const { project } = s.create("Parkland", AREA, "Light");
    await s.refresh();
    const a = s.addMap({ name: "A", centre: CENTRE });
    const b = s.addMap({ name: "B", centre: CENTRE });
    const docs = (artboards: any[]) => ({ documents: [{ docId: "d1", title: "Parkland.af", artboards }] });
    expect(s.statuses(docs([])).map((x) => x.status)).toEqual(["Not sent", "Not sent"]);

    s.patchMap(a.id, { target: { docId: "d1", docTitle: "Parkland.af" } });
    s.recordSent(project.id, a.id, s.statusHash(a.id), { objectIds: ["paths:1"], docId: "d1", docTitle: "Parkland.af" });
    expect(s.statuses(docs([]))[0]).toEqual({ mapId: a.id, status: "Up to date", outside: true }); // the A3 frame runs past the small park
    s.updateStyle({ roles: { paths: { stroke: "#000000" } } });
    expect(s.statuses(docs([]))[0]!.status).toBe("Changed since sent");

    // Target closed, but a Save-As copy holding its tagged artboard is open: still not the target.
    const copy = { docId: "d2", title: "Copy.af", artboards: [{ name: "A", mapIds: [{ projectId: project.id, mapId: a.id }], widthMm: 420, heightMm: 297 }] };
    expect(s.statuses({ documents: [copy] })[0]!.status).toBe("Target not open");
    expect(s.artboardFor({ documents: [copy] }, a.id)).toBeNull();
    // Both open: only the target's own artboard (none yet) counts, never the copy's.
    const both = { documents: [copy, { docId: "d1", title: "Parkland.af", artboards: [] }] };
    expect(s.statuses(both)[0]!.status).toBe("Changed since sent");
    expect(s.artboardFor(both, a.id)).toBeNull();
    // A target without an id still finds the map by its artboard tag in any open document.
    s.patchMap(b.id, { target: { docId: "", docTitle: "Gone.af" } });
    const bCopy = { ...copy, artboards: [{ ...copy.artboards[0]!, mapIds: [{ projectId: project.id, mapId: b.id }] }] };
    expect(s.statusOf({ documents: [bCopy] }, b.id)).toBe("Not sent");
    expect(s.artboardFor({ documents: [bCopy] }, b.id)).toMatchObject({ docId: "d2" });
    s.patchMap(b.id, { target: null });
    expect(s.statuses({ documents: [] })[0]!.status).toBe("Target not open");
    expect(s.statuses({ documents: [] })[1]!.status).toBe("Not sent"); // no target chosen yet
    // The document id survives save and reopen: a different document with the same title is not the target.
    expect(s.statuses({ documents: [{ docId: "x", title: "Parkland.af", artboards: [] }] })[0]!.status).toBe("Target not open");
    expect(b.sent).toBeNull();
  });

  it("a target without a document id is still found by its title", () => {
    const s = new ProjectSession({ fetchOsm: okOsm });
    s.create("Parkland", AREA, "Light");
    const a = s.addMap({ name: "A", centre: CENTRE });
    s.patchMap(a.id, { target: { docId: "", docTitle: "Parkland.af" } });
    expect(s.statusOf({ documents: [{ docId: "x", title: "Parkland.af", artboards: [] }] }, a.id)).toBe("Not sent");
  });

  it("recordSent never moves a map to a different document than its target", () => {
    const s = new ProjectSession({ fetchOsm: okOsm });
    const { project } = s.create("Parkland", AREA, "Light");
    const a = s.addMap({ name: "A", centre: CENTRE });
    s.patchMap(a.id, { target: { docId: "A", docTitle: "Untitled" } });
    s.recordSent(project.id, a.id, s.statusHash(a.id), { objectIds: [], docId: "B", docTitle: "Untitled" });
    expect(s.map(a.id).target).toEqual({ docId: "A", docTitle: "Untitled" });
    // The same document under a new title (saved under a name): the title follows.
    s.recordSent(project.id, a.id, s.statusHash(a.id), { objectIds: [], docId: "A", docTitle: "Parkland.af" });
    expect(s.map(a.id).target).toEqual({ docId: "A", docTitle: "Parkland.af" });
    // No target yet: the document drawn into becomes it.
    const b = s.addMap({ name: "B", centre: CENTRE });
    s.recordSent(project.id, b.id, s.statusHash(b.id), { objectIds: [], docId: "B", docTitle: "Untitled" });
    expect(s.map(b.id).target).toEqual({ docId: "B", docTitle: "Untitled" });
  });

  it("a change made while the project is being saved keeps it unsaved", async () => {
    const s = new ProjectSession({ fetchOsm: okOsm });
    s.create("Parkland", AREA, "Light");
    const a = s.addMap({ name: "A", centre: CENTRE });
    const path = join(dir, "race.afgeo");
    const saving = s.save(path);
    s.patchMap(a.id, { scale: 1250 }); // lands while the file is being written
    await saving;
    expect(s.path).toBe(path);
    expect(s.dirty).toBe(true);
    await s.save();
    expect(s.dirty).toBe(false);
  });

  it("overlapping saves run one after the other: the newer state lands last, no temp file left", async () => {
    const s = new ProjectSession({ fetchOsm: okOsm });
    s.create("Parkland", AREA, "Light");
    const a = s.addMap({ name: "A", centre: CENTRE });
    const path = join(dir, "both.afgeo");
    const first = s.save(path);
    s.patchMap(a.id, { scale: 1250 });
    const second = s.save(path);
    await Promise.all([first, second]);
    const t = new ProjectSession();
    expect((await t.open(path)).maps[0]!.scale).toBe(1250);
    expect(s.dirty).toBe(false); // nothing changed after the second save's snapshot
    expect(readdirSync(dir)).toEqual(["both.afgeo"]);
  });

  it("saves are serialised: the second waits for the first and snapshots the latest state", async () => {
    const calls: Array<{ scale: number; done: () => void }> = [];
    const save = (_path: string, project: any) => new Promise<void>((done) => { calls.push({ scale: project.maps[0].scale, done }); });
    const s = new ProjectSession({ fetchOsm: okOsm, saveProject: save as any });
    s.create("Parkland", AREA, "Light");
    const a = s.addMap({ name: "A", centre: CENTRE });
    const first = s.save(join(dir, "x.afgeo"));
    s.patchMap(a.id, { scale: 1250 });
    const second = s.save(join(dir, "x.afgeo"));
    await new Promise((r) => setTimeout(r, 10));
    expect(calls.map((c) => c.scale)).toEqual([2500]); // the second hasn't started
    s.patchMap(a.id, { scale: 5000 }); // before the second's snapshot: it saves this
    calls[0]!.done();
    await first;
    expect(s.dirty).toBe(true); // changed after the first snapshot
    await new Promise((r) => setTimeout(r, 10));
    expect(calls.map((c) => c.scale)).toEqual([2500, 5000]);
    calls[1]!.done();
    await second;
    expect(s.dirty).toBe(false);
  });

  it("a failed save leaves no temp file behind", async () => {
    const s = new ProjectSession({ fetchOsm: okOsm });
    s.create("Parkland", AREA, "Light");
    const folder = join(dir, "taken");
    mkdirSync(folder); // a folder where the file should go: the final rename fails
    await expect(s.save(folder)).rejects.toThrow("The project couldn't be saved");
    expect(readdirSync(dir)).toEqual(["taken"]);
    expect(s.dirty).toBe(true);
    // A later save still works (the lock isn't stuck on the failure).
    await s.save(join(dir, "ok.afgeo"));
    expect(s.dirty).toBe(false);
  });

  it("a refresh that brings back the same data doesn't mark maps changed", async () => {
    let fetcher: (a: FetchArea) => Promise<any> = okOsm;
    const s = new ProjectSession({ fetchOsm: (b) => fetcher(b) });
    const { project } = s.create("Parkland", AREA, "Light");
    await s.refresh();
    const a = s.addMap({ name: "A", centre: CENTRE });
    s.recordSent(project.id, a.id, s.statusHash(a.id), { objectIds: [] });
    const version = s.project!.dataVersion;
    const r = await s.refresh();
    expect(r.changed).toEqual({});
    expect(s.project!.dataVersion).toBe(version);
    expect(s.statusOf({ documents: [] }, a.id)).toBe("Up to date");
    // Different data does bump it.
    fetcher = async () => { const d = parseOverpass(OSM); d.paths!.features.pop(); return d; };
    await s.refresh();
    expect(s.project!.dataVersion).toBe(version + 1);
    expect(s.statusOf({ documents: [] }, a.id)).toBe("Changed since sent");
  });
  it("areaPreview is cached until the data, projection or a source changes", async () => {
    let fetcher: (a: FetchArea) => Promise<any> = okOsm;
    let builds = 0;
    const s = new ProjectSession({
      fetchOsm: (b) => fetcher(b),
      buildAreaPreview: (...args) => { builds += 1; return buildAreaPreview(...args); },
    });
    s.create("Parkland", AREA, "Light");
    expect(err(() => s.areaPreview()).status).toBe(409);
    expect(err(() => s.areaPreview()).message).toBe("Fetch the data first.");
    await s.refresh();
    const first = s.areaPreview();
    expect(s.areaPreview()).toBe(first);
    expect(builds).toBe(1);
    await s.refresh(); // same data again
    expect(s.areaPreview()).toBe(first);
    fetcher = async () => { const d = parseOverpass(OSM); d.paths!.features.pop(); return d; };
    await s.refresh();
    const second = s.areaPreview();
    expect(second).not.toBe(first);
    expect(builds).toBe(2);
    s.setProjection("utm", { zone: 30 });
    const third = s.areaPreview();
    expect(third).not.toBe(second);
    expect(s.areaPreview()).toBe(third);
    s.setSource("paths", { kind: "osm" });
    expect(s.areaPreview()).not.toBe(third);
    s.create("Other", AREA, "Light");
    expect(err(() => s.areaPreview()).status).toBe(409);
  });
});

// A pentagon inside the park, and a second park-sized box a little to the east.
const SHAPE: Ring = [[-0.1685, 51.5042], [-0.1645, 51.5042], [-0.1642, 51.5055], [-0.1665, 51.5063], [-0.1688, 51.5055]];
const EAST: Ring = boxRing([-0.1590, 51.5040, -0.1540, 51.5065]);
const SHAPE_IN = { placeName: "Parkland", kind: "shape" as const, ring: SHAPE, contextM: 200 };
const TOO_FAR = "This location is a long way from the others. Maps there may look stretched. Choose a projection that suits it on the Area screen.";

describe("ProjectSession locations", () => {
  it("creates a project from a shape with a margin", () => {
    const s = new ProjectSession();
    const { project, warning } = s.create("Parkland", SHAPE_IN, "Light");
    expect(project.locations).toHaveLength(1);
    expect(project.locations[0]).toMatchObject({ id: "loc-1", kind: "shape", ring: SHAPE, contextM: 200, placeName: "Parkland" });
    expect(project.area.projectionId).toBe("bng");
    // The area covers the fetched shape, margin included.
    const [w, south, e, n] = project.area.bboxWgs84;
    expect(w).toBeLessThan(-0.1688);
    expect(e).toBeGreaterThan(-0.1642);
    expect(south).toBeLessThan(51.5042);
    expect(n).toBeGreaterThan(51.5063);
    expect(warning).toBeNull();
    expect(s.data).toEqual({ locations: { "loc-1": {} }, files: {} });
  });

  it("create refuses a shape that crosses itself, a fetched area over 25 km² and a margin out of range", () => {
    const s = new ProjectSession();
    const bowTie: Ring = [[-0.169, 51.504], [-0.164, 51.5065], [-0.164, 51.504], [-0.169, 51.5065]];
    const crossed = err(() => s.create("X", { placeName: "", kind: "shape", ring: bowTie, contextM: 0 }, "Light"));
    expect(crossed.status).toBe(400);
    expect(crossed.message).toBe("The shape's edges cross. Move a corner so the outline doesn't cross itself.");
    // About 5.1 km by 5.1 km: 26 km².
    const big = err(() => s.create("X", { placeName: "", kind: "shape", ring: boxRing([-0.2, 51.48, -0.1264, 51.5258]), contextM: 0 }, "Light"));
    expect(big.message).toBe(TOO_BIG);
    const margin = err(() => s.create("X", { ...SHAPE_IN, contextM: 1001 }, "Light"));
    expect(margin.message).toBe("The margin must be from 0 to 1,000 metres, in steps of 50.");
    expect(err(() => s.create("X", { ...SHAPE_IN, contextM: 37 }, "Light")).message).toBe("The margin must be from 0 to 1,000 metres, in steps of 50.");
    expect(new ProjectSession().create("X", { ...SHAPE_IN, contextM: 1000 }, "Light").project.locations[0]!.contextM).toBe(1000);
    expect(err(() => s.create("X", { ...SHAPE_IN, kind: "circle" as any }, "Light")).status).toBe(400);
    expect(err(() => s.create("X", { ...SHAPE_IN, ring: [[1, 2]] }, "Light")).status).toBe(400);
    expect(s.project).toBeNull();
  });

  it("the old bbox area still makes a box location with no margin", () => {
    const s = new ProjectSession();
    const { project } = s.create("Parkland", AREA, "Light");
    expect(project.locations[0]).toMatchObject({ id: "loc-1", name: "Parkland", kind: "box", ring: boxRing(PARKLAND), contextM: 0 });
    expect(project.area.bboxWgs84).toEqual(PARKLAND);
  });

  it("addLocation names and numbers the new location and widens the area to cover both", () => {
    const s = new ProjectSession();
    s.create("Parkland", AREA, "Light");
    const { location, warning } = s.addLocation({ kind: "box", ring: EAST, contextM: 0 });
    expect(location).toMatchObject({ id: "loc-2", name: "Location 2", placeName: "", kind: "box", contextM: 0, dataVersion: 0, fetchedAt: null });
    expect(warning).toBeNull();
    expect(s.project!.area.bboxWgs84).toEqual([-0.1690, 51.5040, -0.1540, 51.5065]);
    expect(s.data.locations["loc-2"]).toEqual({});
    const named = s.addLocation({ name: " East gate ", placeName: "Parkland", kind: "shape", ring: SHAPE });
    expect(named.location).toMatchObject({ id: "loc-3", name: "East gate", contextM: 200 }); // the default margin
    expect(err(() => s.addLocation({ kind: "shape", ring: [[0, 0], [1, 1], [1, 0], [0, 1]] })).status).toBe(400);
    expect(s.project!.locations).toHaveLength(3);
  });

  it("warns when a new location sits badly for the project's projection", () => {
    const s = new ProjectSession();
    s.create("Parkland", AREA, "Light");
    // About 600 km east, outside British National Grid.
    expect(s.addLocation({ kind: "box", ring: boxRing([8.40, 51.5040, 8.405, 51.5065]) }).warning).toBe(TOO_FAR);
    const utm = new ProjectSession();
    utm.create("Paris", { placeName: "", bboxWgs84: [2.33, 48.85, 2.34, 48.86] }, "Light");
    expect(utm.project!.area.projectionParams).toEqual({ zone: 31 });
    expect(utm.addLocation({ kind: "box", ring: boxRing([2.35, 48.85, 2.36, 48.86]) }).warning).toBeNull();
    expect(utm.addLocation({ kind: "box", ring: boxRing([9.10, 48.85, 9.11, 48.86]) }).warning).toBe(TOO_FAR); // zone 32
  });

  it("patchLocation checks and applies changes, and keeps the area in step", () => {
    const s = new ProjectSession();
    s.create("Parkland", AREA, "Light");
    s.addLocation({ kind: "box", ring: EAST, contextM: 0 });
    const loc = s.patchLocation("loc-2", { name: "East", contextM: 100 });
    expect(loc).toMatchObject({ name: "East", contextM: 100, kind: "box" });
    expect(s.project!.area.bboxWgs84[2]).toBeGreaterThan(-0.1540);
    expect(s.patchLocation("loc-1", { kind: "shape", ring: SHAPE }).kind).toBe("shape");
    expect(err(() => s.patchLocation("loc-2", { contextM: -50 })).message).toBe("The margin must be from 0 to 1,000 metres, in steps of 50.");
    expect(err(() => s.patchLocation("loc-2", { name: "" })).status).toBe(400);
    expect(err(() => s.patchLocation("loc-2", { dataVersion: 4 } as any)).status).toBe(400);
    expect(err(() => s.patchLocation("nope", { name: "x" })).status).toBe(404);
    expect(s.project!.locations[1]!.contextM).toBe(100); // refused patches change nothing
  });

  it("deleteLocation refuses while maps use it and for the last location, and drops its snapshot", async () => {
    const s = new ProjectSession({ fetchOsm: okOsm });
    s.create("Parkland", AREA, "Light");
    s.addLocation({ kind: "box", ring: EAST, contextM: 0 });
    await s.refresh("loc-2");
    const m = s.addMap({ name: "East map", centre: CENTRE, locationId: "loc-2" });
    expect(err(() => s.deleteLocation("loc-2")).message).toBe("Delete this location's maps first.");
    s.deleteMap(m.id);
    s.deleteLocation("loc-2");
    expect(s.project!.locations.map((l) => l.id)).toEqual(["loc-1"]);
    expect(Object.keys(s.data.locations)).toEqual(["loc-1"]);
    expect(s.project!.area.bboxWgs84).toEqual(PARKLAND);
    expect(err(() => s.deleteLocation("loc-1")).message).toBe("A project needs at least one location.");
    expect(err(() => s.deleteLocation("nope")).status).toBe(404);
  });

  it("refresh fetches one location by its shape and leaves the others untouched", async () => {
    const asked: FetchArea[] = [];
    let fetcher: (a: FetchArea) => Promise<any> = okOsm;
    const s = new ProjectSession({ fetchOsm: (a) => { asked.push(a); return fetcher(a); }, now: () => new Date("2026-11-04T10:00:00Z") });
    s.create("Parkland", AREA, "Light");
    s.addLocation({ kind: "shape", ring: SHAPE, contextM: 0 });
    await s.refresh(); // no id: loc-1
    expect(asked[0]).toEqual({ bbox: PARKLAND });
    expect(s.features("paths", "", 0, 1000, undefined, "asc", "loc-2").total).toBe(0); // not fetched yet
    expect(s.matching("paths", "name contains 'a'", "loc-2").fids).toEqual([]);
    expect(s.matching("paths", "name contains 'a'", "loc-1").fids.length).toBeGreaterThan(0);
    const loc1 = s.data.locations["loc-1"];
    const v1 = s.project!.locations[0]!.dataVersion;
    fetcher = async () => { const d = parseOverpass(OSM); d.paths!.features.pop(); return d; };
    const r = await s.refresh("loc-2");
    expect(asked[1]).toEqual({ ring: fetchRing({ kind: "shape", ring: SHAPE, contextM: 0 }) }); // the shape's outline
    expect(s.data.locations["loc-1"]).toBe(loc1);
    expect(s.project!.locations[0]!.dataVersion).toBe(v1);
    expect(s.project!.locations[1]).toMatchObject({ dataVersion: 1, fetchedAt: "2026-11-04T10:00:00.000Z" });
    expect(s.project!.dataVersion).toBe(2);
    expect(r.counts).toEqual(s.counts("loc-2"));
    expect(s.counts("loc-2").paths).toBe(s.counts("loc-1").paths - 1);
    expect(s.counts().paths).toBe(s.counts("loc-1").paths); // the first location by default
    expect(s.features("paths", "", 0, 1000, undefined, "asc", "loc-2").total).toBe(s.counts("loc-2").paths);
    const missing = await errAsync(s.refresh("nope"));
    expect(missing.message).toBe("There's no location with that id in this project.");
    expect(err(() => s.counts("nope")).status).toBe(400);
  });

  it("maps belong to a location: unknown ids and moves are refused; showContext can change", () => {
    const s = new ProjectSession();
    s.create("Parkland", AREA, "Light");
    s.addLocation({ kind: "box", ring: EAST, contextM: 0 });
    const m = s.addMap({ name: "A", centre: CENTRE });
    expect(m).toMatchObject({ locationId: "loc-1", showContext: false });
    const b = s.addMap({ name: "B", centre: CENTRE, locationId: "loc-2", showContext: true });
    expect(b).toMatchObject({ locationId: "loc-2", showContext: true });
    expect(err(() => s.addMap({ name: "C", centre: CENTRE, locationId: "nope" })).message).toBe("There's no location with that id in this project.");
    expect(s.patchMap(m.id, { showContext: true }).showContext).toBe(true);
    expect(err(() => s.patchMap(m.id, { showContext: "yes" } as any)).status).toBe(400);
    expect(err(() => s.patchMap(m.id, { locationId: "loc-2" })).status).toBe(400);
    expect(s.map(m.id).locationId).toBe("loc-1");
    // statuses can be narrowed to one location's maps.
    expect(s.statuses({ documents: [] }, "loc-2").map((x) => x.mapId)).toEqual([b.id]);
  });

  it("areaPreview joins every location's data and outlines each location in projected metres", async () => {
    const s = new ProjectSession({ fetchOsm: okOsm });
    s.create("Parkland", AREA, "Light");
    s.addLocation({ name: "Shape", kind: "shape", ring: SHAPE, contextM: 100 });
    await s.refresh("loc-2");
    const p = s.areaPreview();
    expect(p.layers.length).toBeGreaterThan(0);
    expect(p.locations.map((l) => [l.id, l.name])).toEqual([["loc-1", "Parkland"], ["loc-2", "Shape"]]);
    const shape = p.locations[1]!;
    expect(shape.ring).toHaveLength(SHAPE.length);
    expect(shape.fetchRing.length).toBeGreaterThan(SHAPE.length); // grown by the margin
    for (const [x, y] of [...shape.ring, ...shape.fetchRing]) {
      expect(x).toBeGreaterThan(520000); expect(x).toBeLessThan(530000); // British National Grid metres, London
      expect(y).toBeGreaterThan(175000); expect(y).toBeLessThan(185000);
      expect(x).toBeGreaterThanOrEqual(p.bounds[0]); expect(x).toBeLessThanOrEqual(p.bounds[2]);
    }
    // The same OpenStreetMap feature fetched for two locations appears once.
    await s.refresh("loc-1");
    const both = s.areaPreview();
    const fids = both.layers.flatMap((l) => l.features.map((f) => `${l.role}:${f.fid}`));
    expect(new Set(fids).size).toBe(fids.length);
    s.patchLocation("loc-2", { name: "Renamed" });
    expect(s.areaPreview().locations[1]!.name).toBe("Renamed"); // the cache follows location changes
  });

  it("re-importing the same file with new contents marks every location's sent maps changed", async () => {
    const s = new ProjectSession({ fetchOsm: okOsm });
    const { project } = s.create("Parkland", AREA, "Light");
    s.addLocation({ kind: "box", ring: EAST, contextM: 0 });
    const file = join(dir, "landmarks.geojson");
    const point = (name: string) => JSON.stringify({ type: "FeatureCollection", features: [
      { type: "Feature", properties: { name }, geometry: { type: "Point", coordinates: CENTRE } },
    ] });
    writeFileSync(file, point("Gate"));
    await s.importFile(file, "landmarks");
    const a = s.addMap({ name: "A", centre: CENTRE });
    const b = s.addMap({ name: "B", centre: CENTRE, locationId: "loc-2" });
    for (const m of [a, b]) s.recordSent(project.id, m.id, s.statusHash(m.id), { objectIds: [] });
    expect(s.statuses({ documents: [] }).map((x) => x.status)).toEqual(["Up to date", "Up to date"]);
    writeFileSync(file, point("Fountain"));
    await s.importFile(file, "landmarks"); // the same path: only the contents changed
    expect(s.statusOf({ documents: [] }, a.id)).toBe("Changed since sent");
    expect(s.statusOf({ documents: [] }, b.id)).toBe("Changed since sent");
  });

  it("a map sent from 0.1.x stays up to date when its v1 project is opened", async () => {
    // The 0.1.0 hash formula and project shape, copied so this test owns the old code.
    const oldHash = (p: { maps: Array<Record<string, unknown>>; style: Project["style"]; dataVersion: number; sources: unknown; area: unknown }) => {
      const { sent: _s, target: _t, ...spec } = p.maps[0]!;
      return fnv(stable({ map: spec, style: styleHash(p.style), dataVersion: p.dataVersion, sources: p.sources, area: p.area }));
    };
    const base = new ProjectSession().create("Old", AREA, "Light").project;
    const { locations: _l, ...rest } = base;
    const v1Map: Record<string, unknown> = {
      id: "m1", name: "Map 1", centre: CENTRE, scale: 5000, rotationDeg: -30, sizeMm: { width: 297, height: 210 },
      marker: true, target: { docId: "doc-1", docTitle: "Parkland.af" }, resizeArtboard: false, sent: null,
    };
    const v1 = { ...rest, version: 1, maps: [v1Map], dataVersion: 7, fetchedAt: "2026-10-28T10:00:00Z" };
    v1Map.sent = { at: "2026-10-28T11:00:00Z", hash: oldHash(v1), objectIds: ["paths:1"] };
    const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
    const entries = [{ name: "project.json", data: enc(v1) }];
    for (const [role, ds] of Object.entries(parseOverpass(OSM))) entries.push({ name: `data/${role}.json`, data: enc(ds) });
    const path = join(dir, "v1.afgeo");
    writeFileSync(path, writeZip(entries));

    const s = new ProjectSession();
    await s.open(path);
    const targets = { documents: [{ docId: "doc-1", title: "Parkland.af", artboards: [] }] };
    expect(s.statusOf(targets, "m1")).toBe("Up to date");
    expect(s.statuses(targets)).toEqual([{ mapId: "m1", status: "Up to date", outside: expect.any(Boolean) }]);
  });

  it("saves and opens a project with two locations, without orphan data after a delete", async () => {
    const s = new ProjectSession({ fetchOsm: okOsm });
    s.create("Parkland", AREA, "Light");
    s.addLocation({ kind: "box", ring: EAST, contextM: 0 });
    s.addLocation({ kind: "shape", ring: SHAPE });
    await s.refresh("loc-2");
    await s.refresh("loc-3");
    s.deleteLocation("loc-2");
    const path = join(dir, "two.afgeo");
    await s.save(path);
    const names = readZip(readFileSync(path)).map((e) => e.name);
    expect(names.some((n) => n.startsWith("data/loc-3/"))).toBe(true);
    expect(names.some((n) => n.startsWith("data/loc-2/"))).toBe(false);
    const t = new ProjectSession();
    const opened = await t.open(path);
    expect(opened.locations.map((l) => l.id)).toEqual(["loc-1", "loc-3"]);
    expect(Object.keys(t.data.locations).sort()).toEqual(["loc-1", "loc-3"]);
    expect(t.counts("loc-3")).toEqual(s.counts("loc-3"));
  });
});
