import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const requireCjs = createRequire(import.meta.url);
const { planSend, geomSignature, geomSame, propsFromStyle } = requireCjs("../src/send-plan.js");

const feat = (fid, x = 0) => ({ fid, name: `F ${fid}`, paths: [[x, 0, x + 10, 10]], closed: false });
const layer = (role, features, fill = "#00FF00") => ({
  role, name: role, kind: "line",
  style: { fill, stroke: "#111111", strokePt: 0.5, visible: true, order: 1, pointRadiusPt: 1 },
  features,
});
const mk = (features, fill) => ({ layers: [layer("paths", features, fill)] });
const propsOf = (f, fill = "#00ff00") => ({ fill, stroke: "#111111", widthPt: 0.5, visible: true, geom: geomSignature(f.paths, "line") });
const node = (role, f, current, sent, nodeId) => ({ id: `${role}:${f.fid}`, role, fid: f.fid, nodeId: nodeId || `n-${f.fid}`, current, sent });
const opts = (o) => Object.assign({ reset: false, sentIds: [] }, o);

describe("geomSignature", () => {
  it("counts points and rounds the bbox to 0.1 mm", () => {
    expect(geomSignature([[0, 0, 10.04, 5.06], [1, 1]], "line")).toBe("3:0,0,10,5.1");
    expect(geomSignature([], "line")).toBe("0:0,0,0,0");
  });
});

describe("geomSignature kinds and tolerance", () => {
  it("signs a point by its centre", () => {
    expect(geomSignature([[5.04, 7.26]], "point")).toBe("p:5,7.3");
  });
  it("does not count a repeated closing point", () => {
    const ring = [[0, 0, 10, 0, 10, 10, 0, 10, 0, 0]];
    expect(geomSignature(ring, "polygon")).toBe("4:0,0,10,10");
  });
  it("counts every node of an open line", () => {
    expect(geomSignature([[0, 0, 10, 0, 10, 10, 0, 10]], "line")).toBe("4:0,0,10,10");
  });
  it("compares within 0.15 mm with exact counts", () => {
    expect(geomSame("3:10.05,0,5,5", "3:10,0,5,5")).toBe(true);
    expect(geomSame("3:10.3,0,5,5", "3:10,0,5,5")).toBe(false);
    expect(geomSame("4:10,0,5,5", "3:10,0,5,5")).toBe(false);
    expect(geomSame("p:1,1", "1:1,1,0,0")).toBe(false);
  });
  it("treats float-noise geometry as unchanged", () => {
    const f = feat("A");
    const cur = Object.assign(propsOf(f), { geom: "2:0.05,0,10,10" });
    const plan = planSend([node("paths", f, cur, propsOf(f))], mk([f]), opts());
    expect(plan.update).toEqual([]);
    expect(plan.keptEdited).toEqual([]);
  });
});

