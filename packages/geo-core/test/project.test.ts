import { describe, expect, it } from "vitest";
import proj4 from "proj4";
import { WGS84, crsFromEpsg } from "../src/crs.js";
import { getProjection } from "../src/projections.js";
import { projectDataset } from "../src/project.js";
import type { Dataset, GeoFeature, Geometry } from "../src/types.js";

function ds(crs: Dataset["crs"], geometry: Geometry, kind: Dataset["kind"] = "polygon"): Dataset {
  const f: GeoFeature = { fid: "a", name: "A", geometry, attrs: { k: 1 } };
  return { name: "T", sourcePath: "t", sourceFormat: "geojson", crs, kind, features: [f], report: { read: 1, skipped: 0, reasons: [] } };
}

describe("projectDataset", () => {
  const bngCrs = crsFromEpsg(27700);
  const ring: [number, number][] = [[530000.123456789, 180000.987654321], [531000.1, 180000.2], [531000.3, 181000.4], [530000.123456789, 180000.987654321]];

  it("same CRS leaves coordinates exactly untouched", () => {
    const d = ds(bngCrs, { type: "Polygon", coordinates: [ring] });
    const out = projectDataset(d, getProjection("bng"));
    expect(out.features[0].geometry.coordinates).toStrictEqual([ring]);
    expect(out.features[0].fid).toBe("a");
    expect(out.features[0].attrs).toEqual({ k: 1 });
    expect(out.bbox).toEqual([530000.123456789, 180000.2, 531000.3, 181000.4]);
  });

  it("BNG to WGS84 and back within 1 mm", () => {
    const wgs = ds(WGS84, { type: "Point", coordinates: [0, 0] }, "point");
    const [lon, lat] = proj4(bngCrs.proj4, WGS84.proj4, [530000, 180000]);
    wgs.features[0].geometry = { type: "Point", coordinates: [lon, lat] };
    const out = projectDataset(wgs, getProjection("bng"));
    const [x, y] = out.features[0].geometry.coordinates as [number, number];
    expect(Math.abs(x - 530000)).toBeLessThan(1e-3);
    expect(Math.abs(y - 180000)).toBeLessThan(1e-3);
  });

  const square: [number, number][] = [[10, 10], [20, 10], [20, 20], [10, 20], [10, 10]];
  const rev = (r: [number, number][]) => [...r].reverse();
  const bboxOf = (g: Geometry) => {
    const xs: number[] = [], ys: number[] = [];
    const walk = (c: unknown): void => {
      if (typeof (c as number[])[0] === "number") { xs.push((c as number[])[0]); ys.push((c as number[])[1]); } else (c as unknown[]).forEach(walk);
    };
    walk((g as { coordinates: unknown }).coordinates);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  };

  it.each(["web-mercator", "equal-earth", "laea"])("%s: winding does not matter", (id) => {
    const proj = getProjection(id, id === "laea" ? { lon0: 15, lat0: 15 } : {});
    const a = projectDataset(ds(WGS84, { type: "Polygon", coordinates: [square] }), proj).bbox;
    const b = projectDataset(ds(WGS84, { type: "Polygon", coordinates: [rev(square)] }), proj).bbox;
    for (let i = 0; i < 4; i++) expect(a[i]).toBeCloseTo(b[i], 9);
    expect(a[2] - a[0]).toBeLessThan(0.5);
    expect(a[3] - a[1]).toBeLessThan(0.5);
  });

  it("keeps holes whatever the winding, without mutating input", () => {
    const hole: [number, number][] = [[13, 13], [13, 17], [17, 17], [17, 13], [13, 13]];
    for (const [o, h] of [[square, hole], [rev(square), rev(hole)], [square, rev(hole)]] as const) {
      const input = ds(WGS84, { type: "Polygon", coordinates: [o, h] });
      const snapshot = JSON.stringify(input.features[0].geometry);
      const out = projectDataset(input, getProjection("equal-earth"));
      expect(JSON.stringify(input.features[0].geometry)).toBe(snapshot);
      const g = out.features[0].geometry as { type: string; coordinates: number[][][] };
      expect(g.type).toBe("Polygon");
      expect(g.coordinates).toHaveLength(2);
      const outer = bboxOf({ type: "Polygon", coordinates: [g.coordinates[0]] } as Geometry);
      const inner = bboxOf({ type: "Polygon", coordinates: [g.coordinates[1]] } as Geometry);
      expect(outer[2] - outer[0]).toBeLessThan(0.5);
      expect(inner[0]).toBeGreaterThan(outer[0]);
      expect(inner[2]).toBeLessThan(outer[2]);
      expect(inner[1]).toBeGreaterThan(outer[1]);
      expect(inner[3]).toBeLessThan(outer[3]);
    }
  });

  const strip: [number, number][] = [[170, -10], [-170, -10], [-170, 10], [170, 10], [170, -10]];
  it.each(["equal-earth", "web-mercator"])("%s cuts an antimeridian strip, either winding", (id) => {
    const proj = getProjection(id);
    const world = projectDataset(ds(WGS84, { type: "LineString", coordinates: [[-180, 0], [180, 0]] }, "line"), proj).bbox;
    const half = (world[2] - world[0]) / 2;
    const sample = projectDataset(ds(WGS84, { type: "LineString", coordinates: [[0, -10], [0, 10]] }, "line"), proj).bbox;
    const stripH = sample[3] - sample[1];
    for (const ring of [strip, rev(strip)]) {
      const out = projectDataset(ds(WGS84, { type: "Polygon", coordinates: [ring] }), proj);
      const g = out.features[0].geometry;
      expect(g.type).toBe("MultiPolygon");
      expect((g as { coordinates: unknown[] }).coordinates).toHaveLength(2);
      expect(out.bbox[3] - out.bbox[1]).toBeLessThan(stripH * 1.2);
      expect(out.bbox[3] - out.bbox[1]).toBeGreaterThan(stripH * 0.8);
      for (const poly of (g as { coordinates: [number, number][][][] }).coordinates)
        for (const r of poly)
          for (let i = 1; i < r.length; i++) expect(Math.abs(r[i][0] - r[i - 1][0])).toBeLessThan(half);
    }
  });

  it("north is +y and mercator clamps the poles", () => {
    const d = ds(WGS84, { type: "LineString", coordinates: [[0, 10], [0, 89.9]] }, "line");
    const out = projectDataset(d, getProjection("web-mercator"));
    const c = out.features[0].geometry.coordinates as [number, number][];
    expect(c[1][1]).toBeGreaterThan(c[0][1]);
    expect(Number.isFinite(c[1][1])).toBe(true);
  });

  it("skips features that vanish", () => {
    const d = ds(WGS84, { type: "Point", coordinates: [0, 0] }, "point");
    const out = projectDataset(d, getProjection("equal-earth"));
    expect(out.features).toHaveLength(1);
  });
});

