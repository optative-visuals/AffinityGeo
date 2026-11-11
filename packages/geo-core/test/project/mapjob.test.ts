import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import proj4 from "proj4";
import { readDataset } from "../../src/read/index.js";
import { crsFromEpsg } from "../../src/crs.js";
import { boxRing } from "../../src/project/location.js";
import { loadProject, newProject } from "../../src/project/file.js";
import { parseOverpass } from "../../src/project/osm.js";
import { fnv, stable, styleHash } from "../../src/project/styles.js";
import { writeZip } from "../../src/project/zip.js";
import { bleedFraction, buildMapJob, isLegacyMap, mapStatusHash } from "../../src/project/mapjob.js";
import type { Dataset, Geometry } from "../../src/types.js";
import type { MapSpec, Project, ProjectData, ProjectSnapshot } from "../../src/project/types.js";

const fx = (p: string) => fileURLToPath(new URL("../fixtures/" + p, import.meta.url));
const BNG = crsFromEpsg(27700);
const toLonLat = (e: number, n: number) => proj4(BNG.proj4, "+proj=longlat +datum=WGS84 +no_defs", [e, n]) as [number, number];

const mkDs = (kind: Dataset["kind"], geometry: Geometry, name = "X"): Dataset => ({
  name, sourcePath: "x", sourceFormat: "geojson", crs: BNG, kind,
  features: [{ fid: "f", name: "F", geometry, attrs: {} }], report: { read: 1, skipped: 0, reasons: [] },
});

