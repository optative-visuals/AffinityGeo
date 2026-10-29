// The whole sendMap flow against an in-memory fake SDK (fake-sdk.cjs). Proves the logic;
// the real SDK calls are checked by hand in Affinity.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import proj4 from "proj4";
import { readDataset } from "../../geo-core/src/read/index.js";
import { crsFromEpsg } from "../../geo-core/src/crs.js";
import { newProject } from "../../geo-core/src/project/file.js";
import { buildMapJob } from "../../geo-core/src/project/mapjob.js";

const requireCjs = createRequire(import.meta.url);
const dm = requireCjs("../src/draw-map.js");
const sendPlan = requireCjs("../src/send-plan.js");
const plan = requireCjs("../src/plan.js");
const { fakeSdk, makeDoc, Transform } = requireCjs("./fake-sdk.cjs");

const deps = { sendPlan, plan };
const BNG = crsFromEpsg(27700);
let data;
let centre;

beforeAll(async () => {
  const ds = (await readDataset(fileURLToPath(new URL("../../geo-core/test/fixtures/bng3/bng3.shp", import.meta.url))))[0];
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  const walk = (x) => {
    if (Array.isArray(x) && typeof x[0] === "number") { a = Math.min(a, x[0]); c = Math.max(c, x[0]); b = Math.min(b, x[1]); d = Math.max(d, x[1]); }
    else if (Array.isArray(x)) x.forEach(walk);
  };
  ds.features.forEach((f) => walk(f.geometry.coordinates));
  centre = proj4(BNG.proj4, "+proj=longlat +datum=WGS84 +no_defs", [(a + c) / 2, (b + d) / 2]);
  data = { buildings: ds, water: ds };
});

function project(over = {}) {
  const p = newProject("T", { placeName: "T", bboxWgs84: [-1, 51, 0, 52], projectionId: "bng" }, "Light");
  p.id = "p1";
  p.maps.push({ id: "m1", name: "Map 1", centre, scale: 5000, rotationDeg: 0, sizeMm: { width: 420, height: 297 },
    marker: true, target: null, resizeArtboard: null, sent: null, ...over });
  return p;
}
const jobFor = (p) => buildMapJob(p, data, "m1");
const target = { docId: "doc-1", docTitle: "Sign.af" };

let doc;
let fake;
beforeEach(() => {
  fake = fakeSdk();
  dm._useSdk(fake);
  doc = makeDoc({ dpi: 72 });
  doc.addArtboard({ x: 0, y: 0, width: 500, height: 500 });
});

const byName = (name) => doc.allNodes().find((n) => n.userDescription === name);
const objects = () => doc.allNodes().filter((n) => n.tags.has("geo:fid"));