import { datasetBboxWgs84 } from "../src/project.js";

describe("datasetBboxWgs84", () => {
  it("returns lon/lat bounds for a WGS84 dataset untouched", () => {
    const d = ds(WGS84, { type: "LineString", coordinates: [[-1, 50], [2, 53], [0, 51]] }, "line");
    expect(datasetBboxWgs84(d)).toEqual([-1, 50, 2, 53]);
  });
  it("transforms a BNG dataset to lon/lat", () => {
    const d = ds(crsFromEpsg(27700), { type: "Point", coordinates: [530000, 180000] }, "point");
    const [minX, minY, maxX, maxY] = datasetBboxWgs84(d);
    expect(minX).toBe(maxX);
    expect(minX).toBeGreaterThan(-0.5);
    expect(minX).toBeLessThan(0.5);
    expect(minY).toBeGreaterThan(51);
    expect(minY).toBeLessThan(52);
    expect(maxY).toBe(minY);
  });
  it("samples large datasets", () => {
    const coords: [number, number][] = Array.from({ length: 50_000 }, (_, i) => [i / 1000, 10]);
    const d = ds(WGS84, { type: "LineString", coordinates: coords }, "line");
    const b = datasetBboxWgs84(d);
    expect(b[0]).toBe(0);
    expect(b[2]).toBeGreaterThan(40);
  });
});