const T_LOC = { name: "T", placeName: "T", kind: "box" as const, ring: boxRing([-1, 51, 0, 52]), contextM: 0 };
function mkProject(centreEN: [number, number], over: Partial<MapSpec> = {}): Project {
  const p = newProject("T", { placeName: "T", bboxWgs84: [-1, 51, 0, 52], projectionId: "bng" }, "Light", T_LOC);
  p.maps.push({
    id: "m1", name: "Map 1", centre: toLonLat(...centreEN), scale: 2500, rotationDeg: 0,
    sizeMm: { width: 420, height: 297 }, marker: false, target: null, resizeArtboard: null, sent: null, locationId: "loc-1", showContext: false, ...over,
  });
  return p;
}
const snapOf = (d: ProjectData): ProjectSnapshot => ({ locations: { "loc-1": d }, files: {} });
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
    const job = buildMapJob(mkProject(C, { scale: 5000 }), snapOf({ buildings: bng3 }), "m1", { bleed: false });
    inFrame(coords(job));
    expect(job.layers[0]!.name).toBe("Buildings");
  });

  it("clips a square straddling the left edge", () => {
    // frame: 420 mm at 1:2500 = 1050 m wide, left edge at E 499475.
    const sq = mkDs("polygon", { type: "Polygon", coordinates: [[[499300, 199950], [499700, 199950], [499700, 200050], [499300, 200050], [499300, 199950]]] });
    const job = buildMapJob(mkProject([500000, 200000]), snapOf({ buildings: sq }), "m1", { bleed: false });
    const xs = job.layers[0]!.features[0]!.paths[0]!.filter((_, i) => i % 2 === 0);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.min(...xs)).toBeCloseTo(0, 1);
    expect(Math.max(...xs)).toBeCloseTo((499700 - 499475) * 0.4, 1);
  });

  it("measures 100 m as 40 mm at 1:2500", () => {
    const ln = mkDs("line", { type: "LineString", coordinates: [[499950, 200000], [500050, 200000]] });
    const p = buildMapJob(mkProject([500000, 200000]), snapOf({ minorRoads: ln }), "m1").layers[0]!.features[0]!.paths[0]!;
    expect(p[2]! - p[0]!).toBeCloseTo(40, 2);
  });

  it("splits a line that leaves and re-enters the frame", () => {
    const ln = mkDs("line", { type: "LineString", coordinates: [[500000, 200000], [500000, 201000], [500100, 201000], [500100, 200000]] });
    const f = buildMapJob(mkProject([500000, 200000]), snapOf({ minorRoads: ln }), "m1").layers[0]!.features[0]!;
    expect(f.paths.length).toBe(2);
  });

  it("drops points outside the frame", () => {
    const pts = mkDs("point", { type: "MultiPoint", coordinates: [[500000, 200000], [510000, 200000]] });
    const f = buildMapJob(mkProject([500000, 200000]), snapOf({ poi: pts }), "m1").layers[0]!.features[0]!;
    expect(f.paths).toEqual([[210, 148.5]]);
  });

  it("keeps everything inside the frame at -30 degrees, centre fixed", () => {
    inFrame(coords(buildMapJob(mkProject(C, { scale: 5000, rotationDeg: -30 }), snapOf({ buildings: bng3 }), "m1", { bleed: false })));
    const pt = mkDs("point", { type: "Point", coordinates: [500000, 200000] });
    const [x, y] = buildMapJob(mkProject([500000, 200000], { rotationDeg: -30 }), snapOf({ poi: pt }), "m1").layers[0]!.features[0]!.paths[0]!;
    expect(x).toBeCloseTo(210, 2); expect(y).toBeCloseTo(148.5, 2);
  });

  it("rotation 90 puts a feature 100 m east of centre directly above it", () => {
    const pt = mkDs("point", { type: "Point", coordinates: [500100, 200000] });
    const [x, y] = buildMapJob(mkProject([500000, 200000], { rotationDeg: 90 }), snapOf({ poi: pt }), "m1").layers[0]!.features[0]!.paths[0]!;
    expect(Math.abs(x! - 210)).toBeLessThan(0.01);
    expect(y!).toBeLessThan(148.5);
    expect(148.5 - y!).toBeCloseTo(40, 1);
  });

  it("omits invisible and empty roles, in role order, with the project's style", () => {
    const p = mkProject(C, { scale: 5000 });
    const far = mkDs("polygon", { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] });
    p.style.roles.water.visible = false;
    const job = buildMapJob(p, snapOf({ buildings: bng3, water: bng3, green: far }), "m1");
    expect(job.layers.map((l) => l.role)).toEqual(["buildings"]);
    expect(job.layers[0]!.style).toEqual(p.style.roles.buildings);
  });

  it("orders layers bottom to top", () => {
    const data: ProjectData = { buildings: bng3, green: bng3, water: bng3 };
    const job = buildMapJob(mkProject(C, { scale: 5000 }), snapOf(data), "m1");
    expect(job.layers.map((l) => l.role)).toEqual(["green", "water", "buildings"]);
  });

  it("draws whatever dataset the role holds (a user file replaces OSM)", () => {
    const small = mkDs("polygon", { type: "Polygon", coordinates: [[[499990, 199990], [500010, 199990], [500010, 200010], [499990, 200010], [499990, 199990]]] }, "OSM");
    const big = mkDs("polygon", { type: "Polygon", coordinates: [[[499900, 199900], [500100, 199900], [500100, 200100], [499900, 200100], [499900, 199900]]] }, "Mine");
    const p = mkProject([500000, 200000]);
    const a = buildMapJob(p, snapOf({ buildings: small }), "m1").layers[0]!.features[0]!.paths[0]!;
    const b = buildMapJob(p, snapOf({ buildings: big }), "m1").layers[0]!.features[0]!.paths[0]!;
    expect(Math.max(...b) - Math.min(...b)).toBeGreaterThan(Math.max(...a) - Math.min(...a));
    expect(buildMapJob(p, snapOf({}), "m1").layers).toEqual([]);
  });

  it("places the marker at the frame centre only when asked", () => {
    const p = mkProject(C, { marker: true });
    expect(buildMapJob(p, snapOf({}), "m1").marker).toEqual({ x: 210, y: 148.5, style: p.style.marker });
    p.maps[0]!.marker = false;
    expect(buildMapJob(p, snapOf({}), "m1").marker).toBeNull();
  });

  it("carries the style's paper as the map background, and its hash reacts to it", () => {
    const p = mkProject(C);
    expect(buildMapJob(p, snapOf({}), "m1").background).toEqual({ fill: "#f4f1ea" });
    const h0 = mapStatusHash(p, "m1");
    p.style.paper = "#1d2a33";
    expect(buildMapJob(p, snapOf({}), "m1").background).toEqual({ fill: "#1d2a33" });
    expect(mapStatusHash(p, "m1")).not.toBe(h0);
  });

  it("hash reacts to style and dataVersion, not to sent or target", () => {
    const p = mkProject(C, { scale: 5000 });
    const h0 = buildMapJob(p, snapOf({}), "m1").hash;
    expect(mapStatusHash(p, "m1")).toBe(h0);
    p.maps[0]!.sent = { at: "now", hash: "x", objectIds: [] };
    p.maps[0]!.target = { docId: "d", docTitle: "t" };
    expect(mapStatusHash(p, "m1")).toBe(h0);
    p.style.roles.water.fill = "#000000";
    const h1 = mapStatusHash(p, "m1");
    expect(h1).not.toBe(h0);
    p.locations[0]!.dataVersion++;
    expect(mapStatusHash(p, "m1")).not.toBe(h1);
  });

  it("throws a plain message for an unknown map", () => {
    expect(() => buildMapJob(mkProject(C, { scale: 5000 }), snapOf({}), "nope")).toThrow(/map/i);
  });

  it("refuses a non-metric projection with the too-big message", () => {
    const p = mkProject(C);
    p.area.projectionId = "laea" as never;
    expect(() => buildMapJob(p, snapOf({}), "m1")).toThrow("That area is too big for a street-level map. Choose a smaller area.");
  });

  it("hash changes with scale, rotation or centre", () => {
    const base = mapStatusHash(mkProject(C), "m1");
    expect(mapStatusHash(mkProject(C, { scale: 5000 }), "m1")).not.toBe(base);
    expect(mapStatusHash(mkProject(C, { rotationDeg: 10 }), "m1")).not.toBe(base);
    expect(mapStatusHash(mkProject([C[0] + 50, C[1]]), "m1")).not.toBe(base);
  });
});

