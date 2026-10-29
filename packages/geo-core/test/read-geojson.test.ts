import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readDataset } from "../src/read/index.js";
import { WGS84 } from "../src/crs.js";
import { featureId, featureName, layerNameFromPath } from "../src/read/naming.js";

const fx = (p: string) => fileURLToPath(new URL("./fixtures/" + p, import.meta.url));

describe("readDataset geojson", () => {
  it("splits mixed.geojson by kind", async () => {
    const ds = await readDataset(fx("mixed.geojson"));
    expect(ds.map((d) => d.kind).sort()).toEqual(["point", "polygon"]);
    expect(ds.map((d) => d.name).sort()).toEqual(["Mixed — points", "Mixed — polygons"]);
    const poly = ds.find((d) => d.kind === "polygon")!;
    const pt = ds.find((d) => d.kind === "point")!;
    expect(poly.crs).toEqual(WGS84);
    expect(poly.sourceFormat).toBe("geojson");
    expect(poly.features).toHaveLength(2);
    expect(poly.features[0].fid).toBe("p1");
    expect(poly.features[0].name).toBe("Meadow");
    expect(poly.features[0].attrs).toEqual({ name: "Meadow", area: 12.5 });
    expect(poly.features[1].fid).toBe("7");
    expect(poly.features[1].name).toBe("Hill");
    expect(pt.features[0].fid).toBe("f2");
    expect(pt.features[0].attrs.capital).toBe(true);
  });
  it("skips null geometry and reports it", async () => {
    const ds = await readDataset(fx("mixed.geojson"));
    const skipped = ds.reduce((s, d) => s + d.report.skipped, 0);
    expect(skipped).toBe(1);
    const withReason = ds.find((d) => d.report.skipped === 1)!;
    expect(withReason.report.reasons[0]).toContain("no geometry");
    expect(ds.reduce((s, d) => s + d.report.read, 0)).toBe(4);
  });
  it("names a single-kind file without a suffix", async () => {
    const dir = mkdtempSync(join(tmpdir(), "geo-"));
    const p = join(dir, "rivers.geojson");
    writeFileSync(p, JSON.stringify({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [[0, 0], [1, 1]] } }));
    const ds = await readDataset(p);
    expect(ds).toHaveLength(1);
    expect(ds[0].name).toBe("Rivers");
    expect(ds[0].kind).toBe("line");
  });
  it("honours a legacy crs member naming EPSG:27700", async () => {
    const dir = mkdtempSync(join(tmpdir(), "geo-"));
    const p = join(dir, "g.geojson");
    writeFileSync(p, JSON.stringify({
      type: "FeatureCollection",
      crs: { type: "name", properties: { name: "urn:ogc:def:crs:EPSG::27700" } },
      features: [{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [500000, 200000] } }],
    }));
    const ds = await readDataset(p);
    expect(ds[0].crs.id).toBe("EPSG:27700");
  });
  it("strips Z and M values from positions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "geo-"));
    const p = join(dir, "z.geojson");
    writeFileSync(p, JSON.stringify({
      type: "FeatureCollection",
      features: [
        { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [[[0, 0, 5], [0, 1, 6], [1, 1, 7, 1], [0, 0, 5]]] } },
      ],
    }));
    const ds = await readDataset(p);
    const g = ds[0].features[0].geometry as { coordinates: number[][][] };
    expect(g.coordinates[0].every((pos) => pos.length === 2)).toBe(true);
    expect(g.coordinates[0][2]).toEqual([1, 1]);
  });
  it("rejects invalid JSON in plain language", async () => {
    const dir = mkdtempSync(join(tmpdir(), "geo-"));
    const p = join(dir, "bad.geojson");
    writeFileSync(p, "{ nope");
    await expect(readDataset(p)).rejects.toThrow(/isn't valid GeoJSON/);
  });
  it("rejects unsupported extensions", async () => {
    await expect(readDataset("thing.xyz")).rejects.toThrow(/\.xyz/);
  });
});

describe("naming", () => {
  it("layerNameFromPath", () => {
    expect(layerNameFromPath("ne_50m_rivers_lake_centerlines.shp")).toBe("Rivers Lake Centerlines");
    expect(layerNameFromPath("rivers.geojson")).toBe("Rivers");
    expect(layerNameFromPath("C:\\data\\my-roads.json")).toBe("My Roads");
  });
  it("featureName", () => {
    expect(featureName({ Name: "", title: "T" }, "x")).toBe("T");
    expect(featureName({ ADMIN: "France" }, "x")).toBe("France");
    expect(featureName({ NAME_EN: "Spain", name: null }, "x")).toBe("Spain");
    expect(featureName({ other: 1 }, "f3")).toBe("f3");
  });
  it("featureName falls back to name-like columns, not codes", () => {
    expect(featureName({ FID: 1, CTRY23CD: "E92000001", CTRY23NM: "England", CTRY23NMW: "Lloegr" }, "1")).toBe("England");
    expect(featureName({ LAD23CD: "E06000001", LAD23NM: "Hartlepool" }, "x")).toBe("Hartlepool");
    expect(featureName({ NAME_1: "Bayern" }, "x")).toBe("Bayern");
    expect(featureName({ CTRY23CD: "E92000001", GlobalID: "{abc}" }, "1")).toBe("1");
    expect(featureName({ CTRY23NM: "England", admin: "UK" }, "x")).toBe("UK");
    expect(featureName({ CODE01: "x1", NAME23NM01: "Fife" }, "x")).toBe("Fife");
    expect(featureName({ CODE01: "x1", LAD23CD01: "E06" }, "x")).toBe("x");
  });
  it("featureId", () => {
    expect(featureId({ id: "a", properties: { gid: 5 } }, 0)).toBe("a");
    expect(featureId({ properties: { OBJECTID: 12 } }, 0)).toBe("12");
    expect(featureId({ properties: { x: 1 } }, 4)).toBe("f4");
    expect(featureId({}, 2)).toBe("f2");
  });
});