describe("sendMap in a fake document", () => {
  it("makes a tagged artboard to the right with role layers in order and the marker on top", () => {
    const job = jobFor(project());
    expect(job.layers.length).toBe(2);
    const r = dm.sendMap([doc], { job, target, resizeArtboard: null, reset: false }, deps);
    const abs = doc.layers.filter((n) => n.kind === "artboard");
    expect(abs).toHaveLength(2);
    const ab = abs[1];
    expect(ab.box).toMatchObject({ x: 600, y: 0 });
    expect(ab.box.width).toBeCloseTo(420 * 72 / 25.4, 6);
    expect(ab.box.height).toBeCloseTo(297 * 72 / 25.4, 6);
    expect(JSON.parse(ab.tags.get("geo:map"))).toEqual({ projectId: "p1", mapId: "m1" });
    expect(ab.userDescription).toBe("Map 1");
    const group = ab.kids[0];
    expect(group.userDescription).toBe("Map — Map 1");
    expect(group.kids.map((k) => k.userDescription)).toEqual(["Frame", "Background", "Water", "Buildings", "You are here"]);
    expect(group.kids.slice(1).map((k) => k.tags.get("geo:role"))).toEqual(["background", "water", "buildings", "marker"]);
    const marker = group.kids[4];
    expect(marker.kids.map((k) => k.tags.get("geo:fid"))).toEqual(["marker:ring", "marker:dot", "marker:label"]);
    const features = job.layers.reduce((n, l) => n + l.features.length, 0);
    expect(r.created).toBe(features + 4); // + the background, ring, dot and label
    expect(r).toMatchObject({ updated: 0, removed: 0, keptEdited: [], resized: false, docId: "doc-1" });
    expect(r.objectIds).toHaveLength(features + 4);
    expect(r.objectIds).toContain("background:frame");
    // nothing is left untagged
    for (const k of group.kids.slice(1)) for (const o of k.kids) expect(o.tags.has("geo:fid")).toBe(true);
  });

  it("reads back exactly the props it sent (the key contract)", () => {
    const job = jobFor(project());
    dm.sendMap([doc], { job, target, resizeArtboard: null, reset: false }, deps);
    const group = byName("Map — Map 1");
    const R = JSON.parse(group.tags.get("geo:mapframe")).rect;
    const mapping = dm.frameMapping(R, R, 72 / 25.4, plan);
    let n = 0;
    for (const o of objects()) {
      if (o.tags.get("geo:fid") === "marker:label") continue;
      const sent = JSON.parse(o.tags.get("geo:sent"));
      const fid = o.tags.get("geo:fid");
      const kind = fid.startsWith("marker:") ? "point" : fid.startsWith("background:") ? "polygon" : job.layers.find((l) => fid.startsWith(l.role + ":")).kind;
      const cur = dm.readProps(o, kind, mapping, 72, sendPlan.geomSignature);
      expect({ ...cur, geom: undefined }).toEqual({ ...sent, geom: undefined });
      expect(sendPlan.geomSame(cur.geom, sent.geom)).toBe(true);
      n++;
    }
    expect(n).toBeGreaterThan(5);
  });

  it("re-sending changes nothing", () => {
    const job = jobFor(project());
    dm.sendMap([doc], { job, target, resizeArtboard: null, reset: false }, deps);
    const r = dm.sendMap([doc], { job, target, resizeArtboard: null, reset: false }, deps);
    expect(r).toMatchObject({ created: 0, updated: 0, removed: 0, keptEdited: [] });
  });

  it("keeps a hand recolour and recolours the rest", () => {
    const p = project();
    dm.sendMap([doc], { job: jobFor(p), target, resizeArtboard: null, reset: false }, deps);
    const buildings = byName("Buildings").kids;
    expect(buildings.length).toBeGreaterThan(1);
    buildings[0].fillHex = "#ff00ff"; // the designer's edit
    p.style.roles.buildings.fill = "#123456";
    const r = dm.sendMap([doc], { job: jobFor(p), target, resizeArtboard: null, reset: false }, deps);
    expect(buildings[0].fillHex).toBe("#ff00ff");
    for (const b of buildings.slice(1)) expect(b.fillHex).toBe("#123456");
    expect(r.updated).toBe(buildings.length - 1);
    expect(r.keptEdited).toEqual([expect.objectContaining({ role: "buildings", reason: "edited by hand" })]);
    // the edited one still remembers the old sent fill, so a third send still leaves it alone
    const again = dm.sendMap([doc], { job: jobFor(p), target, resizeArtboard: null, reset: false }, deps);
    expect(again.updated).toBe(0);
    expect(buildings[0].fillHex).toBe("#ff00ff");
    // reset puts it back
    dm.sendMap([doc], { job: jobFor(p), target, resizeArtboard: null, reset: true }, deps);
    expect(buildings[0].fillHex).toBe("#123456");
  });

  it("recolours the 'You are here' label, and keeps a hand recolour of it (live check: text colour is in the story)", () => {
    const p = project();
    dm.sendMap([doc], { job: jobFor(p), target, resizeArtboard: null, reset: false }, deps);
    const label = objects().find((n) => n.tags.get("geo:fid") === "marker:label");
    expect(dm.sendMap([doc], { job: jobFor(p), target, resizeArtboard: null, reset: false }, deps).keptEdited).toEqual([]);
    p.style.marker.text = "#c0392b";
    dm.sendMap([doc], { job: jobFor(p), target, resizeArtboard: null, reset: false }, deps);
    expect(label.fillHex).toBe("#c0392b");
    label.fillHex = "#00aa00"; // the designer's edit
    p.style.marker.text = "#222222";
    dm.sendMap([doc], { job: jobFor(p), target, resizeArtboard: null, reset: false }, deps);
    expect(label.fillHex).toBe("#00aa00");
  });

  it("resizes the artboard when asked, and centres the map otherwise", () => {
    const ab = doc.layers[0];
    ab.tags.set("geo:map", JSON.stringify({ projectId: "p1", mapId: "m1" }));
    const job = jobFor(project());
    const r1 = dm.sendMap([doc], { job, target, resizeArtboard: false, reset: false }, deps);
    expect(r1.resized).toBe(false);
    expect(ab.box).toMatchObject({ width: 500, height: 500 });
    const R = JSON.parse(byName("Map — Map 1").tags.get("geo:mapframe")).rect;
    expect(R.x).toBeCloseTo((500 - 420 * 72 / 25.4) / 2, 1);
    expect(R.y).toBeCloseTo((500 - 297 * 72 / 25.4) / 2, 1);

    const doc2 = makeDoc({ uuid: "doc-2", title: "Other.af" });
    const ab2 = doc2.addArtboard({ x: 0, y: 0, width: 300, height: 300 });
    ab2.tags.set("geo:map", JSON.stringify({ projectId: "p1", mapId: "m2" }));
    const job2 = { ...job, mapId: "m2" };
    const r2 = dm.sendMap([doc, doc2], { job: job2, target: { docId: "doc-2", docTitle: "Other.af" }, resizeArtboard: true, reset: false }, deps);
    expect(r2.resized).toBe(true);
    expect(ab2.box.width).toBeCloseTo(420 * 72 / 25.4, 6);
    expect(ab2.box.height).toBeCloseTo(297 * 72 / 25.4, 6);
    expect(ab2.kids[0].userDescription).toBe("Map — Map 1");
    expect(JSON.parse(ab2.kids[0].tags.get("geo:mapframe")).rect).toMatchObject({ x: 0, y: 0 });
  });

  it("says which document to open and draws nowhere else", () => {
    const before = doc.allNodes().length;
    expect(() => dm.sendMap([doc], { job: jobFor(project()), target: { docId: "gone", docTitle: "Signs.af" }, resizeArtboard: null, reset: false }, deps))
      .toThrow("Open 'Signs.af' in Affinity to update Map 1");
    expect(doc.allNodes().length).toBe(before);
  });

  it("a target without a document id finds the map in whichever open document holds it, by its artboard tag", () => {
    const job = jobFor(project());
    dm.sendMap([doc], { job, target, resizeArtboard: null, reset: false }, deps);
    const other = makeDoc({ uuid: "doc-9", title: "Elsewhere.af" });
    const r = dm.sendMap([other, doc], { job, target: { docId: "", docTitle: "Closed.af" }, resizeArtboard: null, reset: false }, deps);
    expect(r).toMatchObject({ created: 0, docId: "doc-1" });
    expect(other.allNodes()).toHaveLength(0);
  });

  it("a target with a document id is drawn only into that document, never into a Save-As copy", () => {
    const job = jobFor(project());
    dm.sendMap([doc], { job, target, resizeArtboard: null, reset: false }, deps); // doc-1 now holds the map: the "copy"
    const copyBefore = doc.allNodes().length;
    // Target A is closed: refuse, and draw nothing into the copy.
    expect(() => dm.sendMap([doc], { job, target: { docId: "A", docTitle: "Signs.af" }, resizeArtboard: null, reset: false }, deps))
      .toThrow("Open 'Signs.af' in Affinity to update Map 1");
    expect(doc.allNodes()).toHaveLength(copyBefore);
    // Target A open as well: a new artboard is made in A, the copy is untouched.
    const a = makeDoc({ uuid: "A", title: "Signs.af" });
    const r = dm.sendMap([doc, a], { job, target: { docId: "A", docTitle: "Signs.af" }, resizeArtboard: null, reset: false }, deps);
    expect(r.docId).toBe("A");
    expect(r.created).toBeGreaterThan(0);
    expect(a.layers.filter((n) => n.kind === "artboard" && n.tags.has("geo:map"))).toHaveLength(1);
    expect(doc.allNodes()).toHaveLength(copyBefore);
  });

  it("puts back a deleted frame outline and says so", () => {
    const job = jobFor(project());
    dm.sendMap([doc], { job, target, resizeArtboard: null, reset: false }, deps);
    const outline = byName("Frame");
    doc.remove(outline);
    const r = dm.sendMap([doc], { job, target, resizeArtboard: null, reset: false }, deps);
    expect(r.warnings).toContain(dm.OUTLINE_BACK);
    expect(byName("Map — Map 1").kids[0].userDescription).toBe("Frame");
    expect(r.created).toBe(0);
  });

  it("follows a moved frame without treating every object as reshaped", () => {
    const job = jobFor(project());
    dm.sendMap([doc], { job, target, resizeArtboard: null, reset: false }, deps);
    // the designer drags the whole map group 50 px right: every curve and the outline move
    const group = byName("Map — Map 1");
    const shift = (n) => {
      if (n.pc) for (const c of n.pc.curves) { if (c.ellipse) c.ellipse = { ...c.ellipse, cx: c.ellipse.cx + 50 }; else c.pts = c.pts.map(([x, y]) => [x + 50, y]); }
      n.kids.forEach(shift);
    };
    shift(group);
    const r = dm.sendMap([doc], { job, target, resizeArtboard: null, reset: false }, deps);
    expect(r).toMatchObject({ created: 0, updated: 0, removed: 0, keptEdited: [] });
  });

  it("removes objects that left the map unless edited, and doesn't recreate deleted ones", () => {
    const p = project();
    const first = dm.sendMap([doc], { job: jobFor(p), target, resizeArtboard: null, reset: false }, deps);
    const water = byName("Water").kids.slice();
    doc.remove(water[0]); // the designer deleted one
    const r = dm.sendMap([doc], { job: jobFor(p), target, resizeArtboard: null, reset: false, sentIds: first.objectIds }, deps);
    expect(r.created).toBe(0);
    expect(r.warnings.join(" ")).toMatch(/you deleted was not recreated/);
    const deletedId = water[0].tags.get("geo:fid");
    expect(r.objectIds).toContain(deletedId); // carried forward, so it stays deleted
    const again = dm.sendMap([doc], { job: jobFor(p), target, resizeArtboard: null, reset: false, sentIds: r.objectIds }, deps);
    expect(again.created).toBe(0);
    expect(again.objectIds).toContain(deletedId);
    p.style.roles.water.visible = false; // water leaves the job
    const r2 = dm.sendMap([doc], { job: jobFor(p), target, resizeArtboard: null, reset: false, sentIds: again.objectIds }, deps);
    expect(r2.removed).toBe(water.length - 1);
    expect(r2.objectIds).not.toContain(deletedId); // no longer in the job: forgotten
  });

  it("a deleted object stays deleted on every later send; reset brings it back", () => {
    const p = project();
    const first = dm.sendMap([doc], { job: jobFor(p), target, resizeArtboard: null, reset: false }, deps);
    const victim = byName("Buildings").kids[0];
    const id = victim.tags.get("geo:fid");
    doc.remove(victim);
    let ids = first.objectIds;
    for (let i = 0; i < 3; i++) {
      const r = dm.sendMap([doc], { job: jobFor(p), target, resizeArtboard: null, reset: false, sentIds: ids }, deps);
      expect(r.created).toBe(0);
      expect(r.warnings.join(" ")).toMatch(/you deleted was not recreated/);
      ids = r.objectIds;
    }
    const r = dm.sendMap([doc], { job: jobFor(p), target, resizeArtboard: null, reset: true, sentIds: ids }, deps);
    expect(r.created).toBe(1);
    expect(objects().filter((n) => n.tags.get("geo:fid") === id)).toHaveLength(1);
  });

  it("redraws everything into a freshly made artboard, ignoring stale sentIds", () => {
    const p = project();
    const first = dm.sendMap([doc], { job: jobFor(p), target, resizeArtboard: null, reset: false }, deps);
    // the designer deleted the map artboard (or quit without saving)
    doc.remove(doc.layers.find((n) => n.kind === "artboard" && n.tags.has("geo:map")));
    expect(objects()).toHaveLength(0);
    const r = dm.sendMap([doc], { job: jobFor(p), target, resizeArtboard: null, reset: false, sentIds: first.objectIds }, deps);
    expect(r.created).toBe(first.created);
    expect(r.warnings.join(" ")).not.toMatch(/deleted/);
    expect(objects()).toHaveLength(first.created);
    expect(objects().some((n) => n.tags.get("geo:fid") === "marker:label")).toBe(true);
  });

  it("a group moved off its artboard is reused when the artboard is deleted: deleted objects stay deleted", () => {
    const p = project();
    const first = dm.sendMap([doc], { job: jobFor(p), target, resizeArtboard: null, reset: false }, deps);
    doc.remove(byName("Buildings").kids[0]); // the designer deleted one
    const group = byName("Map — Map 1");
    const mapAb = group.parent;
    const home = doc.layers[0]; // the designer moved the map group onto another artboard...
    doc.remove(group);
    home.kids.push(group);
    group.parent = home;
    doc.remove(mapAb); // ...then deleted the map's artboard
    const r = dm.sendMap([doc], { job: jobFor(p), target, resizeArtboard: null, reset: false, sentIds: first.objectIds }, deps);
    expect(r.created).toBe(0);
    expect(r.warnings.join(" ")).toMatch(/you deleted was not recreated/);
    expect(objects()).toHaveLength(first.created - 1);
  });

  it("redraws everything into a freshly made frame group, ignoring stale sentIds", () => {
    const p = project();
    const first = dm.sendMap([doc], { job: jobFor(p), target, resizeArtboard: null, reset: false }, deps);
    doc.remove(byName("Map — Map 1")); // the designer deleted the map group
    const r = dm.sendMap([doc], { job: jobFor(p), target, resizeArtboard: null, reset: false, sentIds: first.objectIds }, deps);
    expect(r.created).toBe(first.created);
    expect(r.warnings.join(" ")).not.toMatch(/deleted/);
    expect(objects()).toHaveLength(first.created);
  });

  it("never draws into a different document that only shares the target's title", () => {
    const other = makeDoc({ uuid: "B", title: "Untitled" });
    expect(() => dm.sendMap([other], { job: jobFor(project()), target: { docId: "A", docTitle: "Untitled" }, resizeArtboard: null, reset: false }, deps))
      .toThrow("Open 'Untitled' in Affinity to update Map 1");
    expect(other.allNodes()).toHaveLength(0);
    // a target with no docId can still be found by title
    const r = dm.sendMap([other], { job: jobFor(project()), target: { docId: "", docTitle: "Untitled" }, resizeArtboard: null, reset: false }, deps);
    expect(r.docId).toBe("B");
  });

  it("lists open documents, artboards and their maps", () => {
    dm.sendMap([doc], { job: jobFor(project()), target, resizeArtboard: null, reset: false }, deps);
    const t = dm.listTargets([doc]);
    expect(t.documents).toHaveLength(1);
    expect(t.documents[0]).toMatchObject({ docId: "doc-1", title: "Sign.af" });
    expect(t.documents[0].artboards[1]).toEqual({ name: "Map 1", mapIds: [{ projectId: "p1", mapId: "m1" }], widthMm: 420, heightMm: 297 });
    expect(t.documents[0].artboards[0].mapIds).toEqual([]);
  });

  it("selects map objects by role and feature id", () => {
    const job = jobFor(project());
    dm.sendMap([doc], { job, target, resizeArtboard: null, reset: false }, deps);
    const fids = job.layers.find((l) => l.role === "buildings").features.slice(0, 2).map((f) => f.fid);
    expect(dm.selectOnMap([doc], { projectId: "p1", mapId: "m1", role: "buildings", fids })).toEqual({ selected: 2 });
    expect(doc.selection).toHaveLength(2);
    expect(() => dm.selectOnMap([doc], { projectId: "p1", mapId: "nope", role: "buildings", fids })).toThrow(dm.NO_MAP);
  });
});

