import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const requireCjs = createRequire(import.meta.url);
const dm = requireCjs("../src/draw-map.js");
const sendPlan = requireCjs("../src/send-plan.js");
const plan = requireCjs("../src/plan.js");

const DPI = 72;
const PPM = DPI / 25.4;
const style = (o = {}) => ({ fill: "#AABBCC", stroke: "#112233", strokePt: 0.5, visible: true, order: 4, pointRadiusPt: 0, ...o });
const job = (layers, marker = null) => ({
  mapId: "m1", mapName: "Map 1", projectId: "p1", sizeMm: { width: 100, height: 50 }, layers, marker, hash: "h",
});

describe("normaliseJob", () => {
  it("makes the sent props match what Affinity can read back", () => {
    const j = job([
      { role: "paths", name: "Paths and footways", kind: "line", style: style({ fill: "#FF0000" }), features: [{ fid: "a", name: "A", paths: [[0, 0, 10, 10]], closed: false }] },
      { role: "water", name: "Water", kind: "polygon", style: style({ stroke: null, strokePt: 0.75 }), features: [{ fid: "w", name: "W", paths: [[0, 0, 10, 0, 10, 10]], closed: true }] },
      { role: "rail", name: "Rail", kind: "line", style: style({ fill: null, stroke: "#123456", strokePt: 0 }), features: [{ fid: "r", name: "R", paths: [[0, 0, 5, 5]], closed: false }] },
    ]);
    const { job: n } = dm.normaliseJob(j, plan);
    expect(n.layers[0].style.fill).toBeNull(); // lines are drawn without a fill
    expect(n.layers[0].style.stroke).toBe("#112233");
    expect(n.layers[1].style).toMatchObject({ stroke: null, strokePt: 0, fill: "#aabbcc" });
    expect(n.layers[2].style).toMatchObject({ stroke: null, strokePt: 0 }); // zero-width stroke = no stroke
    expect(j.layers[0].style.fill).toBe("#FF0000"); // input untouched
  });

  it("drops paths and features that can't be drawn, and counts them", () => {
    const j = job([{ role: "water", name: "Water", kind: "polygon", style: style(), features: [
      { fid: "ok", name: "", paths: [[0, 0, 10, 0, 10, 10], [1, 1]], closed: true },
      { fid: "bad", name: "", paths: [[0, 0, 1, 1]], closed: true },
    ] }]);
    const { job: n, skipped } = dm.normaliseJob(j, plan);
    expect(n.layers[0].features.map((f) => f.fid)).toEqual(["ok"]);
    expect(n.layers[0].features[0].paths).toEqual([[0, 0, 10, 0, 10, 10]]);
    expect(skipped).toBe(1);
  });

  it("orders layers by style.order and adds the marker dot and ring on top", () => {
    const j = job([
      { role: "paths", name: "Paths", kind: "line", style: style({ order: 9 }), features: [{ fid: "a", name: "", paths: [[0, 0, 1, 1]], closed: false }] },
      { role: "water", name: "Water", kind: "polygon", style: style({ order: 2 }), features: [{ fid: "w", name: "", paths: [[0, 0, 1, 0, 1, 1]], closed: true }] },
    ], { x: 50, y: 25, style: { dot: "#E4572E", ring: "#FFFFFF", text: "#333333", textPt: 10, label: "You are here" } });
    const { job: n } = dm.normaliseJob(j, plan);
    expect(n.layers.map((l) => l.role)).toEqual(["water", "paths", "marker", "marker"]);
    const [ring, dot] = n.layers.slice(2);
    expect(ring.features[0]).toMatchObject({ fid: "ring", paths: [[50, 25]] });
    expect(ring.style).toMatchObject({ fill: "#ffffff", stroke: null, strokePt: 0 });
    expect(dot.features[0]).toMatchObject({ fid: "dot", paths: [[50, 25]] });
    expect(dot.style.fill).toBe("#e4572e");
    expect(dot.style.pointRadiusPt).toBeLessThan(ring.style.pointRadiusPt);
  });

  it("turns the background into one unstroked frame rectangle below every layer", () => {
    const j = { ...job([
      { role: "water", name: "Water", kind: "polygon", style: style({ order: 0 }), features: [{ fid: "w", name: "", paths: [[0, 0, 1, 0, 1, 1]], closed: true }] },
    ]), sizeMm: { width: 420, height: 297 }, background: { fill: "#1D2A33" } };
    const { job: n } = dm.normaliseJob(j, plan);
    expect(n.layers.map((l) => l.role)).toEqual(["background", "water"]);
    expect(n.layers[0]).toEqual({
      role: "background", name: "Background", kind: "polygon",
      style: { fill: "#1d2a33", stroke: null, strokePt: 0, visible: true, order: -1, pointRadiusPt: 0 },
      features: [{ fid: "frame", name: "Background", paths: [[0, 0, 420, 0, 420, 297, 0, 297]], closed: true }],
    });
    expect(dm.normaliseJob({ ...j, background: undefined }, plan).job.layers.map((l) => l.role)).toEqual(["water"]);
  });

  it("keeps the background below a layer with a negative order", () => {
    const j = { ...job([
      { role: "water", name: "Water", kind: "polygon", style: style({ order: -5 }), features: [{ fid: "w", name: "", paths: [[0, 0, 1, 0, 1, 1]], closed: true }] },
    ]), background: { fill: "#ffffff" } };
    expect(dm.normaliseJob(j, plan).job.layers.map((l) => l.role)).toEqual(["background", "water"]);
  });
});

