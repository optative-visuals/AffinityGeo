import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DataError, TOO_BIG, fetchOsm, parseOverpass, type Bbox } from "@affinitygeo/geo-core";
import { ApiError, ProjectSession, buildAreaPreview } from "../src/session.js";

const CAMPUS: Bbox = [-0.1690, 51.5040, -0.1640, 51.5065];
const CENTRE: [number, number] = [-0.1665, 51.505];
const OSM = JSON.parse(readFileSync(resolve("packages/geo-core/test/project/fixtures/osm-campus.json"), "utf8"));
const BNG = resolve("packages/geo-core/test/fixtures/bng3/bng3.shp");
const AREA = { placeName: "Campus", bboxWgs84: CAMPUS };

const okOsm = async () => parseOverpass(OSM);
const busyOsm = (bbox: Bbox) => fetchOsm(bbox, async () => new Response("", { status: 429 }));

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
    const { project, warning } = s.create("Campus maps", AREA, "Light");
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
    let fetcher: (b: Bbox) => Promise<any> = okOsm;
    const s = new ProjectSession({ fetchOsm: (b) => fetcher(b) });
    s.create("Campus", AREA, "Light");
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
    s.create("Campus", AREA, "Light");
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
    s.create("Campus", AREA, "Light");
    await s.refresh();
    s.addMap({ name: "Entrance", centre: CENTRE });
    await expect(s.save()).rejects.toThrow("Choose where to save the project first.");
    const path = join(dir, "campus.afgeo");
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
    s.create("Campus", AREA, "Light");
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
    s.create("Campus", AREA, "Light");
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

  it("merges style changes and checks them", () => {
    const s = new ProjectSession();
    s.create("Campus", AREA, "Light");
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
    s.create("Campus", AREA, "Light");
    expect(s.project!.style.paper).toBe("#f4f1ea");
    expect(s.updateStyle({ paper: "#ABCDEF" }).paper).toBe("#abcdef");
    expect(err(() => s.updateStyle({ paper: "white" } as any)).message).toBe("The background must be a colour like #1a2b3c.");
    expect(err(() => s.updateStyle({ paper: null } as any)).status).toBe(400);
    expect(s.project!.style.paper).toBe("#abcdef");
    expect(s.applyPreset("Dark").paper).toBe("#1d2a33");
  });

  it("works out each map's status against the open documents", async () => {
    const s = new ProjectSession({ fetchOsm: okOsm });
    const { project } = s.create("Campus", AREA, "Light");
    await s.refresh();
    const a = s.addMap({ name: "A", centre: CENTRE });
    const b = s.addMap({ name: "B", centre: CENTRE });
    const docs = (artboards: any[]) => ({ documents: [{ docId: "d1", title: "Campus.af", artboards }] });
    expect(s.statuses(docs([])).map((x) => x.status)).toEqual(["Not sent", "Not sent"]);

    s.patchMap(a.id, { target: { docId: "d1", docTitle: "Campus.af" } });
    s.recordSent(project.id, a.id, s.statusHash(a.id), { objectIds: ["paths:1"], docId: "d1", docTitle: "Campus.af" });
    expect(s.statuses(docs([]))[0]).toEqual({ mapId: a.id, status: "Up to date" });
    s.updateStyle({ roles: { paths: { stroke: "#000000" } } });
    expect(s.statuses(docs([]))[0]!.status).toBe("Changed since sent");

    // Target closed, but a Save-As copy holding its tagged artboard is open: still not the target.
    const copy = { docId: "d2", title: "Copy.af", artboards: [{ name: "A", mapIds: [{ projectId: project.id, mapId: a.id }], widthMm: 420, heightMm: 297 }] };
    expect(s.statuses({ documents: [copy] })[0]!.status).toBe("Target not open");
    expect(s.artboardFor({ documents: [copy] }, a.id)).toBeNull();
    // Both open: only the target's own artboard (none yet) counts, never the copy's.
    const both = { documents: [copy, { docId: "d1", title: "Campus.af", artboards: [] }] };
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
    expect(s.statuses({ documents: [{ docId: "x", title: "Campus.af", artboards: [] }] })[0]!.status).toBe("Target not open");
    expect(b.sent).toBeNull();
  });

  it("a target without a document id is still found by its title", () => {
    const s = new ProjectSession({ fetchOsm: okOsm });
    s.create("Campus", AREA, "Light");
    const a = s.addMap({ name: "A", centre: CENTRE });
    s.patchMap(a.id, { target: { docId: "", docTitle: "Campus.af" } });
    expect(s.statusOf({ documents: [{ docId: "x", title: "Campus.af", artboards: [] }] }, a.id)).toBe("Not sent");
  });

  it("recordSent never moves a map to a different document than its target", () => {
    const s = new ProjectSession({ fetchOsm: okOsm });
    const { project } = s.create("Campus", AREA, "Light");
    const a = s.addMap({ name: "A", centre: CENTRE });
    s.patchMap(a.id, { target: { docId: "A", docTitle: "Untitled" } });
    s.recordSent(project.id, a.id, s.statusHash(a.id), { objectIds: [], docId: "B", docTitle: "Untitled" });
    expect(s.map(a.id).target).toEqual({ docId: "A", docTitle: "Untitled" });
    // The same document under a new title (saved under a name): the title follows.
    s.recordSent(project.id, a.id, s.statusHash(a.id), { objectIds: [], docId: "A", docTitle: "Campus.af" });
    expect(s.map(a.id).target).toEqual({ docId: "A", docTitle: "Campus.af" });
    // No target yet: the document drawn into becomes it.
    const b = s.addMap({ name: "B", centre: CENTRE });
    s.recordSent(project.id, b.id, s.statusHash(b.id), { objectIds: [], docId: "B", docTitle: "Untitled" });
    expect(s.map(b.id).target).toEqual({ docId: "B", docTitle: "Untitled" });
  });

  it("a change made while the project is being saved keeps it unsaved", async () => {
    const s = new ProjectSession({ fetchOsm: okOsm });
    s.create("Campus", AREA, "Light");
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
    s.create("Campus", AREA, "Light");
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
    s.create("Campus", AREA, "Light");
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
    s.create("Campus", AREA, "Light");
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
    let fetcher: (b: Bbox) => Promise<any> = okOsm;
    const s = new ProjectSession({ fetchOsm: (b) => fetcher(b) });
    const { project } = s.create("Campus", AREA, "Light");
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
    let fetcher: (b: Bbox) => Promise<any> = okOsm;
    let builds = 0;
    const s = new ProjectSession({
      fetchOsm: (b) => fetcher(b),
      buildAreaPreview: (...args) => { builds += 1; return buildAreaPreview(...args); },
    });
    s.create("Campus", AREA, "Light");
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