describe("bleedFraction", () => {
  it("is 0.20 up to 1:500 and 0.05 from 1:25,000, log-interpolated between", () => {
    expect(bleedFraction(500)).toBeCloseTo(0.2, 10);
    expect(bleedFraction(100)).toBeCloseTo(0.2, 10);
    expect(bleedFraction(25000)).toBeCloseTo(0.05, 10);
    expect(bleedFraction(100000)).toBeCloseTo(0.05, 10);
    expect(Math.abs(bleedFraction(2500) - 0.138)).toBeLessThan(0.001);
    expect(Math.abs(bleedFraction(1000) - 0.174)).toBeLessThan(0.001);
    expect(Math.abs(bleedFraction(10000) - 0.0851)).toBeLessThan(0.001); // the formula gives 0.0851 (the brief rounded it to 0.088)
  });

  it("decreases monotonically: detailed maps get the most margin", () => {
    const scales = [100, 500, 750, 1000, 2500, 5000, 10000, 20000, 25000, 50000];
    for (let i = 1; i < scales.length; i++) expect(bleedFraction(scales[i]!)).toBeLessThanOrEqual(bleedFraction(scales[i - 1]!));
    expect(bleedFraction(1000)).toBeGreaterThan(bleedFraction(10000));
  });
});

describe("bleed margin in map jobs", () => {
  // frame: 420 x 297 mm at 1:2500 = 1050 x 742.5 m, left edge at E 499475, top edge at N 200371.25.
  const f = bleedFraction(2500);

  it("computes bleedMm per axis from the frame's own size, and omits it without bleed", () => {
    const p = mkProject([500000, 200000]);
    const job = buildMapJob(p, snapOf({}), "m1");
    expect(job.bleedMm!.x).toBeCloseTo(f * 420, 2);
    expect(job.bleedMm!.y).toBeCloseTo(f * 297, 2);
    expect(job.sizeMm).toEqual({ width: 420, height: 297 });
    expect(buildMapJob(p, snapOf({}), "m1", { bleed: false }).bleedMm).toBeUndefined();
    expect(buildMapJob(p, snapOf({}), "m1", { bleed: false })).not.toHaveProperty("bleedMm");
  });

  it("keeps a feature just outside the frame but inside the margin, in frame mm", () => {
    const pt = mkDs("point", { type: "Point", coordinates: [499400, 200000] }); // 75 m left of the frame
    const p = mkProject([500000, 200000]);
    const [x, y] = buildMapJob(p, snapOf({ poi: pt }), "m1").layers[0]!.features[0]!.paths[0]!;
    expect(x).toBeCloseTo(-30, 2); // 75 m at 1:2500
    expect(y).toBeCloseTo(148.5, 2);
    expect(buildMapJob(p, snapOf({ poi: pt }), "m1", { bleed: false }).layers).toEqual([]);
  });

  it("clips a feature beyond the margin at the margin, on both axes", () => {
    const sq = mkDs("polygon", { type: "Polygon", coordinates: [[[499000, 199000], [501000, 199000], [501000, 201000], [499000, 201000], [499000, 199000]]] });
    const job = buildMapJob(mkProject([500000, 200000]), snapOf({ buildings: sq }), "m1");
    const ring = job.layers[0]!.features[0]!.paths[0]!;
    const xs = ring.filter((_, i) => i % 2 === 0), ys = ring.filter((_, i) => i % 2 === 1);
    const bx = job.bleedMm!.x, by = job.bleedMm!.y;
    expect(Math.min(...xs)).toBeCloseTo(-bx, 1);
    expect(Math.max(...xs)).toBeCloseTo(420 + bx, 1);
    expect(Math.min(...ys)).toBeCloseTo(-by, 1);
    expect(Math.max(...ys)).toBeCloseTo(297 + by, 1);
  });

  it("gives the context layers the margin too, but not the marker or the mask", () => {
    const p = mkProject([500000, 200000], { marker: true, showContext: true });
    p.locations[0]!.contextM = 100;
    const pt = mkDs("point", { type: "Point", coordinates: [499400, 200000] });
    const job = buildMapJob(p, snapOf({ poi: pt }), "m1");
    expect(job.context!.layers[0]!.features[0]!.paths[0]![0]).toBeCloseTo(-30, 2);
    expect(job.marker).toMatchObject({ x: 210, y: 148.5 });
    // The mask is trimmed to the drawn area, so with the margin it is the bleed box, not the frame.
    const bx = job.bleedMm!.x, by = job.bleedMm!.y;
    expect(new Set(job.mask!.ring.map(([x, y]) => `${x},${y}`))).toEqual(
      new Set([`${-bx},${-by}`, `${420 + bx},${-by}`, `${420 + bx},${297 + by}`, `${-bx},${297 + by}`]));
  });

  it("leaves the hash alone", () => {
    const p = mkProject([500000, 200000]);
    expect(buildMapJob(p, snapOf({}), "m1").hash).toBe(buildMapJob(p, snapOf({}), "m1", { bleed: false }).hash);
  });
});

