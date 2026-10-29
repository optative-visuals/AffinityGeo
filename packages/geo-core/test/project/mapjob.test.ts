import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import proj4 from "proj4";
import { readDataset } from "../../src/read/index.js";
import { crsFromEpsg } from "../../src/crs.js";
import { newProject } from "../../src/project/file.js";
import { buildMapJob, mapStatusHash } from "../../src/project/mapjob.js";
import type { Dataset, Geometry } from "../../src/types.js";
import type { MapSpec, Project, ProjectData } from "../../src/project/types.js";

const fx = (p: string) => fileURLToPath(new URL("../fixtures/" + p, import.meta.url));
const BNG = crsFromEpsg(27700);
const toLonLat = (e: number, n: number) => proj4(BNG.proj4, "+proj=longlat +datum=WGS84 +no_defs", [e, n]) as [number, number];

const mkDs = (kind: Dataset["kind"], geometry: Geometry, name = "X"): Dataset => ({
  name, sourcePath: "x", sourceFormat: "geojson", crs: BNG, kind,
  features: [{ fid: "f", name: "F", geometry, attrs: {} }], report: { read: 1, skipped: 0, reasons: [] },
});

function mkProject(centreEN: [number, number], over: Partial<MapSpec> = {}): Project {
  const p = newProject("T", { placeName: "T", bboxWgs84: [-1, 51, 0, 52], projectionId: "bng" }, "Light");
  p.maps.push({
    id: "m1", name: "Map 1", centre: toLonLat(...centreEN), scale: 2500, rotationDeg: 0,
    sizeMm: { width: 420, height: 297 }, marker: false, target: null, resizeArtboard: null, sent: null, ...over,
  });
  return p;
}
const coords = (job: ReturnType<typeof buildMapJob>) =>
  job.layers.flatMap((l) => l.features.flatMap((f) => f.paths.flat()));
const inFrame = (cs: number[]) => {
  expect(cs.length).toBeGreaterThan(0);
  for (let i = 0; i < cs.length; i += 2) {
    expect(cs[i]!).toBeGreaterThanOrEqual(0); expect(cs[i]!).toBeLessThanOrEqual(420);
    expect(cs[i + 1]!).toBeGreaterThanOrEqual(0); expect(cs[i + 1]!).toBeLessThanOrEqual(297);
  }
};

let bng3: Dataset;
let C: [number, number];
beforeAll(async () => {
  bng3 = (await readDataset(fx("bng3/bng3.shp")))[0]!;
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  const walk = (x: unknown): void => {
    if (Array.isArray(x) && typeof x[0] === "number") { a = Math.min(a, x[0]); c = Math.max(c, x[0]); b = Math.min(b, x[1] as number); d = Math.max(d, x[1] as number); }
    else if (Array.isArray(x)) x.forEach(walk);
  };
  bng3.features.forEach((f) => walk((f.geometry as { coordinates: unknown }).coordinates));
  C = [(a + c) / 2, (b + d) / 2];
});

