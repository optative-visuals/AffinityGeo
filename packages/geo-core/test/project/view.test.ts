import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import proj4 from "proj4";
import { crsFromEpsg } from "../../src/crs.js";
import { newProject } from "../../src/project/file.js";
import { buildMapJob } from "../../src/project/mapjob.js";
import {
  SCALE_MAX, SCALE_MIN, areaKm2, mapFrameCorners, projector, scaleToSlider, sliderToScale,
} from "../../src/project/view.js";
import type { Dataset } from "../../src/types.js";
import type { AreaSpec, MapSpec } from "../../src/project/types.js";

const BNG = crsFromEpsg(27700);
const toLonLat = (e: number, n: number) => proj4(BNG.proj4, "+proj=longlat +datum=WGS84 +no_defs", [e, n]) as [number, number];
const area: AreaSpec = { placeName: "T", bboxWgs84: [-1, 51, 0, 52], projectionId: "bng" };
const mk = (over: Partial<MapSpec> = {}) => ({
  centre: toLonLat(500000, 200000), scale: 2500, rotationDeg: 0, sizeMm: { width: 420, height: 297 }, ...over,
});

describe("mapFrameCorners", () => {
  it("north-up A3 at 1:2,500 is 1050 m x 742.5 m centred on the projected centre", () => {
    const [tl, tr, br, bl] = mapFrameCorners(area, mk());
    expect(tl![0]).toBeCloseTo(499475, 2); expect(tl![1]).toBeCloseTo(200371.25, 2);
    expect(tr![0]).toBeCloseTo(500525, 2); expect(tr![1]).toBeCloseTo(200371.25, 2);
    expect(br![0]).toBeCloseTo(500525, 2); expect(br![1]).toBeCloseTo(199628.75, 2);
    expect(bl![0]).toBeCloseTo(499475, 2); expect(bl![1]).toBeCloseTo(199628.75, 2);
  });
  it("rotation -30 puts the top edge's bearing at -30 degrees", () => {
    const [tl, tr] = mapFrameCorners(area, mk({ rotationDeg: -30 }));
    const ang = (Math.atan2(tr![1] - tl![1], tr![0] - tl![0]) * 180) / Math.PI;
    expect(ang).toBeCloseTo(30, 6);
  });
  it("the corners agree with buildMapJob", () => {
    const rotationDeg = -30;
    const p = newProject("T", { placeName: "T", bboxWgs84: [-1, 51, 0, 52], projectionId: "bng" }, "Light");
    p.maps.push({ id: "m1", name: "M", ...mk({ rotationDeg }), marker: false, target: null, resizeArtboard: null, sent: null });
    const [tl, tr, br] = mapFrameCorners(area, mk({ rotationDeg }));
    // A point 1 m inside the top-left corner, along the frame's own axes, as a one-point dataset.
    const u = [(tr![0] - tl![0]) / 1050, (tr![1] - tl![1]) / 1050];
    const v = [(br![0] - tr![0]) / 742.5, (br![1] - tr![1]) / 742.5];
    const pt: [number, number] = [tl![0] + u[0]! + v[0]!, tl![1] + u[1]! + v[1]!];
    const ds: Dataset = {
      name: "X", sourcePath: "x", sourceFormat: "geojson", crs: BNG, kind: "point",
      features: [{ fid: "f", name: "F", geometry: { type: "Point", coordinates: pt }, attrs: {} }],
      report: { read: 1, skipped: 0, reasons: [] },
    };
    const job = buildMapJob(p, { poi: ds }, "m1");
    const xy = job.layers[0]!.features[0]!.paths.flat();
    expect(xy[0]!).toBeCloseTo(0.4, 2); expect(xy[1]!).toBeCloseTo(0.4, 2);
  });
});

describe("projector", () => {
  it("round-trips Hyde Park within 1e-7 degrees", () => {
    const pr = projector(area);
    const ll: [number, number] = [-0.1618, 51.5114];
    const back = pr.inverse(pr.forward(ll));
    expect(Math.abs(back[0] - ll[0])).toBeLessThan(1e-7);
    expect(Math.abs(back[1] - ll[1])).toBeLessThan(1e-7);
  });
  it("refuses d3 projections", () => {
    expect(() => projector({ ...area, projectionId: "equal-earth" as never })).toThrow("This area needs a metric projection.");
  });
});

describe("scale slider", () => {
  it("maps the ends and round-trips 2500", () => {
    expect(sliderToScale(0)).toBe(SCALE_MIN);
    expect(sliderToScale(1000)).toBe(SCALE_MAX);
    expect(sliderToScale(scaleToSlider(2500))).toBe(2500);
  });
  it("always gives nice numbers", () => {
    for (let v = 0; v <= 1000; v += 7) {
      const s = sliderToScale(v);
      const m = s / 10 ** Math.floor(Math.log10(s));
      expect([1, 1.25, 2, 2.5, 5, 10].some((n) => Math.abs(n - m) < 1e-9)).toBe(true);
    }
  });
});

describe("areaKm2", () => {
  it("is about 1 km2 for 0.009 x 0.009 degrees at the equator-ish", () => {
    expect(areaKm2([0, 0, 0.009, 0.009])).toBeGreaterThan(0.9);
  });
});

describe("view.ts stays browser-safe", () => {
  const text = readFileSync(fileURLToPath(new URL("../../src/project/view.ts", import.meta.url)), "utf8");
  it("imports nothing from node:", () => {
    expect(text).not.toMatch(/from\s+["']node:/);
    expect(text).not.toMatch(/require\(/);
  });
  it("imports only allowed modules", () => {
    const allowed = new Set(["proj4", "./types.js", "./roles.js", "./styles.js", "../types.js", "../projections.js", "../crs.js"]);
    const specs = [...text.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]!);
    for (const s of specs) expect(allowed.has(s), s).toBe(true);
  });
});
