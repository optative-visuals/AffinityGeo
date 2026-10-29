import { describe, expect, it } from "vitest";
import { PROJECTIONS, getProjection, suggestProjection } from "../src/projections.js";

describe("projections", () => {
  it("lists the five curated projections in order", () => {
    expect(PROJECTIONS.map((p) => p.id)).toEqual(["web-mercator", "equal-earth", "bng", "laea", "utm"]);
    expect(PROJECTIONS[1].description).toBe("A world map where every country keeps its true size. A good default for world maps.");
    expect(PROJECTIONS[4].name).toBe("UTM zone");
  });
  it("resolves kinds and defaults", () => {
    expect(getProjection("bng").crs?.id).toBe("EPSG:27700");
    expect(getProjection("utm", { zone: 33 }).crs?.id).toBe("EPSG:32633");
    expect(getProjection("utm", { zone: 5, south: 1 }).crs?.id).toBe("EPSG:32705");
    expect(getProjection("laea").params).toEqual({ lon0: 0, lat0: 0 });
    expect(getProjection("equal-earth").d3).not.toBeNull();
  });
  it("rejects bad utm zones", () => {
    expect(() => getProjection("utm")).toThrow(/zone/);
    expect(() => getProjection("utm", { zone: 61 })).toThrow(/zone/);
  });
  it("suggests", () => {
    expect(suggestProjection([-180, -60, 180, 80]).id).toBe("equal-earth");
    expect(suggestProjection([-6, 50, 2, 56]).id).toBe("bng");
    expect(suggestProjection([-0.5, 51.3, 0.3, 51.7]).id).toBe("bng");
    expect(suggestProjection([13, 52.3, 13.8, 52.7])).toEqual({ id: "utm", params: { zone: 33 } });
    const l = suggestProjection([-20, 30, 20, 60]);
    expect(l.id).toBe("laea");
    expect(l.params).toEqual({ lon0: 0, lat0: 45 });
  });
});