describe("buildMapJob", () => {
  it("keeps every coordinate inside the frame", () => {
    const job = buildMapJob(mkProject(C, { scale: 5000 }), { buildings: bng3 }, "m1");
    inFrame(coords(job));
    expect(job.layers[0]!.name).toBe("Buildings");
  });

  it("clips a square straddling the left edge", () => {
    // frame: 420 mm at 1:2500 = 1050 m wide, left edge at E 499475.
    const sq = mkDs("polygon", { type: "Polygon", coordinates: [[[499300, 199950], [499700, 199950], [499700, 200050], [499300, 200050], [499300, 199950]]] });
    const job = buildMapJob(mkProject([500000, 200000]), { buildings: sq }, "m1");
    const xs = job.layers[0]!.features[0]!.paths[0]!.filter((_, i) => i % 2 === 0);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.min(...xs)).toBeCloseTo(0, 1);
    expect(Math.max(...xs)).toBeCloseTo((499700 - 499475) * 0.4, 1);
  });

  it("measures 100 m as 40 mm at 1:2500", () => {
    const ln = mkDs("line", { type: "LineString", coordinates: [[499950, 200000], [500050, 200000]] });
    const p = buildMapJob(mkProject([500000, 200000]), { minorRoads: ln }, "m1").layers[0]!.features[0]!.paths[0]!;
    expect(p[2]! - p[0]!).toBeCloseTo(40, 2);
  });

  it("splits a line that leaves and re-enters the frame", () => {
    const ln = mkDs("line", { type: "LineString", coordinates: [[500000, 200000], [500000, 201000], [500100, 201000], [500100, 200000]] });
    const f = buildMapJob(mkProject([500000, 200000]), { minorRoads: ln }, "m1").layers[0]!.features[0]!;
    expect(f.paths.length).toBe(2);
  });

  it("drops points outside the frame", () => {
    const pts = mkDs("point", { type: "MultiPoint", coordinates: [[500000, 200000], [510000, 200000]] });
    const f = buildMapJob(mkProject([500000, 200000]), { poi: pts }, "m1").layers[0]!.features[0]!;
    expect(f.paths).toEqual([[210, 148.5]]);
  });

  it("keeps everything inside the frame at -30 degrees, centre fixed", () => {
    inFrame(coords(buildMapJob(mkProject(C, { scale: 5000, rotationDeg: -30 }), { buildings: bng3 }, "m1")));
    const pt = mkDs("point", { type: "Point", coordinates: [500000, 200000] });
    const [x, y] = buildMapJob(mkProject([500000, 200000], { rotationDeg: -30 }), { poi: pt }, "m1").layers[0]!.features[0]!.paths[0]!;
    expect(x).toBeCloseTo(210, 2); expect(y).toBeCloseTo(148.5, 2);
  });

  it("rotation 90 puts a feature 100 m east of centre directly above it", () => {
    const pt = mkDs("point", { type: "Point", coordinates: [500100, 200000] });
    const [x, y] = buildMapJob(mkProject([500000, 200000], { rotationDeg: 90 }), { poi: pt }, "m1").layers[0]!.features[0]!.paths[0]!;
    expect(Math.abs(x! - 210)).toBeLessThan(0.01);
    expect(y!).toBeLessThan(148.5);
    expect(148.5 - y!).toBeCloseTo(40, 1);
  });

  it("omits invisible and empty roles, in role order, with the project's style", () => {
    const p = mkProject(C, { scale: 5000 });
    const far = mkDs("polygon", { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] });
    p.style.roles.water.visible = false;
    const job = buildMapJob(p, { buildings: bng3, water: bng3, green: far }, "m1");
    expect(job.layers.map((l) => l.role)).toEqual(["buildings"]);
    expect(job.layers[0]!.style).toEqual(p.style.roles.buildings);
  });

  it("orders layers bottom to top", () => {
    const data: ProjectData = { buildings: bng3, green: bng3, water: bng3 };
    const job = buildMapJob(mkProject(C, { scale: 5000 }), data, "m1");
    expect(job.layers.map((l) => l.role)).toEqual(["green", "water", "buildings"]);
  });

  it("draws whatever dataset the role holds (a user file replaces OSM)", () => {
    const small = mkDs("polygon", { type: "Polygon", coordinates: [[[499990, 199990], [500010, 199990], [500010, 200010], [499990, 200010], [499990, 199990]]] }, "OSM");
    const big = mkDs("polygon", { type: "Polygon", coordinates: [[[499900, 199900], [500100, 199900], [500100, 200100], [499900, 200100], [499900, 199900]]] }, "Mine");
    const p = mkProject([500000, 200000]);
    const a = buildMapJob(p, { buildings: small }, "m1").layers[0]!.features[0]!.paths[0]!;
    const b = buildMapJob(p, { buildings: big }, "m1").layers[0]!.features[0]!.paths[0]!;
    expect(Math.max(...b) - Math.min(...b)).toBeGreaterThan(Math.max(...a) - Math.min(...a));
    expect(buildMapJob(p, {}, "m1").layers).toEqual([]);
  });

  it("places the marker at the frame centre only when asked", () => {
    const p = mkProject(C, { marker: true });
    expect(buildMapJob(p, {}, "m1").marker).toEqual({ x: 210, y: 148.5, style: p.style.marker });
    p.maps[0]!.marker = false;
    expect(buildMapJob(p, {}, "m1").marker).toBeNull();
  });

  it("carries the style's paper as the map background, and its hash reacts to it", () => {
    const p = mkProject(C);
    expect(buildMapJob(p, {}, "m1").background).toEqual({ fill: "#f4f1ea" });
    const h0 = mapStatusHash(p, "m1");
    p.style.paper = "#1d2a33";
    expect(buildMapJob(p, {}, "m1").background).toEqual({ fill: "#1d2a33" });
    expect(mapStatusHash(p, "m1")).not.toBe(h0);
  });

  it("hash reacts to style and dataVersion, not to sent or target", () => {
    const p = mkProject(C, { scale: 5000 });
    const h0 = buildMapJob(p, {}, "m1").hash;
    expect(mapStatusHash(p, "m1")).toBe(h0);
    p.maps[0]!.sent = { at: "now", hash: "x", objectIds: [] };
    p.maps[0]!.target = { docId: "d", docTitle: "t" };
    expect(mapStatusHash(p, "m1")).toBe(h0);
    p.style.roles.water.fill = "#000000";
    const h1 = mapStatusHash(p, "m1");
    expect(h1).not.toBe(h0);
    p.dataVersion++;
    expect(mapStatusHash(p, "m1")).not.toBe(h1);
  });

  it("throws a plain message for an unknown map", () => {
    expect(() => buildMapJob(mkProject(C, { scale: 5000 }), {}, "nope")).toThrow(/map/i);
  });

  it("refuses a non-metric projection with the too-big message", () => {
    const p = mkProject(C);
    p.area.projectionId = "laea" as never;
    expect(() => buildMapJob(p, {}, "m1")).toThrow("That area is too big for a street-level map. Choose a smaller area.");
  });

  it("hash changes with scale, rotation or centre", () => {
    const base = mapStatusHash(mkProject(C), "m1");
    expect(mapStatusHash(mkProject(C, { scale: 5000 }), "m1")).not.toBe(base);
    expect(mapStatusHash(mkProject(C, { rotationDeg: 10 }), "m1")).not.toBe(base);
    expect(mapStatusHash(mkProject([C[0] + 50, C[1]]), "m1")).not.toBe(base);
  });
});