describe("locations in map jobs", () => {
  const parkland = JSON.parse(readFileSync(new URL("./fixtures/osm-parkland.json", import.meta.url), "utf8"));
  const HYDE: [number, number, number, number] = [-0.2, 51.47, -0.12, 51.53];
  const SHAPE: [number, number][] = [[-0.175, 51.5], [-0.16, 51.5], [-0.16, 51.51], [-0.17, 51.512]];
  const shapeProject = (over: Partial<MapSpec> = {}, contextM = 0): Project => {
    const p = mkProject(C, { centre: [-0.1665, 51.505], scale: 5000, ...over });
    p.locations[0] = { ...p.locations[0]!, kind: "shape", ring: SHAPE, contextM };
    p.area.projectionId = "bng";
    return p;
  };
  const parkSnap = (): ProjectSnapshot => snapOf(parseOverpass(parkland));

  it("legacy hash and job are unchanged for a migrated v1 project", async () => {
    // The 0.1.0 formula, copied here so this test owns the old code.
    const oldHash = (p: { maps: MapSpec[]; style: Project["style"]; dataVersion: number; sources: unknown; area: unknown }) => {
      const { sent: _s, target: _t, ...spec } = p.maps[0]!;
      return fnv(stable({ map: spec, style: styleHash(p.style), dataVersion: p.dataVersion, sources: p.sources, area: p.area }));
    };
    // Golden job generated by the real 0.1.x buildMapJob (commit 70a0ec0) from this same v1 project and fixture.
    const goldenText = readFileSync(new URL("./fixtures/legacy-mapjob.json", import.meta.url), "utf8");
    const golden = JSON.parse(goldenText) as { projectId: string };
    const base = newProject("Old", { placeName: "Hyde Park", bboxWgs84: HYDE, projectionId: "bng" }, "Light",
      { name: "Hyde Park", placeName: "Hyde Park", kind: "box", ring: boxRing(HYDE), contextM: 0 });
    const { locations: _loc, ...rest } = base;
    const { locationId: _i, showContext: _s, ...v1Map } = {
      id: "m1", name: "Map 1", centre: [-0.1665, 51.505], scale: 5000, rotationDeg: -30, sizeMm: { width: 297, height: 210 },
      marker: true, target: null, resizeArtboard: null, sent: null, locationId: "x", showContext: false,
    };
    const v1 = { ...rest, id: golden.projectId, version: 1, maps: [v1Map], dataVersion: 7, fetchedAt: "2026-10-28T10:00:00Z" };
    const data = parseOverpass(parkland);
    const entries = [{ name: "project.json", data: new TextEncoder().encode(JSON.stringify(v1)) }];
    for (const [role, ds] of Object.entries(data)) entries.push({ name: `data/${role}.json`, data: new TextEncoder().encode(JSON.stringify(ds)) });
    const path = join(mkdtempSync(join(tmpdir(), "afgeo-")), "v1.afgeo");
    writeFileSync(path, writeZip(entries));

    const { project, snap } = await loadProject(path);
    expect(mapStatusHash(project, "m1")).toBe(oldHash(v1 as never));
    const job = buildMapJob(project, snap, "m1", { bleed: false });
    expect(job.hash).toBe(oldHash(v1 as never));
    expect(JSON.stringify(job)).toBe(goldenText);
    expect(Object.keys(job)).toEqual(["mapId", "mapName", "projectId", "sizeMm", "background", "layers", "marker", "hash"]);
    expect(JSON.stringify(job)).not.toMatch(/"mask"|"context"/);
    expect(job.layers.length).toBeGreaterThan(0);
  });

  it("a shape location job has a mask ring in mm matching the frame transform", () => {
    const p = shapeProject();
    const job = buildMapJob(p, parkSnap(), "m1");
    expect(job.mask!.ring).toHaveLength(SHAPE.length);
    const LL = "+proj=longlat +datum=WGS84 +no_defs";
    const [cx, cy] = proj4(LL, BNG.proj4, p.maps[0]!.centre) as [number, number];
    const k = 1000 / 5000;
    SHAPE.forEach((pt, i) => {
      const [x, y] = proj4(LL, BNG.proj4, pt) as [number, number];
      const [mx, my] = job.mask!.ring[i]!;
      expect(mx).toBe(Math.round((x - (cx - 1050)) * k * 100) / 100); // 420 mm at 1:5000 is 2100 m wide
      expect(my).toBe(Math.round((cy + 742.5 - y) * k * 100) / 100);  // 297 mm is 1485 m tall
    });
  });

  // The untrimmed location ring in frame mm, computed independently of buildMapJob (no rotation).
  const rawRing = (p: Project): [number, number][] => {
    const LL = "+proj=longlat +datum=WGS84 +no_defs";
    const m = p.maps[0]!;
    const [cx, cy] = proj4(LL, BNG.proj4, m.centre) as [number, number];
    const k = 1000 / m.scale;
    const hw = (m.sizeMm.width / 1000) * m.scale / 2, hh = (m.sizeMm.height / 1000) * m.scale / 2;
    return p.locations[0]!.ring.map((pt) => {
      const [x, y] = proj4(LL, BNG.proj4, pt) as [number, number];
      return [(x - (cx - hw)) * k, (cy + hh - y) * k];
    });
  };
  const onSegment = ([x, y]: number[], [ax, ay]: number[], [bx, by]: number[]) => {
    const len = Math.hypot(bx! - ax!, by! - ay!);
    const dist = Math.abs((bx! - ax!) * (ay! - y!) - (ax! - x!) * (by! - ay!)) / len;
    const t = ((x! - ax!) * (bx! - ax!) + (y! - ay!) * (by! - ay!)) / (len * len);
    return dist <= 0.01 && t >= -1e-6 && t <= 1 + 1e-6;
  };
  // A shape edge (lon -0.16, from lat 51.5 to 51.51) runs through a frame centred on it.
  const edgeProject = (over: Partial<MapSpec> = {}) => shapeProject({ centre: [-0.1601, 51.505], scale: 500, ...over });

  it("a location much bigger than the frame gets the drawn-area rectangle as its mask", () => {
    const p = shapeProject({ scale: 5000 });
    p.locations[0]!.ring = [[-0.3, 51.4], [-0.05, 51.4], [-0.05, 51.6], [-0.3, 51.6]];
    const job = buildMapJob(p, parkSnap(), "m1");
    const bx = job.bleedMm!.x, by = job.bleedMm!.y;
    expect(job.mask!.ring).toHaveLength(4);
    expect(new Set(job.mask!.ring.map(([x, y]) => `${x},${y}`))).toEqual(
      new Set([`${-bx},${-by}`, `${420 + bx},${-by}`, `${420 + bx},${297 + by}`, `${-bx},${297 + by}`]));
  });

  it("a location edge crossing the frame: the mask stays inside the drawn area and keeps the edge", () => {
    const p = edgeProject();
    const job = buildMapJob(p, parkSnap(), "m1");
    const bx = job.bleedMm!.x, by = job.bleedMm!.y;
    const raw = rawRing(p);
    const ring = job.mask!.ring;
    const eps = 0.011;
    for (const [x, y] of ring) {
      expect(x).toBeGreaterThanOrEqual(-bx - eps); expect(x).toBeLessThanOrEqual(420 + bx + eps);
      expect(y).toBeGreaterThanOrEqual(-by - eps); expect(y).toBeLessThanOrEqual(297 + by + eps);
    }
    const onEdge = (pt: number[]) => raw.some((a, i) => onSegment(pt, a, raw[(i + 1) % raw.length]!));
    const onBox = ([x, y]: number[]) => [x! + bx, 420 + bx - x!, y! + by, 297 + by - y!].some((d) => Math.abs(d) <= eps);
    for (const pt of ring) expect(onEdge(pt) || onBox(pt)).toBe(true);
    expect(ring.filter(onEdge).length).toBeGreaterThanOrEqual(2);
    expect(ring.some(([x]) => x! < 420 / 2)).toBe(true); // the location side survives
    expect(ring.some(([x]) => x! > 420 + bx)).toBe(false); // the far side is cut away
    expect(ring.at(-1)).not.toEqual(ring[0]);
  });

  it("without bleed the mask is trimmed to the frame box", () => {
    const job = buildMapJob(edgeProject(), parkSnap(), "m1", { bleed: false });
    for (const [x, y] of job.mask!.ring) {
      expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThanOrEqual(420);
      expect(y).toBeGreaterThanOrEqual(0); expect(y).toBeLessThanOrEqual(297);
    }
    expect(job.mask!.ring.some(([x]) => x === 0)).toBe(true);
  });

  it("a frame entirely outside its location has no mask", () => {
    const p = shapeProject({ centre: [0.5, 51.505], scale: 500 });
    const job = buildMapJob(p, parkSnap(), "m1");
    expect("mask" in job).toBe(false);
  });

  it("the mask follows rotation and is still trimmed", () => {
    const p = shapeProject({ rotationDeg: 90, scale: 500 });
    const job = buildMapJob(p, parkSnap(), "m1");
    const bx = job.bleedMm!.x, by = job.bleedMm!.y;
    for (const [x, y] of job.mask!.ring) {
      expect(x).toBeGreaterThanOrEqual(-bx - 0.011); expect(x).toBeLessThanOrEqual(420 + bx + 0.011);
      expect(y).toBeGreaterThanOrEqual(-by - 0.011); expect(y).toBeLessThanOrEqual(297 + by + 0.011);
    }
  });

  it("context only when showContext", () => {
    const p = shapeProject({}, 200);
    const snap = parkSnap();
    const off = buildMapJob(p, snap, "m1");
    expect(off.mask).toBeDefined();
    expect(off.context).toBeUndefined();
    p.maps[0]!.showContext = true;
    const on = buildMapJob(p, snap, "m1");
    expect(on.context!.opacity).toBe(0.5);
    expect(on.context!.layers).toEqual(on.layers);
    expect(on.context!.layers.length).toBeGreaterThan(0);
  });

  it("hash changes when contextM or the ring changes (non-legacy)", () => {
    const h0 = mapStatusHash(shapeProject(), "m1");
    expect(mapStatusHash(shapeProject({}, 100), "m1")).not.toBe(h0);
    const p = shapeProject();
    p.locations[0]!.ring = [...SHAPE.slice(0, 3), [-0.172, 51.511]];
    expect(mapStatusHash(p, "m1")).not.toBe(h0);
    expect(mapStatusHash(shapeProject({ showContext: true }), "m1")).not.toBe(h0);
  });

  it("a box with context is not legacy and gets a mask", () => {
    const p = mkProject(C);
    p.locations[0]!.contextM = 100;
    expect(isLegacyMap(p, p.maps[0]!)).toBe(false);
    expect(buildMapJob(p, snapOf({}), "m1").mask).toBeDefined();
  });
});