describe("planSend", () => {
  const A = feat("A"), B = feat("B", 20);
  const old = (f) => propsOf(f, "#00ff00");
  const edited = (f) => Object.assign(propsOf(f, "#00ff00"), { fill: "#ff0000" });

  it("keeps a hand-edited fill and changes the others", () => {
    const existing = [node("paths", A, edited(A), old(A)), node("paths", B, old(B), old(B))];
    const plan = planSend(existing, mk([A, B], "#0000FF"), opts());
    const ua = plan.update.find((u) => u.nodeId === "n-A");
    const ub = plan.update.find((u) => u.nodeId === "n-B");
    expect(ub.set.fill).toBe("#0000ff");
    expect(ua === undefined || !("fill" in ua.set)).toBe(true);
    expect(plan.keptEdited).toEqual([{ nodeId: "n-A", fid: "A", reason: "edited by hand" }]);
  });

  it("overwrites the hand edit on reset", () => {
    const existing = [node("paths", A, edited(A), old(A))];
    const plan = planSend(existing, mk([A], "#0000FF"), opts({ reset: true }));
    expect(plan.update[0].set.fill).toBe("#0000ff");
    expect(plan.update[0].sent.fill).toBe("#0000ff");
  });

  it("removes unedited objects that left the map and keeps edited ones", () => {
    const existing = [node("paths", A, old(A), old(A)), node("paths", B, edited(B), old(B))];
    const plan = planSend(existing, mk([]), opts());
    expect(plan.remove).toEqual(["n-A"]);
    expect(plan.keptEdited).toEqual([{ nodeId: "n-B", fid: "B", reason: "outside the map" }]);
  });

  it("does not push geometry over a reshaped object but still recolours it", () => {
    const A2 = feat("A", 3);
    const reshaped = Object.assign(old(A), { geom: "9:0,0,1,1" });
    const plan = planSend([node("paths", A, reshaped, old(A))], mk([A2], "#0000FF"), opts());
    expect(plan.keptEdited).toEqual([{ nodeId: "n-A", fid: "A", reason: "reshaped" }]);
    expect(plan.update[0].geometry).toBeUndefined();
    expect(plan.update[0].set.fill).toBe("#0000ff");
    expect(plan.update[0].sent.geom).toBe(old(A).geom);
  });

  it("pushes new geometry when untouched", () => {
    const A2 = feat("A", 3);
    const plan = planSend([node("paths", A, old(A), old(A))], mk([A2]), opts());
    expect(plan.update[0].geometry).toBe(A2);
    expect(plan.update[0].sent.geom).toBe(geomSignature(A2.paths, "line"));
  });

  it("does not recreate deleted objects unless reset", () => {
    const plan = planSend([], mk([A]), opts({ sentIds: ["paths:A"] }));
    expect(plan.create).toEqual([]);
    expect(plan.warnings).toEqual(["1 object you deleted was not recreated"]);
    const r = planSend([], mk([A]), opts({ sentIds: ["paths:A"], reset: true }));
    expect(r.create).toHaveLength(1);
    expect(r.create[0].props).toEqual(old(A));
    expect(r.warnings).toEqual([]);
  });

  it("creates brand-new features", () => {
    const plan = planSend([], mk([A, B]), opts());
    expect(plan.create.map((c) => c.feature.fid)).toEqual(["A", "B"]);
    expect(plan.create[0].role).toBe("paths");
  });

  it("leaves Ctrl+J duplicates alone", () => {
    const orig = node("paths", A, old(A), old(A), "orig");
    const dup = node("paths", A, Object.assign(old(A), { geom: "2:50,50,1,1" }), old(A), "dup");
    const plan = planSend([dup, orig], mk([A]), opts());
    expect(plan.update).toEqual([]);
    expect(plan.remove).toEqual([]);
  });

  it("takes the first node as original when no geometry matches", () => {
    const g = { geom: "2:50,50,1,1" };
    const n1 = node("paths", A, Object.assign(old(A), g), old(A), "one");
    const n2 = node("paths", A, Object.assign(old(A), g), old(A), "two");
    const plan = planSend([n1, n2], mk([A], "#0000FF"), opts());
    expect(plan.update.map((u) => u.nodeId)).toEqual(["one"]);
  });

  it("treats sent === null as sent === current", () => {
    const plan = planSend([node("paths", A, old(A), null)], mk([A], "#0000FF"), opts());
    expect(plan.update[0].set.fill).toBe("#0000ff");
  });

  it("compares colours case-insensitively and widths with tolerance", () => {
    const cur = Object.assign(old(A), { fill: "#00FF00", widthPt: 0.504 });
    const plan = planSend([node("paths", A, cur, old(A))], mk([A]), opts());
    expect(plan.update).toEqual([]);
  });

  it("treats a role change as remove plus create", () => {
    const n = node("water", A, old(A), old(A));
    const plan = planSend([n], mk([A]), opts());
    expect(plan.remove).toEqual(["n-A"]);
    expect(plan.create).toHaveLength(1);
  });

  it("propsFromStyle uses stroke width and visibility", () => {
    expect(propsFromStyle(layer("paths", []).style, A, "line")).toEqual(propsOf(A, "#00FF00".toLowerCase()));
  });
});
