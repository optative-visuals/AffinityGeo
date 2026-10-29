import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildMapJob, fetchOsm, parseOverpass, PRESETS, ROLE_IDS, WGS84, type Bbox, type Dataset } from "@affinitygeo/geo-core";
import { startServer } from "../src/server.js";

const PARKLAND: Bbox = [-0.1690, 51.5040, -0.1640, 51.5065];
const CENTRE: [number, number] = [-0.1665, 51.505];
const OSM = JSON.parse(readFileSync(resolve("packages/geo-core/test/project/fixtures/osm-parkland.json"), "utf8"));
const BNG = resolve("packages/geo-core/test/fixtures/bng3/bng3.shp");
const BUSY = "OpenStreetMap is busy right now. Try again in a minute — your current data is unchanged.";
const TARGET = { docId: "doc-1", docTitle: "Parkland.af" };

let dir: string;
let srv: Awaited<ReturnType<typeof startServer>>;
let base: string;
let osmMode: "ok" | "busy" = "ok";
let places: string[] = [];

// ---- fake Affinity: one open document whose artboards the fake sendMap creates ----
interface FakeArtboard { name: string; mapIds: Array<{ projectId: string; mapId: string }>; widthMm: number; heightMm: number }
let docs: Array<{ docId: string; title: string; artboards: FakeArtboard[] }>;
let ops: any[];
let stop = false;
let running: Promise<void>;
let onSendMap: ((op: any) => Promise<void>) | null = null;
const CONNECT = { "X-Geo-Connect": "1" };
const APP = { "X-Geo-App": "1" };

function affinityAnswer(op: any): any {
  if (op.op === "listTargets") return { ok: true, result: { documents: structuredClone(docs) } };
  if (op.op === "sendMap") {
    const { job, target } = op;
    // Like draw-map.js: a target with a document id only ever means that document.
    const pool = target && target.docId ? docs.filter((d) => d.docId === target.docId) : docs;
    let doc = pool.find((d) => d.artboards.some((a) => a.mapIds.some((m) => m.mapId === job.mapId)));
    if (!doc) {
      if (!target) return { ok: false, error: `Choose a document for ${job.mapName} in AffinityGeo first.` };
      doc = docs.find((d) => (target.docId ? d.docId === target.docId : d.title === target.docTitle));
      if (!doc) return { ok: false, error: `Open '${target.docTitle}' in Affinity to update ${job.mapName}` };
      doc.artboards.push({ name: job.mapName, mapIds: [{ projectId: job.projectId, mapId: job.mapId }], widthMm: job.sizeMm.width, heightMm: job.sizeMm.height });
    }
    const objectIds = job.layers.flatMap((l: any) => l.features.map((f: any) => `${l.role}:${f.fid}`));
    return {
      ok: true,
      result: {
        created: op.sentIds.length ? 0 : objectIds.length, updated: op.sentIds.length ? objectIds.length : 0, removed: 0,
        keptEdited: [], resized: false, warnings: [], skipped: 0, objectIds, docId: doc.docId, docTitle: doc.title,
      },
    };
  }
  if (op.op === "selectOnMap") return { ok: true, result: { selected: op.fids.length } };
  if (op.op === "linkArtboard") {
    const doc = docs.find((d) => d.docId === op.docId);
    const ab = doc?.artboards[op.artboardIndex];
    if (!doc || !ab || ab.name !== op.artboardName) return { ok: false, error: "The artboards changed in Affinity. Pick the artboard again." };
    for (const a of doc.artboards) a.mapIds = a.mapIds.filter((m) => m.mapId !== op.mapId);
    ab.mapIds = [{ projectId: op.projectId, mapId: op.mapId }];
    return { ok: true, result: { ok: true, docId: doc.docId, docTitle: doc.title } };
  }
  return { ok: false, error: "Unknown job type" };
}

function fakeAffinity(): Promise<void> {
  return (async () => {
    while (!stop) {
      const r = (await (await fetch(base + "/affinity/next", { headers: CONNECT })).json()) as any;
      if (r.idle) { await new Promise((res) => setTimeout(res, 5)); continue; }
      ops.push(r.op);
      if (r.op.op === "sendMap" && onSendMap) { const hook = onSendMap; onSendMap = null; await hook(r.op); }
      const result = affinityAnswer(r.op);
      await fetch(`${base}/affinity/done?id=${r.id}`, { headers: { ...CONNECT, "X-Geo-Result": encodeURIComponent(JSON.stringify(result)) } });
    }
  })();
}