describe("small readers", () => {
  it("formats colours as lowercase #rrggbb, transparent as none", () => {
    expect(dm.colourHex({ r: 255, g: 10, b: 0, alpha: 255 })).toBe("#ff0a00");
    expect(dm.colourHex({ r: 1, g: 2, b: 3, alpha: 0 })).toBeNull();
  });

  it("matches a geo:map / geo:mapframe tag to a map", () => {
    expect(dm.sameMap('{"projectId":"p1","mapId":"m1"}', "p1", "m1")).toBe(true);
    expect(dm.sameMap('{"projectId":"p1","mapId":"m2"}', "p1", "m1")).toBe(false);
    expect(dm.sameMap("garbage", "p1", "m1")).toBe(false);
    expect(dm.sameMap(null, "p1", "m1")).toBe(false);
  });

  it("splits a geo:fid tag into role and feature id", () => {
    expect(dm.splitId("paths:way/12:3")).toEqual({ role: "paths", fid: "way/12:3" });
    expect(dm.splitId("nocolon")).toBeNull();
  });

  it("puts a new artboard 100 px to the right of the others", () => {
    expect(dm.nextArtboardX([])).toBe(0);
    expect(dm.nextArtboardX([{ x: 0, y: 0, width: 500, height: 10 }, { x: 600, y: 0, width: 200, height: 10 }])).toBe(900);
  });

  it("centres the map frame on an artboard of another size", () => {
    expect(dm.placeFrame({ x: 1000, y: 0, width: 400, height: 300 }, 200, 100)).toEqual({ x: 1100, y: 100, width: 200, height: 100 });
    expect(dm.placeFrame({ x: 10, y: 20, width: 200, height: 100 }, 200, 100)).toEqual({ x: 10, y: 20, width: 200, height: 100 });
  });
});

describe("read-back geometry matches the sent signature (the key contract)", () => {
  const R = { x: 1000, y: 200, width: 100 * PPM, height: 50 * PPM };

  // Fakes what Affinity hands back: the drawn curve's nodes in spread px, closed curves
  // possibly repeating the first node at the end (the closing segment).
  function readBack(paths, kind, mapping, closed, repeatClosing) {
    const page = mapping.toPage(paths);
    if (kind === "point") {
      const r = 3;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of page) { minX = Math.min(minX, p[0] - r); maxX = Math.max(maxX, p[0] + r); minY = Math.min(minY, p[1] - r); maxY = Math.max(maxY, p[1] + r); }
      return dm.signatureFromRead({ kind, curves: [], bbox: { x: minX, y: minY, width: maxX - minX, height: maxY - minY } }, mapping, sendPlan.geomSignature);
    }
    const curves = page.map((p) => {
      const nodes = [];
      for (let i = 0; i + 1 < p.length; i += 2) nodes.push([p[i], p[i + 1]]);
      if (closed && repeatClosing) nodes.push(nodes[0].slice());
      return { closed, nodes };
    });
    return dm.signatureFromRead({ kind, curves, bbox: null }, mapping, sendPlan.geomSignature);
  }

  const cases = [
    ["polygon", [[10.2, 5.3, 40.7, 5.3, 40.7, 30.1, 10.2, 30.1]], true],
    ["line", [[0, 0, 12.34, 7.8, 99.9, 49.9]], false],
    ["line", [[0, 0, 20, 0, 20, 20, 0, 0]], false], // a loop drawn as a line
    ["point", [[50, 25]], false],
    ["point", [[10, 10], [30, 20]], false],
  ];

  for (const box of [R, { x: 1500, y: 300, width: R.width * 1.5, height: R.height * 1.5 }]) {
    const mapping = dm.frameMapping(R, box, PPM, plan);
    for (const [kind, paths, closed] of cases) {
      for (const repeat of closed ? [false, true] : [false]) {
        it(`${kind} ${JSON.stringify(paths).slice(0, 30)} box×${(box.width / R.width).toFixed(1)}${repeat ? " (closing node)" : ""}`, () => {
          const sent = sendPlan.geomSignature(paths, kind);
          const got = readBack(paths, kind, mapping, closed, repeat);
          expect(sendPlan.geomSame(got, sent)).toBe(true);
        });
      }
    }
  }

  it("maps frame-local mm to spread px and back", () => {
    const m = dm.frameMapping(R, R, PPM, plan);
    expect(m.toPage([[0, 0, 100, 50]])).toEqual([[1000, 200, Math.round((1000 + 100 * PPM) * 100) / 100, Math.round((200 + 50 * PPM) * 100) / 100]]);
    const [x, y] = m.toMm(1000 + 10 * PPM, 200 + 5 * PPM);
    expect(x).toBeCloseTo(10, 6);
    expect(y).toBeCloseTo(5, 6);
  });
});

describe("messages", () => {
  it("says which document to open, in plain words", () => {
    expect(dm.notOpenMessage("Signs.af", "Map 2")).toBe("Open 'Signs.af' in Affinity to update Map 2");
    expect(dm.OUTLINE_BACK).toBe("The map's frame outline was missing, so AffinityGeo put it back.");
  });
});
