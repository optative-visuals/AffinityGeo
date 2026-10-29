import { describe, expect, it } from "vitest";
import { buildLayerJob, DEFAULT_STYLES } from "../src/job.js";
import type { GeoFeature, ProjectedLayer } from "../src/types.js";

const T = { scale: 1, tx: 0, ty: 100 };
const layer = (kind: ProjectedLayer["kind"], features: GeoFeature[]): ProjectedLayer => ({
  name: "L", kind, features, bbox: [0, 0, 100, 100],
});
const feat = (geometry: { type: string; coordinates: unknown }): GeoFeature => ({ fid: "f1", name: "One", geometry: geometry as GeoFeature["geometry"], attrs: {} });

describe("buildLayerJob", () => {
  it("polygon with hole: one feature, two closed paths, no repeated last point", () => {
    const g = { type: "Polygon" as const, coordinates: [
      [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
      [[2, 2], [4, 2], [4, 4], [2, 4], [2, 2]],
    ] };
    const job = buildLayerJob("a", layer("polygon", [feat(g)]), T);
    expect(job.features).toHaveLength(1);
    const f = job.features[0]!;
    expect(f.closed).toBe(true);
    expect(f.fid).toBe("f1");
    expect(f.name).toBe("One");
    expect(f.paths).toHaveLength(2);
    expect(f.paths[0]).toEqual([0, 100, 10, 100, 10, 90, 0, 90]);
    expect(f.paths[1]).toHaveLength(8);
  });
  it("MultiLineString: one feature, two open paths", () => {
    const g = { type: "MultiLineString" as const, coordinates: [[[0, 0], [1, 1]], [[2, 2], [3, 3]]] };
    const f = buildLayerJob("a", layer("line", [feat(g)]), T).features[0]!;
    expect(f.closed).toBe(false);
    expect(f.paths).toHaveLength(2);
  });
  it("points: one path per point", () => {
    const g = { type: "MultiPoint" as const, coordinates: [[1, 1], [2, 2]] };
    const f = buildLayerJob("a", layer("point", [feat(g)]), T).features[0]!;
    expect(f.paths).toEqual([[1, 99], [2, 98]]);
  });
  it("rounds to 2 decimals and never emits -0", () => {
    const g = { type: "LineString" as const, coordinates: [[0.123456, 100.0001], [5.555, 50.999]] };
    const f = buildLayerJob("a", layer("line", [feat(g)]), T).features[0]!;
    for (const v of f.paths[0]!) {
      expect(Object.is(v, -0)).toBe(false);
      expect(Math.round(v * 100) / 100).toBe(v);
    }
    expect(f.paths[0]![0]).toBe(0.12);
    expect(f.paths[0]![3]).toBe(49);
  });
  it("drops consecutive duplicates after rounding", () => {
    const g = { type: "LineString" as const, coordinates: [[0, 0], [0.001, 0.001], [5, 5]] };
    expect(buildLayerJob("a", layer("line", [feat(g)]), T).features[0]!.paths[0]).toEqual([0, 100, 5, 95]);
  });
  it("collapsed ring keeps pre-dedupe positions", () => {
    const g = { type: "Polygon" as const, coordinates: [[[0, 0], [0.001, 0], [0, 0.001], [0, 0]]] };
    expect(buildLayerJob("a", layer("polygon", [feat(g)]), T).features[0]!.paths[0]).toHaveLength(6);
  });
  it("MultiPolygon merges all rings; empty features omitted", () => {
    const sq = [[0, 0], [1, 0], [1, 1], [0, 0]];
    const g = { type: "MultiPolygon" as const, coordinates: [[sq], [sq, sq]] };
    const empty = feat({ type: "MultiLineString", coordinates: [] });
    const job = buildLayerJob("a", layer("polygon", [feat(g), empty]), T);
    expect(job.features).toHaveLength(1);
    expect(job.features[0]!.paths).toHaveLength(3);
    expect(job.skipped).toBe(1);
  });
  it("drops paths below the minimum and skips (and counts) features left with none", () => {
    const twoPointRing = { type: "Polygon" as const, coordinates: [[[0, 0], [5, 5], [0, 0]]] };
    const onePointLine = { type: "LineString" as const, coordinates: [[1, 1]] };
    const mixed = { type: "MultiPolygon" as const, coordinates: [[[[0, 0], [5, 5], [0, 0]]], [[[0, 0], [1, 0], [1, 1], [0, 0]]]] };
    const poly = buildLayerJob("a", layer("polygon", [feat(twoPointRing), { ...feat(mixed), fid: "f2" }]), T);
    expect(poly.features.map((f) => f.fid)).toEqual(["f2"]);
    expect(poly.features[0]!.paths).toHaveLength(1);
    expect(poly.skipped).toBe(1);
    const line = buildLayerJob("a", layer("line", [feat(onePointLine)]), T);
    expect(line.features).toHaveLength(0);
    expect(line.skipped).toBe(1);
    expect(buildLayerJob("a", layer("line", []), T).skipped).toBe(0);
  });
  it("style defaults are copies; explicit style wins", () => {
    const job = buildLayerJob("a", layer("line", []), T);
    expect(job.style).toEqual(DEFAULT_STYLES.line);
    expect(job.style).not.toBe(DEFAULT_STYLES.line);
    const s = { fill: null, stroke: "#000000", strokePt: 3, pointRadiusPt: 0 };
    expect(buildLayerJob("a", layer("line", []), T, s).style).toEqual(s);
    expect(DEFAULT_STYLES.polygon).toEqual({ fill: "#E8E4DC", stroke: "#8C8C8C", strokePt: 0.5, pointRadiusPt: 0 });
    expect(DEFAULT_STYLES.point).toEqual({ fill: "#333333", stroke: null, strokePt: 0, pointRadiusPt: 2 });
  });
  it("drops a polygon whose outer ring is too small, together with its holes", () => {
    const g = { type: "Polygon" as const, coordinates: [
      [[0, 0], [5, 5], [0, 0]],
      [[2, 2], [4, 2], [4, 4], [2, 4], [2, 2]],
    ] };
    const multi = { type: "MultiPolygon" as const, coordinates: [g.coordinates, [[[0, 0], [1, 0], [1, 1], [0, 0]]]] };
    const job = buildLayerJob("a", layer("polygon", [feat(g), { ...feat(multi), fid: "f2" }]), T);
    expect(job.features.map((f) => f.fid)).toEqual(["f2"]);
    expect(job.features[0]!.paths).toHaveLength(1);
    expect(job.skipped).toBe(1);
  });
});