describe("failures, transformed groups, resizing about the centre", () => {
  const send = (job, extra = {}) => dm.sendMap([doc], { job, target, resizeArtboard: false, reset: false, ...extra }, deps);
  const PPM = 72 / 25.4;

  it("a failed update compound records no geo:sent it didn't apply", () => {
    const p = project();
    send(jobFor(p));
    const buildings = byName("Buildings").kids.slice();
    const sentBefore = buildings.map((b) => b.tags.get("geo:sent"));
    p.style.roles.buildings.fill = "#123456";
    fake.hooks.failCompound = (cmds) => cmds.some((c) => c.label === "fill");
    expect(() => send(jobFor(p))).toThrow("Fake: compound failed");
    expect(buildings.map((b) => b.tags.get("geo:sent"))).toEqual(sentBefore);
    expect(buildings.every((b) => b.fillHex !== "#123456")).toBe(true);
    // Nothing became a false "hand edit": the next send applies everything.
    fake.hooks.failCompound = null;
    const r = send(jobFor(p));
    expect(r.keptEdited).toEqual([]);
    expect(r.updated).toBe(buildings.length);
    for (const b of buildings) expect(b.fillHex).toBe("#123456");
  });

  it("a failed size change keeps the old frame rect tag and every geo:sent", () => {
    const p = project();
    send(jobFor(p));
    const group = byName("Map — Map 1");
    const rectBefore = group.tags.get("geo:mapframe");
    const objs = objects();
    const sentBefore = objs.map((o) => o.tags.get("geo:sent"));
    p.maps[0].sizeMm = { width: 300, height: 200 };
    fake.hooks.failCompound = (cmds) => cmds.some((c) => c.label === "curves");
    expect(() => send(jobFor(p))).toThrow("Fake: compound failed");
    expect(group.tags.get("geo:mapframe")).toBe(rectBefore);
    expect(objs.map((o) => o.tags.get("geo:sent"))).toEqual(sentBefore);
    fake.hooks.failCompound = null;
    expect(send(jobFor(p)).keptEdited).toEqual([]);
  });

  it("objects made before a later failure are still tagged, so they aren't drawn twice", () => {
    const job = jobFor(project());
    fake.hooks.failAdd = (defs, tgt) => tgt.tags.get("geo:role") === "buildings"; // the 2nd role
    expect(() => send(job)).toThrow("Fake: add failed");
    const water = byName("Water").kids;
    expect(water.length).toBeGreaterThan(0);
    for (const w of water) {
      expect(w.tags.get("geo:fid")).toMatch(/^water:/);
      expect(w.tags.has("geo:sent")).toBe(true);
    }
    fake.hooks.failAdd = null;
    const n = water.length;
    const r = send(job);
    expect(byName("Water").kids).toHaveLength(n);
    expect(r.created).toBe(job.layers.find((l) => l.role === "buildings").features.length + 3);
  });

  it("follows a moved and scaled map GROUP (a transform, not moved points) without false edits", () => {
    const p = project();
    send(jobFor(p));
    const group = byName("Map — Map 1");
    group.xf = new Transform(1.5, 100, 40); // the designer drags and scales the whole map
    const again = send(jobFor(p));
    expect(again).toMatchObject({ created: 0, updated: 0, removed: 0, keptEdited: [] });
    expect(again.warnings).toEqual([]);

    // New map size: geometry is rewritten through createSetCurves in base space — no double move.
    const outlineBefore = byName("Frame").spreadBaseBox;
    p.maps[0].sizeMm = { width: 400, height: 280 };
    const job2 = jobFor(p);
    const r = send(job2);
    expect(r.updated).toBeGreaterThan(0);
    const outline = byName("Frame").spreadBaseBox;
    expect(outline.width).toBeCloseTo(400 * PPM * 1.5, 1);
    // resizeArtboard false: about the frame's current centre
    expect(outline.x + outline.width / 2).toBeCloseTo(outlineBefore.x + outlineBefore.width / 2, 1);
    expect(outline.y + outline.height / 2).toBeCloseTo(outlineBefore.y + outlineBefore.height / 2, 1);
    const rect = JSON.parse(group.tags.get("geo:mapframe")).rect;
    const mapping = dm.frameMapping(rect, outline, PPM, plan);
    let checked = 0;
    for (const l of job2.layers) {
      for (const f of l.features) {
        const node = doc.allNodes().find((n) => n.tags.get("geo:fid") === `${l.role}:${f.fid}`);
        const want = mapping.toPage(f.paths)[0];
        const got = node.spreadCurve().curves[0].pts[0];
        expect(got[0]).toBeCloseTo(want[0], 1);
        expect(got[1]).toBeCloseTo(want[1], 1);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(3);
    expect(send(job2)).toMatchObject({ created: 0, updated: 0, removed: 0, keptEdited: [] });
  });

  it("without resizing the artboard, a new map size keeps a moved frame's centre", () => {
    const p = project();
    send(jobFor(p));
    byName("Map — Map 1").xf = new Transform(1, 250, 30);
    const before = byName("Frame").spreadBaseBox;
    p.maps[0].sizeMm = { width: 200, height: 150 };
    send(jobFor(p));
    const after = byName("Frame").spreadBaseBox;
    expect(after.width).toBeCloseTo(200 * PPM, 1);
    expect(after.x + after.width / 2).toBeCloseTo(before.x + before.width / 2, 1);
    expect(after.y + after.height / 2).toBeCloseTo(before.y + before.height / 2, 1);
  });

  it("resizedFrame: centre by default, top-left with a resized artboard, null when unchanged", () => {
    const B = { x: 100, y: 100, width: 200, height: 100 };
    const k = { sx: 2, sy: 2 };
    expect(dm.resizedFrame(B, k, 100, 50, false)).toBeNull();
    expect(dm.resizedFrame(B, k, 50, 25, false)).toEqual({ R: { x: 150, y: 125, width: 50, height: 25 }, B: { x: 150, y: 125, width: 100, height: 50 } });
    expect(dm.resizedFrame(B, k, 50, 25, true).B).toEqual({ x: 100, y: 100, width: 100, height: 50 });
  });
});

describe('the "You are here" label follows the map unless edited', () => {
  const send = (job, extra = {}) => dm.sendMap([doc], { job, target, resizeArtboard: false, reset: false, ...extra }, deps);
  const labelNode = () => objects().find((n) => n.tags.get("geo:fid") === "marker:label");
  const dotNode = () => objects().find((n) => n.tags.get("geo:fid") === "marker:dot");
  const sentOf = (n) => JSON.parse(n.tags.get("geo:sent"));
  const expectNextToDot = () => {
    const d = dotNode().spreadBaseBox;
    const l = labelNode().spreadBaseBox;
    const dcx = d.x + d.width / 2, dcy = d.y + d.height / 2;
    expect(l.x).toBeGreaterThan(d.x + d.width);
    expect(l.x).toBeLessThan(dcx + 40);
    expect(Math.abs(l.y + l.height / 2 - dcy)).toBeLessThan(10);
  };
  const markerKids = () => byName("You are here").kids.map((k) => k.tags.get("geo:fid"));

  it("records fill, size, text and position in the label's geo:sent", () => {
    send(jobFor(project()));
    const s = sentOf(labelNode());
    expect(s).toMatchObject({ fill: "#333333", textPt: 10, text: "You are here" });
    expect(s.pos).toHaveLength(2);
    expect(labelNode().text).toBe("You are here");
    expectNextToDot();
  });

  it("moves an unedited label to the new dot when the map size changes (artboard resized)", () => {
    const p = project();
    dm.sendMap([doc], { job: jobFor(p), target, resizeArtboard: true, reset: false }, deps);
    p.maps[0].sizeMm = { width: 297, height: 420 }; // A3 landscape → portrait
    const r = dm.sendMap([doc], { job: jobFor(p), target, resizeArtboard: true, reset: false }, deps);
    expect(r.keptEdited).toEqual([]);
    // (features entering or leaving the portrait frame may be created or removed: not the label)
    expect(r.objectIds).toContain("marker:label");
    expectNextToDot();
    expect(markerKids()).toEqual(["marker:ring", "marker:dot", "marker:label"]);
    expect(objects().filter((n) => n.tags.get("geo:fid") === "marker:label")).toHaveLength(1);
    expect(dm.sendMap([doc], { job: jobFor(p), target, resizeArtboard: true, reset: false }, deps))
      .toMatchObject({ created: 0, updated: 0, removed: 0, keptEdited: [] });
  });

  it("moves an unedited label to the new dot when the map is resized about its centre, and with a new centre", () => {
    const p = project();
    send(jobFor(p));
    byName("Map — Map 1").xf = new Transform(1, 30, 20); // a moved map group
    p.maps[0].sizeMm = { width: 200, height: 150 };
    const r = send(jobFor(p));
    expect(r.keptEdited).toEqual([]);
    expectNextToDot();
    p.maps[0].centre = [p.maps[0].centre[0] + 0.001, p.maps[0].centre[1]];
    send(jobFor(p));
    expectNextToDot();
    expect(send(jobFor(p))).toMatchObject({ created: 0, updated: 0, removed: 0, keptEdited: [] });
  });

  it("replaces an unedited label when the text size or the label text change", () => {
    const p = project();
    send(jobFor(p));
    p.style.marker.textPt = 14;
    const r = send(jobFor(p));
    expect(r).toMatchObject({ created: 0, updated: 1, removed: 0, keptEdited: [] });
    expect(sentOf(labelNode()).textPt).toBe(14);
    expect(labelNode().spreadBaseBox.height).toBeCloseTo(14, 6);
    expectNextToDot();
    p.style.marker.label = "Vous êtes ici";
    const r2 = send(jobFor(p));
    expect(r2).toMatchObject({ created: 0, updated: 1, removed: 0, keptEdited: [] });
    expect(labelNode().text).toBe("Vous êtes ici");
    expect(sentOf(labelNode()).text).toBe("Vous êtes ici");
    expect(markerKids()).toEqual(["marker:ring", "marker:dot", "marker:label"]);
    expect(send(jobFor(p))).toMatchObject({ created: 0, updated: 0, removed: 0, keptEdited: [] });
  });

  it("keeps a hand-moved or retyped label, reports it, and reset puts it back", () => {
    const p = project();
    send(jobFor(p));
    const label = labelNode();
    for (const c of label.pc.curves) c.pts = c.pts.map(([x, y]) => [x + 40, y + 25]); // the designer drags it
    const moved = { ...label.spreadBaseBox };
    const r = send(jobFor(p));
    expect(r.keptEdited).toEqual([{ fid: "label", role: "marker", name: "You are here", reason: "edited by hand" }]);
    p.maps[0].sizeMm = { width: 300, height: 400 };
    const r2 = send(jobFor(p));
    expect(r2.keptEdited).toEqual([expect.objectContaining({ role: "marker", reason: "edited by hand" })]);
    expect(labelNode()).toBe(label);
    expect(label.spreadBaseBox).toEqual(moved);
    const r3 = send(jobFor(p), { reset: true });
    expect(r3.keptEdited).toEqual([]);
    expectNextToDot();
    expect(send(jobFor(p))).toMatchObject({ created: 0, updated: 0, removed: 0, keptEdited: [] });

    labelNode().text = "Here!"; // retyped
    p.style.marker.textPt = 12;
    const r4 = send(jobFor(p));
    expect(r4.keptEdited).toEqual([{ fid: "label", role: "marker", name: "Here!", reason: "edited by hand" }]);
    expect(labelNode().text).toBe("Here!");
  });

  it("replaces a label made by an earlier version (fill only in geo:sent) if its colour is unchanged", () => {
    const p = project();
    send(jobFor(p));
    labelNode().tags.set("geo:sent", JSON.stringify({ fill: "#333333" }));
    const r = send(jobFor(p));
    expect(r).toMatchObject({ created: 0, updated: 1, removed: 0, keptEdited: [] });
    expect(sentOf(labelNode())).toMatchObject({ fill: "#333333", textPt: 10, text: "You are here" });
    expect(send(jobFor(p))).toMatchObject({ created: 0, updated: 0, removed: 0, keptEdited: [] });
  });

  it("removes the label with the marker unless edited; reset removes it anyway", () => {
    const p = project();
    send(jobFor(p));
    for (const c of labelNode().pc.curves) c.pts = c.pts.map(([x, y]) => [x + 40, y]);
    p.maps[0].marker = false;
    const r = send(jobFor(p));
    expect(labelNode()).toBeDefined();
    expect(r.keptEdited).toEqual([expect.objectContaining({ role: "marker", reason: "edited by hand" })]);
    send(jobFor(p), { reset: true });
    expect(labelNode()).toBeUndefined();
  });
});

describe('"You are here" label: formatting edits, unreadable fields, deletion, failures', () => {
  const send = (job, extra = {}) => dm.sendMap([doc], { job, target, resizeArtboard: false, reset: false, ...extra }, deps);
  const labels = () => objects().filter((n) => n.tags.get("geo:fid") === "marker:label");
  const labelNode = () => labels()[0];
  const resize = (p) => { p.maps[0].sizeMm = { width: 300, height: 400 }; };

  it("keeps a label whose font was changed by hand (e.g. made bold), through a size change", () => {
    const p = project();
    send(jobFor(p));
    const label = labelNode();
    label.font = { postscriptName: "Arial-BoldMT", familyName: "Arial", traitsName: "Bold" };
    resize(p);
    const r = send(jobFor(p));
    expect(r.keptEdited).toEqual([{ fid: "label", role: "marker", name: "You are here", reason: "edited by hand" }]);
    expect(labelNode()).toBe(label);
    expect(label.font.traitsName).toBe("Bold");
  });

  it("keeps a label whose text size was changed by hand", () => {
    const p = project();
    send(jobFor(p));
    const label = labelNode();
    label.textPx = 18;
    resize(p);
    expect(send(jobFor(p)).keptEdited).toEqual([expect.objectContaining({ role: "marker", reason: "edited by hand" })]);
    expect(labelNode()).toBe(label);
  });

  it("keeps a label with one character recoloured, or resized by its handles", () => {
    const p = project();
    send(jobFor(p));
    labelNode().charFills = { 11: "#ff0000" }; // the last letter
    resize(p);
    expect(send(jobFor(p)).keptEdited).toHaveLength(1);

    const p2 = project();
    doc = makeDoc({ dpi: 72 });
    doc.addArtboard({ x: 0, y: 0, width: 500, height: 500 });
    send(jobFor(p2));
    const label = labelNode();
    const b = label.spreadBaseBox; // scaled up about its top-left corner
    for (const c of label.pc.curves) c.pts = c.pts.map(([x, y]) => [b.x + (x - b.x) * 1.5, b.y + (y - b.y) * 1.5]);
    resize(p2);
    expect(send(jobFor(p2)).keptEdited).toHaveLength(1);
    expect(labelNode()).toBe(label);
  });

  it("an unreadable field is not an edit (and never makes the label edited for good)", () => {
    const p = project();
    send(jobFor(p));
    labelNode().unreadable = new Set(["font", "height", "box", "text", "fill"]);
    expect(send(jobFor(p))).toMatchObject({ created: 0, updated: 0, removed: 0, keptEdited: [] });
    resize(p);
    const r = send(jobFor(p));
    expect(r.keptEdited).toEqual([]);
    expect(labels()).toHaveLength(1);
    expect(labelNode().unreadable.size).toBe(0); // replaced by a fresh, readable one
    expect(send(jobFor(p))).toMatchObject({ created: 0, updated: 0, removed: 0, keptEdited: [] });
  });

  it("compares only the fields an older geo:sent has", () => {
    const p = project();
    send(jobFor(p));
    const s = JSON.parse(labelNode().tags.get("geo:sent"));
    labelNode().tags.set("geo:sent", JSON.stringify({ fill: s.fill, textPt: s.textPt, text: s.text, pos: s.pos, at: s.at }));
    labelNode().font = { postscriptName: "Arial-BoldMT", familyName: "Arial", traitsName: "Bold" }; // not recorded then
    expect(send(jobFor(p))).toMatchObject({ updated: 0, keptEdited: [] });
  });

  it("text is compared with line breaks and trailing spaces normalised", () => {
    const p = project();
    send(jobFor(p));
    labelNode().text = "You are here ";
    expect(send(jobFor(p))).toMatchObject({ updated: 0, keptEdited: [] });
    labelNode().text = "You are here  \r\n";
    expect(send(jobFor(p))).toMatchObject({ updated: 0, keptEdited: [] });
  });

  it("doesn't recreate a label the designer deleted; reset does", () => {
    const p = project();
    const first = send(jobFor(p));
    expect(first.objectIds).toContain("marker:label");
    doc.remove(labelNode());
    const r = send(jobFor(p), { sentIds: first.objectIds });
    expect(labels()).toHaveLength(0);
    expect(r.created).toBe(0);
    expect(r.warnings.join(" ")).toMatch(/You are here.*deleted was not recreated/);
    expect(r.objectIds).toContain("marker:label"); // still remembered as sent
    const r2 = send(jobFor(p), { sentIds: r.objectIds });
    expect(labels()).toHaveLength(0); // the deletion still holds on the next send
    expect(r2.created).toBe(0);
    expect(r2.objectIds).toContain("marker:label");
    send(jobFor(p), { sentIds: r2.objectIds, reset: true });
    expect(labels()).toHaveLength(1);
  });

  it("a failed compound during a replace leaves the one old label with its old geo:sent", () => {
    const p = project();
    send(jobFor(p));
    const old = labelNode();
    const sentBefore = old.tags.get("geo:sent");
    const textNodes = () => doc.allNodes().filter((n) => n.kind === "text");
    p.style.marker.textPt = 14;
    fake.hooks.failCompound = (cmds) => cmds.some((c) => c.label === "delete");
    expect(() => send(jobFor(p))).toThrow("Fake: compound failed");
    expect(labels()).toEqual([old]);
    expect(old.tags.get("geo:sent")).toBe(sentBefore);
    expect(textNodes()).toEqual([old]);
    fake.hooks.failCompound = null;
    expect(send(jobFor(p))).toMatchObject({ updated: 1, keptEdited: [] });
    expect(textNodes()).toHaveLength(1);
  });

  it("warns, and leaves the old label, when the new label can't be found after adding it", () => {
    const p = project();
    send(jobFor(p));
    const old = labelNode();
    p.style.marker.textPt = 14;
    fake.hooks.loseAdded = (defs) => defs.some((d) => d.kind === "text");
    const r = send(jobFor(p));
    fake.hooks.loseAdded = null;
    expect(r.warnings.join(" ")).toMatch(/label/i);
    expect(labels()).toEqual([old]);
    expect(doc.allNodes().filter((n) => n.kind === "text")).toEqual([old]); // the stray was found and deleted
  });
});

describe("the map background (paper)", () => {
  const send = (job, extra = {}) => dm.sendMap([doc], { job, target, resizeArtboard: false, reset: false, ...extra }, deps);
  const bg = () => objects().find((n) => n.tags.get("geo:fid") === "background:frame");
  const sentOf = (n) => JSON.parse(n.tags.get("geo:sent"));
  const near = (a, b) => {
    for (const k of ["x", "y", "width", "height"]) expect(a[k]).toBeCloseTo(b[k], 1);
  };

  it("draws one unstroked rectangle in the paper colour filling the frame, at the bottom just above the outline", () => {
    const p = project();
    send(jobFor(p));
    const group = byName("Map — Map 1");
    expect(group.kids[0].userDescription).toBe("Frame");
    const layer = group.kids[1];
    expect(layer.userDescription).toBe("Background");
    expect(layer.tags.get("geo:role")).toBe("background");
    expect(layer.kids).toEqual([bg()]);
    expect(bg().fillHex).toBe("#f4f1ea");
    expect(bg().penHex).toBeNull();
    expect(bg().weight).toBe(0);
    expect(bg().userDescription).toBe("Background");
    near(bg().spreadBaseBox, byName("Frame").spreadBaseBox);
    expect(sentOf(bg())).toMatchObject({ fill: "#f4f1ea", stroke: null, widthPt: 0, visible: true });
    expect(send(jobFor(p))).toMatchObject({ created: 0, updated: 0, removed: 0, keptEdited: [] });
  });

  it("a restyle (e.g. the Dark preset) recolours it", () => {
    const p = project();
    send(jobFor(p));
    p.style.paper = "#1d2a33";
    const r = send(jobFor(p));
    expect(r).toMatchObject({ created: 0, updated: 1, removed: 0, keptEdited: [] });
    expect(bg().fillHex).toBe("#1d2a33");
    expect(send(jobFor(p))).toMatchObject({ created: 0, updated: 0, removed: 0, keptEdited: [] });
  });

  it("keeps a hand recolour and reports it; reset restores the paper", () => {
    const p = project();
    send(jobFor(p));
    bg().fillHex = "#ff0000"; // the designer's edit
    p.style.paper = "#1d2a33";
    const r = send(jobFor(p));
    expect(bg().fillHex).toBe("#ff0000");
    expect(r.keptEdited).toEqual([{ fid: "frame", role: "background", name: "Background", reason: "edited by hand" }]);
    send(jobFor(p), { reset: true });
    expect(bg().fillHex).toBe("#1d2a33");
    expect(send(jobFor(p))).toMatchObject({ created: 0, updated: 0, removed: 0, keptEdited: [] });
  });

  it("follows a frame resize (about the centre, or with the artboard), unless reshaped by hand", () => {
    const p = project();
    send(jobFor(p));
    byName("Map — Map 1").xf = new Transform(1.5, 40, 10); // a moved and scaled map group
    p.maps[0].sizeMm = { width: 200, height: 150 };
    const r = send(jobFor(p));
    expect(r.keptEdited).toEqual([]);
    near(bg().spreadBaseBox, byName("Frame").spreadBaseBox);
    expect(send(jobFor(p))).toMatchObject({ created: 0, updated: 0, removed: 0, keptEdited: [] });

    const doc2 = makeDoc({ uuid: "doc-2" });
    doc = doc2;
    doc.addArtboard({ x: 0, y: 0, width: 500, height: 500 });
    const t2 = { docId: "doc-2", docTitle: "Sign.af" };
    dm.sendMap([doc], { job: jobFor(p), target: t2, resizeArtboard: true, reset: false }, deps);
    p.maps[0].sizeMm = { width: 297, height: 420 };
    dm.sendMap([doc], { job: jobFor(p), target: t2, resizeArtboard: true, reset: false }, deps);
    near(bg().spreadBaseBox, byName("Frame").spreadBaseBox);

    // reshaped by hand: kept and reported, even through another size change
    for (const c of bg().pc.curves) c.pts = c.pts.map(([x, y]) => [x, y * 0.5]);
    const shaped = { ...bg().spreadBaseBox };
    p.maps[0].sizeMm = { width: 250, height: 300 };
    const r2 = dm.sendMap([doc], { job: jobFor(p), target: t2, resizeArtboard: true, reset: false }, deps);
    expect(r2.keptEdited).toEqual([expect.objectContaining({ role: "background", reason: "reshaped" })]);
    near(bg().spreadBaseBox, shaped);
    dm.sendMap([doc], { job: jobFor(p), target: t2, resizeArtboard: true, reset: true }, deps);
    near(bg().spreadBaseBox, byName("Frame").spreadBaseBox);
  });

  it("a map sent before the background existed gets it on the next send, directly above the outline", () => {
    const p = project();
    const { background: _bg, ...old } = jobFor(p);
    const first = send(old);
    expect(bg()).toBeUndefined();
    const r = send(jobFor(p), { sentIds: first.objectIds });
    expect(r).toMatchObject({ created: 1, updated: 0, removed: 0, keptEdited: [] });
    expect(byName("Map — Map 1").kids.map((k) => k.userDescription)).toEqual(["Frame", "Background", "Water", "Buildings", "You are here"]);
    expect(r.objectIds).toContain("background:frame");
  });

  it("a deleted background stays deleted; reset brings it back", () => {
    const p = project();
    const first = send(jobFor(p));
    doc.remove(bg());
    const r = send(jobFor(p), { sentIds: first.objectIds });
    expect(r.created).toBe(0);
    expect(bg()).toBeUndefined();
    send(jobFor(p), { sentIds: r.objectIds, reset: true });
    expect(bg().fillHex).toBe("#f4f1ea");
  });

  it("puts a deleted outline back below the background", () => {
    const p = project();
    send(jobFor(p));
    doc.remove(byName("Frame"));
    send(jobFor(p));
    expect(byName("Map — Map 1").kids.slice(0, 2).map((k) => k.userDescription)).toEqual(["Frame", "Background"]);
  });
});

describe("linkArtboard", () => {
  const link = (over = {}) => dm.linkArtboard([doc], { projectId: "p1", mapId: "m1", docId: "doc-1", artboardIndex: 0, artboardName: "Artboard", otherMapNames: {}, ...over });
  const artboards = () => doc.layers.filter((n) => n.kind === "artboard");

  it("tags the chosen artboard and the next sendMap draws into it without making a new one", () => {
    expect(link()).toEqual({ ok: true, docId: "doc-1", docTitle: "Sign.af" });
    expect(JSON.parse(artboards()[0].tags.get("geo:map"))).toEqual({ projectId: "p1", mapId: "m1" });
    const r = dm.sendMap([doc], { job: jobFor(project()), target, resizeArtboard: false, reset: false }, deps);
    expect(artboards()).toHaveLength(1);
    expect(artboards()[0].kids[0].userDescription).toBe("Map — Map 1");
    expect(r.created).toBeGreaterThan(0);
  });

  it("moves the tag off the map's previous artboard", () => {
    dm.sendMap([doc], { job: jobFor(project()), target, resizeArtboard: null, reset: false }, deps);
    expect(artboards()).toHaveLength(2);
    link();
    expect(artboards()[0].tags.get("geo:map")).toBeTruthy();
    expect(artboards()[1].tags.get("geo:map") || "").toBe("");
    expect(dm.listTargets([doc]).documents[0].artboards.map((a) => a.mapIds.length)).toEqual([1, 0]);
  });

  it("refuses an artboard of another map of the same project, naming it", () => {
    artboards()[0].tags.set("geo:map", JSON.stringify({ projectId: "p1", mapId: "m2" }));
    expect(() => link({ otherMapNames: { m2: "Library map" } })).toThrow("That artboard already holds 'Library map'.");
    expect(() => link({ otherMapNames: { m2: "" } })).toThrow("That artboard already holds 'm2'.");
    expect(JSON.parse(artboards()[0].tags.get("geo:map")).mapId).toBe("m2");
  });

  it("re-links an artboard tagged for a map no longer in the project", () => {
    artboards()[0].tags.set("geo:map", JSON.stringify({ projectId: "p1", mapId: "gone" }));
    link({ otherMapNames: { m2: "Other" } });
    expect(JSON.parse(artboards()[0].tags.get("geo:map"))).toEqual({ projectId: "p1", mapId: "m1" });
  });

  it("re-linking unlinks the old frame group and the next send draws on the new artboard", () => {
    doc.addArtboard({ x: 600, y: 0, width: 500, height: 500 });
    const send = () => dm.sendMap([doc], { job: jobFor(project()), target, resizeArtboard: false, reset: false }, deps);
    link();
    send();
    const [A, B] = artboards();
    const oldGroup = A.kids[0];
    const aObjects = oldGroup.kids.flatMap((k) => k.kids).length;
    expect(aObjects).toBeGreaterThan(0);
    const aSnapshot = JSON.stringify(oldGroup.kids.map((k) => k.kids.map((o) => [o.tags.get("geo:fid"), o.tags.get("geo:sent")])));
    link({ artboardIndex: 1, artboardName: "Artboard" });
    expect(A.tags.get("geo:map") || "").toBe("");
    expect(oldGroup.userDescription).toBe("Map — Map 1 (unlinked)");
    expect(oldGroup.tags.get("geo:mapframe") || "").toBe("");
    const r = send();
    expect(B.kids).toHaveLength(1);
    expect(B.kids[0].userDescription).toBe("Map — Map 1");
    expect(r.created).toBeGreaterThan(0);
    expect(r.warnings.join(" ")).not.toMatch(/deleted/);
    expect(A.kids).toHaveLength(1);
    expect(JSON.stringify(A.kids[0].kids.map((k) => k.kids.map((o) => [o.tags.get("geo:fid"), o.tags.get("geo:sent")])))).toBe(aSnapshot);
    // a third send changes nothing on A (or B)
    const r3 = send();
    expect(r3).toMatchObject({ created: 0, updated: 0, removed: 0 });
    expect(JSON.stringify(A.kids[0].kids.map((k) => k.kids.map((o) => [o.tags.get("geo:fid"), o.tags.get("geo:sent")])))).toBe(aSnapshot);
  });

  it("re-links an artboard tagged by a different project", () => {
    artboards()[0].tags.set("geo:map", JSON.stringify({ projectId: "other", mapId: "m2" }));
    link();
    expect(JSON.parse(artboards()[0].tags.get("geo:map"))).toEqual({ projectId: "p1", mapId: "m1" });
  });

  it("fails when the name at that index differs, or the document or index is gone", () => {
    expect(() => link({ artboardName: "Something else" })).toThrow("The artboards changed in Affinity. Pick the artboard again.");
    expect(() => link({ artboardIndex: 5 })).toThrow("The artboards changed in Affinity. Pick the artboard again.");
    expect(() => link({ docId: "nope" })).toThrow(/Open the document in Affinity/);
    expect(artboards()[0].tags.has("geo:map")).toBe(false);
  });
});
