// Acceptance checks on real public data. Skipped when the large fixtures are missing:
// run `npm run fetch-fixtures` first.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import proj4 from "proj4";
import { describe, expect, it } from "vitest";
import {
  WGS84, buildLayerJob, crsFromEpsg, fitFrame, getProjection, parseFilter, projectDataset, readDataset,
  simplifyLayer, worldToPage,
} from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const NE = join(here, "../../../fixtures-large/ne_50m_admin_0_countries/ne_50m_admin_0_countries.shp");
const ONS = join(here, "../../../fixtures-large/ons_ctry_dec_2023_uk_buc/CTRY_DEC_2023_UK_BUC.shp");
const GPX = join(here, "fixtures/track.gpx");

// Natural Earth 1:50m admin-0 countries, version 5.1.1: 242 records in the .dbf header.
const NE_50M_FEATURES = 242;
// ONS Countries (December 2023) Boundaries UK BUC, published 2024-03: 4 records.
const ONS_COUNTRIES = ["England", "Northern Ireland", "Scotland", "Wales"];
const RECT = { x: 0, y: 0, width: 2000, height: 1414 };

describe.skipIf(!existsSync(NE))("Natural Earth 50m countries in Equal Earth", () => {
  it("imports, projects, simplifies and builds a job in under 5 s", async () => {
    const t0 = performance.now();
    const [ds] = await readDataset(NE);
    const t1 = performance.now();
    const layer = projectDataset(ds!, getProjection("equal-earth"));
    const t2 = performance.now();
    const { layer: simple, nodesBefore, nodesAfter } = simplifyLayer(layer, 60);
    const t3 = performance.now();
    const t = fitFrame(simple.bbox, RECT);
    const job = buildLayerJob("countries", simple, t);
    const t4 = performance.now();
    const total = t4 - t0;
    console.log(
      `NE 50m: read ${(t1 - t0).toFixed(0)} ms, project ${(t2 - t1).toFixed(0)} ms, simplify ${(t3 - t2).toFixed(0)} ms, ` +
      `job ${(t4 - t3).toFixed(0)} ms, total ${total.toFixed(0)} ms; nodes ${nodesBefore} -> ${nodesAfter}`,
    );

    expect(ds!.features).toHaveLength(NE_50M_FEATURES);
    expect(ds!.report.skipped).toBe(0);
    expect(job.features).toHaveLength(NE_50M_FEATURES);
    expect(total).toBeLessThan(5000);
    // Plan target was < 40 %. Measured on NE 5.1.1 is 40.6 % (99613 -> 40435): ring floors in simplify.ts
    // keep tiny islands whole rather than collapsing them, and NE 50m has many. Ruled acceptable by the controller; the 40 % was
    // the plan's own number. Bound set just above the measurement.
    expect(nodesAfter).toBeLessThan(0.42 * nodesBefore);
    for (const f of ds!.features) {
      expect(f.name.length).toBeGreaterThan(0);
      expect(Object.keys(f.attrs).length).toBeGreaterThan(0);
    }
  });

  it("has clean text: no NUL padding or other control characters in names and string attributes", async () => {
    const [ds] = await readDataset(NE);
    const control = /[\u0000-\u001f]/;
    for (const f of ds!.features) {
      expect(f.name).not.toMatch(control);
      for (const v of Object.values(f.attrs)) if (typeof v === "string") expect(v).not.toMatch(control);
    }
    const isFrance = parseFilter("NAME = 'France'");
    expect(ds!.features.filter((f) => isFrance(f.attrs))).toHaveLength(1);
    // Feature ids come from NE_ID (unique), not the row index.
    expect(new Set(ds!.features.map((f) => f.fid)).size).toBe(NE_50M_FEATURES);
    expect(ds!.features.every((f) => /^\d+$/.test(f.fid) && f.fid === String(f.attrs.NE_ID))).toBe(true);
  });
});

describe.skipIf(!existsSync(ONS))("ONS UK countries in British National Grid", () => {
  it("keeps EPSG:27700 coordinates exactly and has the four countries", async () => {
    const [ds] = await readDataset(ONS);
    expect(ds!.crs.id).toBe("EPSG:27700");
    expect(ds!.features).toHaveLength(4);
    expect(ds!.features.map((f) => String(f.attrs.CTRY23NM)).sort()).toEqual(ONS_COUNTRIES);
    expect(ds!.features.map((f) => f.name).sort()).toEqual(ONS_COUNTRIES);

    const layer = projectDataset(ds!, getProjection("bng"));
    expect(layer.features).toHaveLength(4);
    layer.features.forEach((f, i) => {
      expect(f.geometry.coordinates).toStrictEqual(ds!.features[i]!.geometry.coordinates);
    });
  });
});

describe.skipIf(!existsSync(ONS))("GPX track in the UK frame", () => {
  it("shares the frame transform and lines up within 0.01 px", async () => {
    const [ons] = await readDataset(ONS);
    const uk = projectDataset(ons!, getProjection("bng"));
    const t = fitFrame(uk.bbox, RECT);

    const gpxSets = await readDataset(GPX);
    const track = gpxSets.find((d) => d.kind === "line")!;
    const layer = projectDataset(track, getProjection("bng"));
    const job = buildLayerJob("track", layer, t);

    const first = track.features[0]!.geometry;
    expect(first.type === "LineString" || first.type === "MultiLineString").toBe(true);
    const [lon, lat] = (first.type === "LineString" ? first.coordinates[0] : (first as { coordinates: number[][][] }).coordinates[0]![0])!;
    const [e, n] = proj4(WGS84.proj4, crsFromEpsg(27700).proj4, [lon!, lat!]);
    const [px, py] = worldToPage(t, e!, n!);

    const got = job.features[0]!.paths[0]!;
    expect(Math.abs(got[0]! - Math.round(px * 100) / 100)).toBeLessThanOrEqual(0.01);
    expect(Math.abs(got[1]! - Math.round(py * 100) / 100)).toBeLessThanOrEqual(0.01);
    // The point sits inside the page rect, so it is on the UK map.
    expect(got[0]!).toBeGreaterThan(0);
    expect(got[0]!).toBeLessThan(RECT.width);
    expect(got[1]!).toBeGreaterThan(0);
    expect(got[1]!).toBeLessThan(RECT.height);
  });
});
