import { describe, expect, it } from "vitest";
import { countNodes, simplifyLayer } from "../src/simplify.js";
import type { GeoFeature, Position, ProjectedLayer } from "../src/types.js";

function layerOf(features: GeoFeature[], kind: ProjectedLayer["kind"] = "polygon"): ProjectedLayer {
  return { name: "T", kind, features, bbox: [0, 0, 20, 10] };
}
const feat = (fid: string, geometry: GeoFeature["geometry"]): GeoFeature => ({ fid, name: fid.toUpperCase(), geometry, attrs: { k: fid } });

// shared edge x=10, y from 0 to 10, with 50 wobbly interior points
const shared: Position[] = [];
for (let i = 0; i <= 51; i++) shared.push([10 + (i % 2 ? 0.05 : -0.05) * (i > 0 && i < 51 ? 1 : 0), (i * 10) / 51]);
function squares(): ProjectedLayer {
  const edgeUp = shared; // (10,0) -> (10,10)
  const a: Position[] = [[0, 0], ...edgeUp, [0, 10], [0, 0]];
  const b: Position[] = [[20, 0], [20, 10], ...[...edgeUp].reverse(), [20, 0]];
  return layerOf([feat("a", { type: "Polygon", coordinates: [a] }), feat("b", { type: "Polygon", coordinates: [b] })]);
}

describe("countNodes", () => {
  it("counts every position including ring closers", () => {
    const l = squares();
    const expected = l.features.reduce((n, f) => n + (f.geometry as { coordinates: Position[][] }).coordinates[0].length, 0);
    expect(countNodes(l.features)).toBe(expected);
    expect(countNodes([feat("p", { type: "Point", coordinates: [1, 2] })])).toBe(1);
  });
});

describe("simplifyLayer", () => {
  it("keeps the shared edge identical in both polygons", () => {
    const { layer } = simplifyLayer(squares(), 20);
    const [a, b] = layer.features.map((f) => (f.geometry as { coordinates: Position[][] }).coordinates[0]);
    const onEdge = (r: Position[]) => r.filter(([x, y]) => x > 9 && x < 11 && y >= 0 && y <= 10).map((p) => p.join(","));
    const set = (r: Position[]) => [...new Set(onEdge(r))].sort();
    expect(set(a)).toEqual(set(b));
    expect(set(a).length).toBeLessThan(52);
  });

  it("reduces nodes and reports counts", () => {
    const l = squares();
    const r = simplifyLayer(l, 20);
    expect(r.nodesBefore).toBe(countNodes(l.features));
    expect(r.nodesAfter).toBe(countNodes(r.layer.features));
    expect(r.nodesAfter).toBeLessThan(r.nodesBefore);
    expect(r.layer.features.map((f) => [f.fid, f.name, f.attrs])).toEqual(l.features.map((f) => [f.fid, f.name, f.attrs]));
  });

  it("detail 100 returns the layer unchanged", () => {
    const l = squares();
    const r = simplifyLayer(l, 100);
    expect(r.layer).toBe(l);
    expect(r.nodesAfter).toBe(r.nodesBefore);
  });

  it("never collapses a ring at detail 0 and keeps outer corners", () => {
    const r = simplifyLayer(squares(), 0);
    for (const f of r.layer.features) {
      for (const ring of (f.geometry as { coordinates: Position[][] }).coordinates) {
        expect(ring.length).toBeGreaterThanOrEqual(4);
        expect(new Set(ring.map((p) => p.join(","))).size).toBeGreaterThanOrEqual(3);
        let area = 0;
        for (let i = 0; i < ring.length - 1; i++) area += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
        expect(Math.abs(area / 2)).toBeGreaterThan(1);
      }
    }
    const verts = (i: number) => new Set((r.layer.features[i].geometry as { coordinates: Position[][] }).coordinates[0].map((p) => p.join(",")));
    for (const c of ["0,0", "0,10"]) expect(verts(0).has(c)).toBe(true);
    for (const c of ["20,0", "20,10"]) expect(verts(1).has(c)).toBe(true);
  });

  it("keeps lines at 2 or more positions", () => {
    const line: Position[] = Array.from({ length: 30 }, (_, i) => [i, i % 2 ? 0.01 : 0]);
    const r = simplifyLayer(layerOf([feat("l", { type: "LineString", coordinates: line })], "line"), 0);
    expect((r.layer.features[0].geometry as { coordinates: Position[] }).coordinates.length).toBeGreaterThanOrEqual(2);
  });

  it("passes points through untouched", () => {
    const pts = layerOf([feat("p", { type: "Point", coordinates: [3, 4] }), feat("m", { type: "MultiPoint", coordinates: [[1, 1], [2, 2]] })], "point");
    const r = simplifyLayer(pts, 10);
    expect(r.layer.features.map((f) => f.geometry)).toEqual(pts.features.map((f) => f.geometry));
    expect(r.nodesAfter).toBe(3);
  });

  it("does not mutate the input", () => {
    const l = squares();
    const snap = JSON.stringify(l);
    simplifyLayer(l, 20);
    expect(JSON.stringify(l)).toBe(snap);
  });
});