async function call(method: string, path: string, body?: unknown) {
  const r = await fetch(base + path, {
    method,
    headers: body === undefined ? APP : { ...APP, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: r.status, body: (await r.json()) as any };
}
const get = (p: string) => call("GET", p);
const post = (p: string, b: unknown = {}) => call("POST", p, b);
const patch = (p: string, b: unknown) => call("PATCH", p, b);
const del = (p: string) => call("DELETE", p);

async function statuses(): Promise<string[]> {
  const r = await get("/api/maps/status");
  expect(r.status).toBe(200);
  return r.body.map((x: any) => x.status);
}

async function parklandWithTwoMaps() {
  const p = await post("/api/project/new", { name: "Parkland maps", area: { placeName: "Parkland", bboxWgs84: PARKLAND }, preset: "Light" });
  expect(p.status).toBe(200);
  const r = await post("/api/data/refresh");
  expect(r.status).toBe(200);
  const a = (await post("/api/maps", { name: "Entrance map", centre: CENTRE })).body;
  const b = (await post("/api/maps", { name: "Library map", centre: CENTRE, scale: 1250 })).body;
  for (const m of [a, b]) expect((await patch(`/api/maps/${m.id}`, { target: TARGET })).status).toBe(200);
  return { project: p.body, a, b };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "ageo-api-"));
  osmMode = "ok";
  places = [];
  srv = await startServer({
    port: 0,
    fetchOsm: (bbox: Bbox) => osmMode === "ok"
      ? Promise.resolve(parseOverpass(OSM))
      : fetchOsm(bbox, async () => new Response("", { status: 429 })),
    searchPlaces: async (q: string) => { places.push(q); return [{ name: "Hyde Park", bboxWgs84: PARKLAND, centre: CENTRE }]; },
  });
  base = `http://127.0.0.1:${srv.port}`;
  docs = [{ docId: TARGET.docId, title: TARGET.docTitle, artboards: [] }];
  ops = [];
  stop = false;
  onSendMap = null;
  running = fakeAffinity();
  while (!(await get("/api/affinity")).body.connected) await new Promise((res) => setTimeout(res, 5));
});
afterEach(async () => {
  stop = true;
  await running;
  await srv.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("project API", () => {
  it("presets and place search", async () => {
    expect((await get("/api/presets")).body).toEqual(PRESETS.map((p) => ({ name: p.presetName })));
    const r = await get("/api/places?q=Hyde Park");
    expect(r.body[0].name).toBe("Hyde Park");
    expect(places).toEqual(["Hyde Park"]);
  });

  it("new project, refresh, two maps, send: both up to date; restyle: both changed", async () => {
    expect((await get("/api/project")).status).toBe(409);
    const { project, a, b } = await parklandWithTwoMaps();
    expect(project.area.projectionId).toBe("bng");
    const info = (await get("/api/project")).body;
    expect(info.dirty).toBe(true);
    expect(info.counts.paths).toBeGreaterThan(0);
    expect(info.counts.buildings).toBeGreaterThan(0);
    expect(info.project.maps).toHaveLength(2);
    expect(await statuses()).toEqual(["Not sent", "Not sent"]);

    const s = await post("/api/send");
    expect(s.status).toBe(200);
    expect(s.body.results.map((r: any) => [r.mapId, r.ok])).toEqual([[a.id, true], [b.id, true]]);
    expect(s.body.results[0].created).toBeGreaterThan(0);
    const sends = ops.filter((o) => o.op === "sendMap");
    expect(sends).toHaveLength(2);
    expect(sends[0]).toMatchObject({ target: TARGET, reset: false, sentIds: [], resizeArtboard: true });
    expect(await statuses()).toEqual(["Up to date", "Up to date"]);
    const after = (await get("/api/project")).body.project;
    expect(after.maps[0].resizeArtboard).toBe(true); // a new artboard was made at map size
    expect(after.maps[0].sent.hash).toBe(sends[0].job.hash);

    // Nothing to send: every map is up to date.
    const none = await post("/api/send");
    expect(none.body.results).toEqual([]);

    const st = await post("/api/style", { roles: { paths: { stroke: "#ff0000" } } });
    expect(st.status).toBe(200);
    expect(st.body.roles.paths.stroke).toBe("#ff0000");
    expect(await statuses()).toEqual(["Changed since sent", "Changed since sent"]);

    // A re-send passes the objects sent last time and updates them.
    const again = await post("/api/send", { mapIds: [a.id] });
    expect(again.body.results[0]).toMatchObject({ mapId: a.id, ok: true, created: 0 });
    const last = ops.filter((o) => o.op === "sendMap").at(-1);
    expect(last.sentIds).toEqual(after.maps[0].sent.objectIds);
    expect(await statuses()).toEqual(["Up to date", "Changed since sent"]);
  });

  it("accepts a big map's result header (live: 976 object ids overflowed Node's 16 KB default)", async () => {
    const job = "no-such-job"; // only the header limit matters here: any answer but 431 means it got through
    const ids = Array.from({ length: 6000 }, (_, i) => `buildings:osm-way-${100000000 + i}`);
    const header = encodeURIComponent(JSON.stringify({ ok: true, result: { objectIds: ids } }));
    expect(header.length).toBeGreaterThan(200_000);
    const r = await fetch(`${base}/affinity/done?id=${job}`, { headers: { ...CONNECT, "X-Geo-Result": header } });
    expect(r.status).not.toBe(431);
  });

  it("a map whose document isn't open is skipped with a plain message", async () => {
    const { a } = await parklandWithTwoMaps();
    docs = [{ docId: "other", title: "Poster.af", artboards: [] }];
    expect(await statuses()).toEqual(["Target not open", "Target not open"]);
    const before = ops.filter((o) => o.op === "sendMap").length;
    const s = await post("/api/send", { mapIds: [a.id] });
    expect(s.status).toBe(200);
    expect(s.body.results).toEqual([{
      mapId: a.id, ok: false, created: 0, updated: 0, removed: 0, keptEdited: [], resized: false, warnings: [],
      error: "Open 'Parkland.af' in Affinity to update Entrance map",
    }]);
    expect(ops.filter((o) => o.op === "sendMap").length).toBe(before); // nothing went to Affinity
    expect((await get("/api/project")).body.project.maps[0].sent).toBeNull();
  });

  it("a different document with the target's title is not the target: skipped, target unchanged", async () => {
    const { a } = await parklandWithTwoMaps();
    expect((await patch(`/api/maps/${a.id}`, { target: { docId: "A", docTitle: "Untitled" } })).status).toBe(200);
    docs = [{ docId: "B", title: "Untitled", artboards: [] }];
    expect((await statuses())[0]).toBe("Target not open");
    const before = ops.filter((o) => o.op === "sendMap").length;
    const s = await post("/api/send", { mapIds: [a.id] });
    expect(s.body.results[0]).toMatchObject({ ok: false, error: "Open 'Untitled' in Affinity to update Entrance map" });
    expect(ops.filter((o) => o.op === "sendMap").length).toBe(before);
    expect((await get("/api/project")).body.project.maps[0].target).toEqual({ docId: "A", docTitle: "Untitled" });
  });

  it("a closed target is not open just because a Save-As copy with its artboard is: skipped, nothing recorded", async () => {
    const { project, a } = await parklandWithTwoMaps();
    docs = [{ docId: "copy", title: "Parkland copy.af", artboards: [{ name: "Entrance map", mapIds: [{ projectId: project.id, mapId: a.id }], widthMm: 420, heightMm: 297 }] }];
    expect((await statuses())[0]).toBe("Target not open");
    const before = ops.filter((o) => o.op === "sendMap").length;
    const s = await post("/api/send", { mapIds: [a.id] });
    expect(s.body.results[0]).toMatchObject({ ok: false, error: "Open 'Parkland.af' in Affinity to update Entrance map" });
    expect(ops.filter((o) => o.op === "sendMap").length).toBe(before);
    const m = (await get("/api/project")).body.project.maps[0];
    expect(m.sent).toBeNull();
    expect(m.target).toEqual(TARGET);
  });

  it("an Affinity error on send is reported per map and records nothing", async () => {
    await post("/api/project/new", { name: "C", area: { placeName: "Parkland", bboxWgs84: PARKLAND }, preset: "Light" });
    const m = (await post("/api/maps", { name: "No target", centre: CENTRE })).body;
    const s = await post("/api/send");
    expect(s.body.results[0]).toMatchObject({ mapId: m.id, ok: false, error: "Choose a document for No target in AffinityGeo first." });
    expect(await statuses()).toEqual(["Not sent"]);
  });

  it("asks once when an existing artboard is a different size", async () => {
    const { project, a } = await parklandWithTwoMaps();
    docs[0]!.artboards.push({ name: "Entrance", mapIds: [{ projectId: project.id, mapId: a.id }], widthMm: 297, heightMm: 210 });
    const s = await post("/api/send", { mapIds: [a.id] });
    expect(s.body.results).toEqual([{ mapId: a.id, ok: false, needsResizeChoice: true, artboardMm: { width: 297, height: 210 } }]);
    expect(ops.filter((o) => o.op === "sendMap")).toHaveLength(0);
    await patch(`/api/maps/${a.id}`, { resizeArtboard: false });
    const s2 = await post("/api/send", { mapIds: [a.id] });
    expect(s2.body.results[0].ok).toBe(true);
    expect(ops.filter((o) => o.op === "sendMap")[0].resizeArtboard).toBe(false);
  });

  it("a map deleted mid-send is reported, not dropped", async () => {
    const { a, b } = await parklandWithTwoMaps();
    onSendMap = async () => { expect((await del(`/api/maps/${b.id}`)).status).toBe(200); };
    const s = await post("/api/send");
    expect(s.body.results).toEqual([
      expect.objectContaining({ mapId: a.id, ok: true }),
      { mapId: b.id, ok: false, created: 0, updated: 0, removed: 0, keptEdited: [], resized: false, warnings: [], error: "This map was deleted before it could be sent." },
    ]);
  });

  it("maps left when another project is opened mid-send are reported, not dropped", async () => {
    const { a, b } = await parklandWithTwoMaps();
    onSendMap = async () => {
      expect((await post("/api/project/new", { name: "Other", area: { placeName: "Parkland", bboxWgs84: PARKLAND }, preset: "Light" })).status).toBe(200);
    };
    const s = await post("/api/send");
    expect(s.body.results).toEqual([
      expect.objectContaining({ mapId: a.id, ok: true }),
      { mapId: b.id, ok: false, created: 0, updated: 0, removed: 0, keptEdited: [], resized: false, warnings: [], error: "Another project was opened, so this map wasn't sent." },
    ]);
    expect((await get("/api/project")).body.project.maps).toEqual([]); // the new project is untouched
  });

  it("a busy server gives 503 and keeps the snapshot", async () => {
    await parklandWithTwoMaps();
    const before = (await get("/api/project")).body;
    osmMode = "busy";
    const r = await post("/api/data/refresh");
    expect(r.status).toBe(503);
    expect(r.body).toEqual({ error: BUSY });
    const after = (await get("/api/project")).body;
    expect(after.counts).toEqual(before.counts);
    expect(after.project.dataVersion).toBe(before.project.dataVersion);
  });

  it("refresh reports the before and after counts", async () => {
    await post("/api/project/new", { name: "C", area: { placeName: "Parkland", bboxWgs84: PARKLAND }, preset: "Light" });
    const r = await post("/api/data/refresh");
    expect(r.body.changed.paths).toEqual({ before: 0, after: r.body.counts.paths });
  });

  it("saves, then opens an equal project", async () => {
    await parklandWithTwoMaps();
    await post("/api/send");
    const path = join(dir, "parkland.afgeo");
    const noFile = await post("/api/project/save", {});
    expect(noFile.status).toBe(400);
    expect(noFile.body).toEqual({ error: "Choose where to save the project first.", code: "NEEDS_PATH" }); // the app's Save As cue
    expect((await post("/api/project/save", { path })).body).toEqual({ ok: true });
    const saved = (await get("/api/project")).body;
    expect(saved.dirty).toBe(false);
    await post("/api/maps", { name: "Extra", centre: CENTRE });
    const opened = await post("/api/project/open", { path });
    expect(opened.status).toBe(200);
    expect(opened.body).toEqual(saved.project);
    const now = (await get("/api/project")).body;
    expect(now).toEqual(saved);
    expect(await statuses()).toEqual(["Up to date", "Up to date"]);
  });

  it("refuses an area that is too wide, and warns about a large one", async () => {
    const wide = await post("/api/project/new", { name: "X", area: { placeName: "Europe", bboxWgs84: [-5, 45, 10, 50] }, preset: "Light" });
    expect(wide.status).toBe(400);
    expect(wide.body.error).toBe("That area is too big for a street-level map. Choose a smaller area.");
    const big = await post("/api/project/new", { name: "X", area: { placeName: "London", bboxWgs84: [-0.25, 51.45, -0.10, 51.55] }, preset: "Light" });
    expect(big.status).toBe(200);
    expect(big.body.warning).toBe("This is a large area. Fetching may take a while and maps may be slow to draw.");
    const small = await post("/api/project/new", { name: "X", area: { placeName: "Parkland", bboxWgs84: PARKLAND }, preset: "Light" });
    expect(small.body.warning).toBeUndefined();
    expect((await post("/api/project/new", { name: "X", area: { placeName: "Parkland", bboxWgs84: [1, 2] }, preset: "Light" })).status).toBe(400);
  });

  it("data import, source switch, features and select", async () => {
    const { a } = await parklandWithTwoMaps();
    const osmBuildings = (await get("/api/project")).body.counts.buildings;
    const imp = await post("/api/data/import", { path: BNG, role: "buildings" });
    expect(imp.status).toBe(200);
    expect(imp.body.counts.buildings).toBe(3);
    expect((await post("/api/data/import", { path: join(dir, "nope.shp"), role: "buildings" })).status).toBe(400);

    const f = await get("/api/data/buildings/features?limit=2");
    expect(f.body.total).toBe(3);
    expect(f.body.rows).toHaveLength(2);
    expect(Object.keys(f.body.rows[0]).sort()).toEqual(["attrs", "fid", "name"]);
    expect((await get("/api/data/nope/features")).status).toBe(404);
    expect((await get("/api/data/buildings/features?limit=5000")).status).toBe(400);

    const sel = await post("/api/data/buildings/select", { filter: "name contains 'a'", mapId: a.id });
    expect(sel.status).toBe(200);
    expect(sel.body).toEqual({ matched: 3, selected: 3 });
    const op = ops.find((o) => o.op === "selectOnMap");
    expect(op).toMatchObject({ mapId: a.id, role: "buildings" });
    const bad = await post("/api/data/buildings/select", { filter: "name contains", mapId: a.id });
    expect(bad.status).toBe(400);
    expect(typeof bad.body.position).toBe("number");

    const src = await post("/api/data/source", { role: "buildings", source: { kind: "osm" } });
    expect(src.body.counts.buildings).toBe(0);
    await post("/api/data/refresh");
    expect((await get("/api/project")).body.counts.buildings).toBe(osmBuildings);
  });

  it("maps: defaults, edit, delete, preset; targets pass through", async () => {
    await parklandWithTwoMaps();
    const m = await post("/api/maps", { name: "Car park", centre: CENTRE });
    expect(m.body).toMatchObject({ scale: 2500, rotationDeg: 0, sizeMm: { width: 420, height: 297 }, marker: true, sent: null });
    const p = await patch(`/api/maps/${m.body.id}`, { rotationDeg: -30, name: "Car park north" });
    expect(p.body).toMatchObject({ rotationDeg: -30, name: "Car park north" });
    expect((await patch("/api/maps/nope", { name: "x" })).status).toBe(404);
    expect((await del(`/api/maps/${m.body.id}`)).body).toEqual({ ok: true });
    expect((await get("/api/project")).body.project.maps).toHaveLength(2);
    const pr = await post("/api/style/preset", { name: "Dark" });
    expect(pr.body.presetName).toBe("Dark");
    const t = await get("/api/targets");
    expect(t.body).toEqual({ documents: [{ docId: "doc-1", title: "Parkland.af", artboards: [] }] });
  });
});

const DATASET = (features: Dataset["features"]): Dataset => ({
  name: "x", sourcePath: "", sourceFormat: "geojson", crs: WGS84, kind: "point", features,
  report: { read: features.length, skipped: 0, reasons: [] },
});

describe("app window API", () => {
  it("every /api route needs X-Geo-App", async () => {
    const r = await fetch(base + "/api/project");
    expect(r.status).toBe(403);
    expect(((await r.json()) as any).error).toBe("Only the AffinityGeo app can use this address.");
    expect((await fetch(base + "/api/presets", { headers: { "X-Geo-App": "0" } })).status).toBe(403);
    expect((await fetch(base + "/api/presets", { headers: APP })).status).toBe(200);
  });

  it("preview/area: 409 until data is fetched, then projected bounds contain every feature", async () => {
    await post("/api/project/new", { name: "C", area: { placeName: "Parkland", bboxWgs84: PARKLAND }, preset: "Light" });
    const empty = await get("/api/preview/area");
    expect(empty.status).toBe(409);
    expect(empty.body.error).toBe("Fetch the data first.");
    await post("/api/data/refresh");
    const r = await get("/api/preview/area");
    expect(r.status).toBe(200);
    const [x0, y0, x1, y1] = r.body.bounds;
    expect(x0).toBeLessThan(x1);
    expect(x0).toBeGreaterThan(400000); // British National Grid metres, London
    const order = r.body.layers.map((l: any) => ROLE_IDS.indexOf(l.role));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(r.body.layers.length).toBeGreaterThan(0);
    let n = 0;
    for (const l of r.body.layers) {
      expect(["polygon", "line", "point"]).toContain(l.kind);
      for (const f of l.features) {
        expect(typeof f.fid).toBe("string");
        for (const path of f.paths) for (const [x, y] of path) {
          n++;
          expect(x).toBeGreaterThanOrEqual(x0); expect(x).toBeLessThanOrEqual(x1);
          expect(y).toBeGreaterThanOrEqual(y0); expect(y).toBeLessThanOrEqual(y1);
        }
      }
    }
    expect(n).toBeGreaterThan(0);
  });

  it("maps/:id/preview equals buildMapJob; unknown map is 404", async () => {
    const { a } = await parklandWithTwoMaps();
    const r = await get(`/api/maps/${a.id}/preview`);
    expect(r.status).toBe(200);
    const want = JSON.parse(JSON.stringify(buildMapJob(srv.session.current, srv.session.data, a.id)));
    expect(r.body).toEqual(want);
    expect((await get("/api/maps/nope/preview")).status).toBe(404);
  });

  it("POST /api/maps/:id/link sets target and clears resizeArtboard", async () => {
    const { a, b } = await parklandWithTwoMaps();
    docs[0].artboards.push({ name: "Blank", mapIds: [], widthMm: 100, heightMm: 100 });
    await patch(`/api/maps/${a.id}`, { target: null, resizeArtboard: true });
    const r = await post(`/api/maps/${a.id}/link`, { docId: "doc-1", artboardIndex: 0, artboardName: "Blank" });
    expect(r.status).toBe(200);
    expect(r.body.map.target).toEqual(TARGET);
    expect(r.body.map.resizeArtboard).toBeNull();
    expect(srv.session.map(a.id).target).toEqual(TARGET);
    const op = ops.find((o) => o.op === "linkArtboard");
    expect(op).toMatchObject({ projectId: srv.session.current.id, mapId: a.id, docId: "doc-1", artboardIndex: 0, artboardName: "Blank", otherMapNames: { [b.id]: "Library map" } });
    expect(op.otherMapNames[a.id]).toBeUndefined();
    // the resize question is asked on the next send (100 x 100 mm artboard vs the map's size)
    const s = await post("/api/send", { mapIds: [a.id] });
    expect(s.body.results[0]).toMatchObject({ ok: false, needsResizeChoice: true });
  });

  it("re-linking to another same-size artboard reads Changed since sent; the same artboard stays Up to date", async () => {
    const { a } = await parklandWithTwoMaps();
    docs[0].artboards.push({ name: "A", mapIds: [], widthMm: 420, heightMm: 297 }, { name: "B", mapIds: [], widthMm: 420, heightMm: 297 });
    expect((await post(`/api/maps/${a.id}/link`, { docId: "doc-1", artboardIndex: 0, artboardName: "A" })).status).toBe(200);
    const s = await post("/api/send", { mapIds: [a.id] });
    expect(s.body.results[0]).toMatchObject({ ok: true });
    const sentIds = srv.session.map(a.id).sent!.objectIds;
    expect((await statuses())[0]).toBe("Up to date");

    // The same artboard again: nothing moved.
    expect((await post(`/api/maps/${a.id}/link`, { docId: "doc-1", artboardIndex: 0, artboardName: "A" })).status).toBe(200);
    expect((await statuses())[0]).toBe("Up to date");

    // Another artboard of the same size: it is empty, so the map needs sending again.
    expect((await post(`/api/maps/${a.id}/link`, { docId: "doc-1", artboardIndex: 1, artboardName: "B" })).status).toBe(200);
    expect((await statuses())[0]).toBe("Changed since sent");
    expect(srv.session.map(a.id).sent!.objectIds).toEqual(sentIds); // kept for the next send
  });

  it("re-linking to an artboard in another document reads Changed since sent", async () => {
    const { a } = await parklandWithTwoMaps();
    docs[0].artboards.push({ name: "A", mapIds: [], widthMm: 420, heightMm: 297 });
    docs.push({ docId: "doc-2", title: "Other.af", artboards: [{ name: "A", mapIds: [], widthMm: 420, heightMm: 297 }] });
    await post(`/api/maps/${a.id}/link`, { docId: "doc-1", artboardIndex: 0, artboardName: "A" });
    await post("/api/send", { mapIds: [a.id] });
    expect((await statuses())[0]).toBe("Up to date");
    expect((await post(`/api/maps/${a.id}/link`, { docId: "doc-2", artboardIndex: 0, artboardName: "A" })).status).toBe(200);
    expect((await statuses())[0]).toBe("Changed since sent");
  });

  it("link: bad input is 400, an unknown map 404, Affinity's refusal 502 and leaves the map unchanged", async () => {
    const { a } = await parklandWithTwoMaps();
    docs[0].artboards.push({ name: "Blank", mapIds: [], widthMm: 100, heightMm: 100 });
    expect((await post(`/api/maps/${a.id}/link`, { docId: "doc-1", artboardIndex: -1, artboardName: "Blank" })).status).toBe(400);
    expect((await post(`/api/maps/${a.id}/link`, { docId: "doc-1", artboardIndex: 0 })).status).toBe(400);
    expect((await post(`/api/maps/${a.id}/link`, { artboardIndex: 0, artboardName: "Blank" })).status).toBe(400);
    expect((await post("/api/maps/nope/link", { docId: "doc-1", artboardIndex: 0, artboardName: "Blank" })).status).toBe(404);
    const stale = await post(`/api/maps/${a.id}/link`, { docId: "doc-1", artboardIndex: 0, artboardName: "Old name" });
    expect(stale.status).toBe(502);
    expect(stale.body.error).toContain("The artboards changed in Affinity. Pick the artboard again.");
    expect(srv.session.map(a.id).target).toEqual(TARGET);
  });

  it("match returns fids; a bad filter gives 400 with position", async () => {
    await parklandWithTwoMaps();
    await post("/api/data/import", { path: BNG, role: "buildings" });
    const all = (await get("/api/data/buildings/features?limit=10")).body.rows.map((x: any) => x.fid);
    const m = await get("/api/data/buildings/match?filter=" + encodeURIComponent("name contains 'a'"));
    expect(m.status).toBe(200);
    expect(m.body).toEqual({ fids: all });
    const bad = await get("/api/data/buildings/match?filter=" + encodeURIComponent("name contains"));
    expect(bad.status).toBe(400);
    expect(typeof bad.body.position).toBe("number");
    expect((await get("/api/data/nope/match?filter=x")).status).toBe(404);
  });

  it("features sorts numbers numerically and puts nulls last", async () => {
    await parklandWithTwoMaps();
    const pt = { type: "Point" as const, coordinates: [0, 0] as [number, number] };
    const mk = (fid: string, name: string, h: number | null) => ({ fid, name, geometry: pt, attrs: { h } });
    srv.session.data.landmarks = DATASET([mk("a", "Alpha", 10), mk("b", "Bravo", 9), mk("c", "Charlie", null), mk("d", "Delta", 100), mk("e", "Echo", 9)]);
    const ids = async (qs: string) => (await get(`/api/data/landmarks/features?${qs}`)).body.rows.map((x: any) => x.fid);
    expect(await ids("sort=h&dir=asc")).toEqual(["b", "e", "a", "d", "c"]); // stable for ties
    expect(await ids("sort=h&dir=desc")).toEqual(["d", "a", "b", "e", "c"]);
    expect(await ids("sort=name&dir=desc")).toEqual(["e", "d", "c", "b", "a"]);
    expect(await ids("sort=h")).toEqual(["b", "e", "a", "d", "c"]);
    expect((await get("/api/data/landmarks/features?sort=h&dir=sideways")).status).toBe(400);
  });

  it("projections offers bng+utm in London, utm only in Paris; POST area changes the hash", async () => {
    const { a } = await parklandWithTwoMaps();
    const list = (await get("/api/projections")).body;
    expect(list.map((p: any) => p.id)).toEqual(["bng", "utm"]);
    expect(list[0]).toMatchObject({ id: "bng", suggested: true });
    expect(list[1]).toMatchObject({ id: "utm", params: { zone: 30 }, suggested: false });
    expect(typeof list[0].name).toBe("string");
    expect(typeof list[0].description).toBe("string");

    const before = (await get(`/api/maps/${a.id}/preview`)).body.hash;
    await post("/api/project/save", { path: join(dir, "p.afgeo") });
    expect((await get("/api/project")).body.dirty).toBe(false);
    const set = await post("/api/project/area", { projectionId: "utm", projectionParams: { zone: 30 } });
    expect(set.status).toBe(200);
    expect(set.body.area).toMatchObject({ projectionId: "utm", projectionParams: { zone: 30 } });
    expect((await get("/api/project")).body.dirty).toBe(true);
    expect((await get(`/api/maps/${a.id}/preview`)).body.hash).not.toBe(before);
    expect((await post("/api/project/area", { projectionId: "utm", projectionParams: { zone: 31 } })).status).toBe(400);
    expect((await post("/api/project/area", { projectionId: "laea" })).status).toBe(400);

    await post("/api/project/new", { name: "Paris", area: { placeName: "Paris", bboxWgs84: [2.33, 48.85, 2.37, 48.87] }, preset: "Light" });
    const paris = (await get("/api/projections")).body;
    expect(paris).toEqual([expect.objectContaining({ id: "utm", params: { zone: 31 }, suggested: true })]);
    expect((await post("/api/project/area", { projectionId: "bng" })).status).toBe(400);
  });

  it("projection text has no jargon; omitted params use the offered ones; no project gives 409", async () => {
    expect((await get("/api/projections")).status).toBe(409);
    await parklandWithTwoMaps();
    for (const p of (await get("/api/projections")).body) {
      expect(p.name + " " + p.description).not.toMatch(/EPSG|CRS/i);
    }
    const set = await post("/api/project/area", { projectionId: "utm" });
    expect(set.status).toBe(200);
    expect(set.body.area.projectionParams).toEqual({ zone: 30 });
  });

  it("scripts works without a project; a bad AFFINITYGEO_HOME is a plain 500-free error", async () => {
    expect((await get("/api/scripts")).status).not.toBe(409);
    const old = process.env.AFFINITYGEO_HOME;
    process.env.AFFINITYGEO_HOME = "C:\\bad folder\\é";
    try {
      const r = await get("/api/scripts");
      expect(r.status).toBe(400);
      expect(r.body.error).toContain("plain letters");
    } finally {
      if (old === undefined) delete process.env.AFFINITYGEO_HOME; else process.env.AFFINITYGEO_HOME = old;
    }
  });

  it("scripts returns the loader with the home path, and whether connect.js is installed", async () => {
    const home = join(dir, "geo").replace(/\\/g, "/");
    const s3 = await startServer({ port: 0, home });
    try {
      const url = `http://127.0.0.1:${s3.port}/api/scripts`;
      const first = (await (await fetch(url, { headers: APP })).json()) as any;
      expect(first.home).toBe(home);
      expect(first.installed).toBe(false);
      expect(first.loader).toContain("name: Geo – Connect");
      expect(first.loader).toContain(`require('${home}/affinity/connect.js').start({ home: '${home}' });`);
      mkdirSync(join(home, "affinity"), { recursive: true });
      writeFileSync(join(home, "affinity", "connect.js"), "//");
      expect(((await (await fetch(url, { headers: APP })).json()) as any).installed).toBe(true);
    } finally { await s3.close(); }
  });
});

describe("scripts note", () => {
  it("shows the note until Affinity first polls, then clears it; a failure note stays", async () => {
    const home = join(tmpdir(), "geo-note-home").replace(/\\/g, "/");
    const note = "Scripts updated. In Affinity, run Geo – Connect again.";
    const s4 = await startServer({ port: 0, home, scripts: { note, untilConnected: true, version: "1.0.0" } });
    const s5 = await startServer({ port: 0, home, scripts: { note: "Scripts couldn't be installed", untilConnected: false } });
    try {
      const read = async (s: { port: number }) =>
        ((await (await fetch(`http://127.0.0.1:${s.port}/api/scripts`, { headers: APP })).json()) as any).scriptsNote;
      const poll = (s: { port: number }) => fetch(`http://127.0.0.1:${s.port}/affinity/next`, { headers: { "x-geo-connect": "1", "x-geo-scripts": "1.0.0" } });
      expect(await read(s4)).toBe(note);
      await poll(s4);
      expect(await read(s4)).toBeNull();
      await poll(s5);
      expect(await read(s5)).toBe("Scripts couldn't be installed");
    } finally { await s4.close(); await s5.close(); }
  });
});

describe("scripts note and the poller's version", () => {
  it("only a poll that reports the app's version clears the note", async () => {
    const home = join(tmpdir(), "geo-note-home2").replace(/\\/g, "/");
    const s6 = await startServer({ port: 0, home, scripts: { note: "n", untilConnected: true, version: "2.0.0" } });
    try {
      const read = async () => ((await (await fetch(`http://127.0.0.1:${s6.port}/api/scripts`, { headers: APP })).json()) as any).scriptsNote;
      const poll = (v?: string) => fetch(`http://127.0.0.1:${s6.port}/affinity/next`, { headers: { "x-geo-connect": "1", ...(v ? { "x-geo-scripts": v } : {}) } });
      await poll();
      expect(await read()).toBe("n");
      await poll("1.0.0");
      expect(await read()).toBe("n");
      await poll("2.0.0");
      expect(await read()).toBeNull();
    } finally { await s6.close(); }
  });
});

describe("static UI", () => {
  let s4: Awaited<ReturnType<typeof startServer>>;
  beforeEach(async () => {
    const ui = join(dir, "ui");
    mkdirSync(ui);
    writeFileSync(join(ui, "index.html"), "<h1>hi</h1>");
    writeFileSync(join(ui, "app.js"), "console.log(1)");
    writeFileSync(join(ui, "app.css"), "a{}");
    writeFileSync(join(dir, "secret.txt"), "secret");
    s4 = await startServer({ port: 0, uiDir: ui });
  });
  afterEach(async () => { await s4.close(); });

  it("/ serves index.html; /app.js serves JS; traversal and other paths are 404", async () => {
    const u = `http://127.0.0.1:${s4.port}`;
    const root = await fetch(u + "/");
    expect(root.status).toBe(200);
    expect(root.headers.get("content-type")).toContain("text/html");
    expect(await root.text()).toBe("<h1>hi</h1>");
    const js = await fetch(u + "/app.js");
    expect(js.headers.get("content-type")).toContain("text/javascript");
    expect((await fetch(u + "/app.css")).headers.get("content-type")).toContain("text/css");
    expect((await fetch(u + "/missing.js")).status).toBe(404);
    expect((await fetch(u + "/ui")).status).toBe(404);
    for (const path of ["/../package.json", "/../secret.txt", "/..%2fsecret.txt", "/%2e%2e%2fsecret.txt", "/%2fsecret.txt", "/sub/app.js", "/..%5csecret.txt"]) {
      const r = await rawRequest(s4.port, { method: "GET", path, headers: { Host: `127.0.0.1:${s4.port}` } });
      expect(r.status, path).toBe(404);
    }
    const head = await fetch(u + "/app.js", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect((await fetch(u + "/app.js", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status).toBe(404);
  });

  it("a symlink inside uiDir is not served", async () => {
    const { symlinkSync } = await import("node:fs");
    try { symlinkSync(join(dir, "secret.txt"), join(dir, "ui", "link.css")); } catch { return; } // no symlink rights: nothing to test
    expect((await fetch(`http://127.0.0.1:${s4.port}/link.css`)).status).toBe(404);
  });

  it("without a uiDir nothing is served at /", async () => {
    expect((await fetch(base + "/")).status).toBe(404);
  });
});

function rawRequest(port: number, opts: { method: string; path: string; headers: Record<string, string>; body?: string }) {
  return new Promise<{ status: number; body: any }>((resolveP, reject) => {
    const req = request({ host: "127.0.0.1", port, method: opts.method, path: opts.path, headers: opts.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolveP({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
    });
    req.on("error", reject);
    req.end(opts.body);
  });
}

describe("request checks", () => {
  it("rejects a foreign Host, non-JSON writes and oversize bodies; old frame routes are gone", async () => {
    const r = await rawRequest(srv.port, { method: "GET", path: "/api/presets", headers: { Host: "evil.example:80" } });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("AffinityGeo only accepts requests from this computer.");
    expect((await fetch(base + "/api/maps", { method: "POST", headers: APP, body: "{}" })).status).toBe(415);
    expect((await fetch(base + "/api/maps/x", { method: "PATCH", headers: APP, body: "{}" })).status).toBe(415);
    const big = await fetch(base + "/api/maps", { method: "POST", headers: { ...APP, "Content-Type": "application/json" }, body: "x".repeat(51 * 1024 * 1024) });
    expect(big.status).toBe(413);
    expect((await post("/api/frames", { name: "x" })).status).toBe(404);
  });

  it("answers a malformed percent-encoded address with 400, not 500", async () => {
    const malformed = await fetch(base + "/api/data/%E0/features", { headers: APP });
    expect(malformed.status).toBe(400);
    expect(((await malformed.json()) as any).error).toBe("That address isn't valid.");
  });

  it("refuses /affinity/* without the X-Geo-Connect header, so a web page can't take a job", async () => {
    for (const path of ["/affinity/next", "/affinity/done?id=x"]) {
      const r = await fetch(base + path);
      expect(r.status).toBe(403);
      expect(((await r.json()) as any).error).toBe("Only the Geo – Connect script in Affinity can use this address.");
    }
    expect((await fetch(base + "/affinity/next", { headers: { "X-Geo-Connect": "yes" } })).status).toBe(403);
  });
});

describe("when Affinity is absent or slow", () => {
  let s2: Awaited<ReturnType<typeof startServer>>;
  let b2: string;
  beforeEach(async () => {
    s2 = await startServer({ port: 0, affinityLimits: { connectedMs: 300, pickupMs: 200, runMs: 1_500 }, fetchOsm: async () => parseOverpass(OSM) });
    b2 = `http://127.0.0.1:${s2.port}`;
  });
  afterEach(async () => { await s2.close(); });
  const j = (method: string, path: string, body?: unknown) =>
    fetch(b2 + path, { method, headers: body === undefined ? APP : { ...APP, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const poll = async () => (await fetch(b2 + "/affinity/next", { headers: CONNECT })).json() as Promise<any>;
  const next = async () => {
    let job: any = { idle: true };
    while (job.idle) job = await poll();
    return job;
  };
  const done = (id: string, result: unknown) =>
    fetch(`${b2}/affinity/done?id=${id}`, { headers: { ...CONNECT, "X-Geo-Result": encodeURIComponent(JSON.stringify(result)) } });
  const wait = (ms: number) => new Promise((res) => setTimeout(res, ms));
  const DOCS = { ok: true, result: { documents: [{ docId: "doc-1", title: "Parkland.af", artboards: [] }] } };
  const SENT = { ok: true, result: { created: 1, updated: 0, removed: 0, keptEdited: [], resized: false, warnings: [], objectIds: ["paths:1"], docId: "doc-1", docTitle: "Parkland.af" } };

  async function oneMap(): Promise<string> {
    await j("POST", "/api/project/new", { name: "C", area: { placeName: "Parkland", bboxWgs84: PARKLAND }, preset: "Light" });
    await j("POST", "/api/data/refresh", {});
    const m = (await (await j("POST", "/api/maps", { name: "Late", centre: CENTRE })).json()) as any;
    await j("PATCH", `/api/maps/${m.id}`, { target: TARGET });
    return m.id;
  }

  it("with Geo – Connect not polling, Affinity calls fail at once with 503 and queue nothing", async () => {
    await oneMap();
    expect(await (await j("GET", "/api/affinity")).json()).toEqual({ connected: false, busy: false });
    const t0 = Date.now();
    for (const [m, p] of [["GET", "/api/targets"], ["GET", "/api/maps/status"], ["POST", "/api/send"]] as const) {
      const r = await j(m, p, m === "POST" ? {} : undefined);
      expect(r.status).toBe(503);
      expect(((await r.json()) as any).error).toBe("Affinity isn't connected. Run the Geo – Connect script in Affinity.");
    }
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(await poll()).toEqual({ idle: true });
  });

  it("/api/affinity reflects polling, and busy while a job runs", async () => {
    await oneMap();
    await poll();
    expect(await (await j("GET", "/api/affinity")).json()).toEqual({ connected: true, busy: false });
    await wait(400);
    expect(((await (await j("GET", "/api/affinity")).json()) as any).connected).toBe(false);
    await poll();
    const pending = j("GET", "/api/targets");
    const lt = await next();
    await wait(400); // quiet while it "draws"
    expect(await (await j("GET", "/api/affinity")).json()).toEqual({ connected: true, busy: true });
    await done(lt.id, DOCS);
    expect((await pending).status).toBe(200);
  });

  it("a long draw past the pickup time (no polls meanwhile) still succeeds and records sent", async () => {
    const mapId = await oneMap();
    await poll();
    const pending = j("POST", "/api/send", {});
    const lt = await next();
    await done(lt.id, DOCS);
    const sm = await next();
    await wait(800); // well past pickupMs and connectedMs
    await done(sm.id, SENT);
    const res = (await (await pending).json()) as any;
    expect(res.results[0]).toMatchObject({ mapId, ok: true, created: 1 });
    const info = (await (await j("GET", "/api/project")).json()) as any;
    expect(info.project.maps[0].sent.objectIds).toEqual(["paths:1"]);
  });

  it("a send Affinity finishes after the run cap reports 'still drawing' and doesn't count as sent", async () => {
    const mapId = await oneMap();
    await poll();
    const pending = j("POST", "/api/send", {});
    const lt = await next();
    expect(lt.op.op).toBe("listTargets");
    await done(lt.id, DOCS);
    const sm = await next();
    expect(sm.op.op).toBe("sendMap");
    const res = (await (await pending).json()) as any;
    expect(res.results[0]).toEqual(expect.objectContaining({ mapId, ok: false, error: "Affinity is still drawing Late…" }));
    await done(sm.id, SENT);
    const info = (await (await j("GET", "/api/project")).json()) as any;
    expect(info.project.maps[0].sent).toBeNull();
    expect(await poll()).toEqual({ idle: true });
  });
});
