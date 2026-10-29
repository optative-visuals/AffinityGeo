import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DataError, areaWarning, buildOverpassQuery, fetchOsm, parseOverpass } from "../../src/project/osm.js";
import type { Bbox } from "../../src/types.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/osm-campus.json", import.meta.url), "utf8"));
const BUSY = "OpenStreetMap is busy right now. Try again in a minute — your current data is unchanged.";
const TOO_BIG = "That area is too big for a street-level map. Choose a smaller area.";
const small: Bbox = [-0.1690, 51.5040, -0.1640, 51.5065];

const fake = (status: number, body: unknown = { elements: [] }) => {
  const calls: Array<{ url: string; init: any }> = [];
  const impl = (async (url: string, init: any) => {
    calls.push({ url: String(url), init });
    return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
  }) as unknown as typeof fetch;
  return { impl, calls };
};

describe("buildOverpassQuery", () => {
  it("is one json query with geometry output and the bbox as south,west,north,east", () => {
    const q = buildOverpassQuery(small);
    expect(q.startsWith("[out:json][timeout:90];")).toBe(true);
    expect(q).toContain("out geom;");
    expect(q).toContain("(51.504000,-0.169000,51.506500,-0.164000)");
    for (const needle of ['"highway"', '"building"', '"parking"', '"natural"="water"', '"leisure"', '"landuse"', '"railway"', '"amenity"'])
      expect(q).toContain(needle);
  });
});

describe("parseOverpass", () => {
  const ds = parseOverpass(fixture);
  it("returns datasets for buildings, paths and minor roads", () => {
    for (const r of ["buildings", "paths", "minorRoads"] as const) expect(ds[r]?.features.length).toBeGreaterThan(0);
  });
  it("uses WGS84 with the role label, osm fids and clean names", () => {
    for (const d of Object.values(ds)) {
      expect(d.crs.id).toBe("EPSG:4326");
      expect(d.report.read).toBe(d.features.length);
      for (const f of d.features) {
        expect(f.fid.startsWith("osm-")).toBe(true);
        // eslint-disable-next-line no-control-regex
        expect(f.name).not.toMatch(/[\u0000-\u001f]/);
      }
    }
    expect(ds.buildings?.name).toBe("Buildings");
    expect(ds.paths?.name).toBe("Paths and footways");
  });
  it("gets kinds from geometry and points as [lon, lat]", () => {
    expect(ds.buildings?.kind).toBe("polygon");
    expect(ds.paths?.kind).toBe("line");
    if (ds.poi) {
      expect(ds.poi.kind).toBe("point");
      for (const f of ds.poi.features) expect(f.geometry.type).toBe("Point");
    }
    const g = ds.buildings!.features[0].geometry as any;
    const [lon, lat] = g.type === "Polygon" ? g.coordinates[0][0] : g.coordinates[0][0][0];
    expect(Math.abs(lon)).toBeLessThan(2);
    expect(lat).toBeGreaterThan(50);
  });
});

describe("parseOverpass details", () => {
  const way = (id: number, tags: any, pts: Array<[number, number]>) =>
    ({ type: "way", id, tags, geometry: pts.map(([lon, lat]) => ({ lat, lon })) });
  it("joins multipolygon members into rings with a hole", () => {
    const res = parseOverpass({ elements: [{
      type: "relation", id: 7, tags: { building: "yes", type: "multipolygon", name: "Court" },
      members: [
        { type: "way", ref: 1, role: "outer", geometry: [{ lat: 0, lon: 0 }, { lat: 0, lon: 10 }, { lat: 10, lon: 10 }] },
        { type: "way", ref: 2, role: "outer", geometry: [{ lat: 10, lon: 10 }, { lat: 10, lon: 0 }, { lat: 0, lon: 0 }] },
        { type: "way", ref: 3, role: "inner", geometry: [{ lat: 4, lon: 4 }, { lat: 4, lon: 6 }, { lat: 6, lon: 6 }, { lat: 6, lon: 4 }, { lat: 4, lon: 4 }] },
      ],
    }] });
    const f = res.buildings!.features[0];
    expect(f.fid).toBe("osm-relation-7");
    expect(f.name).toBe("Court");
    expect(f.geometry.type).toBe("MultiPolygon");
    const polys = (f.geometry as any).coordinates;
    expect(polys.length).toBe(1);
    expect(polys[0].length).toBe(2);
    expect(polys[0][0][0]).toEqual(polys[0][0][polys[0][0].length - 1]);
  });
  it("puts a hole in the outer ring that contains it", () => {
    const sq = (x: number, y: number, s: number) => [[x, y], [x + s, y], [x + s, y + s], [x, y + s], [x, y]].map(([lon, lat]) => ({ lat, lon }));
    const res = parseOverpass({ elements: [{
      type: "relation", id: 9, tags: { building: "yes", type: "multipolygon" },
      members: [
        { type: "way", role: "outer", geometry: sq(0, 0, 10) },
        { type: "way", role: "outer", geometry: sq(20, 0, 10) },
        { type: "way", role: "inner", geometry: sq(24, 4, 2) },
      ],
    }] });
    const polys = (res.buildings!.features[0].geometry as any).coordinates;
    expect(polys.length).toBe(2);
    expect(polys[0].length).toBe(1);
    expect(polys[1].length).toBe(2);
  });
  it("turns poi nodes and poi polygons into points", () => {
    const res = parseOverpass({ elements: [
      { type: "node", id: 1, lat: 51.4, lon: -0.9, tags: { amenity: "cafe", name: "Cafe" } },
      way(2, { amenity: "cafe", name: "Big Cafe" }, [[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]),
      { type: "node", id: 3, lat: 51.4, lon: -0.9, tags: { natural: "tree" } },
    ] });
    expect(res.poi!.kind).toBe("point");
    expect(res.poi!.features.map((f) => f.fid)).toEqual(["osm-node-1", "osm-way-2"]);
    expect(res.poi!.features[1].geometry).toEqual({ type: "Point", coordinates: [1, 1] });
    expect(res.poi!.features[0].attrs.amenity).toBe("cafe");
  });
  it("keeps closed footpaths as lines and drops open building ways", () => {
    const res = parseOverpass({ elements: [
      way(1, { highway: "footway" }, [[0, 0], [1, 0], [1, 1], [0, 0]]),
      way(2, { building: "yes" }, [[0, 0], [1, 0], [1, 1]]),
    ] });
    expect(res.paths!.features.length).toBe(1);
    expect(res.paths!.features[0].geometry.type).toBe("LineString");
    expect(res.buildings).toBeUndefined();
  });
  it("tolerates junk", () => {
    expect(parseOverpass(null)).toEqual({});
    expect(parseOverpass({})).toEqual({});
  });
});

describe("fetchOsm", () => {
  it.each([429, 504])("says OpenStreetMap is busy on %i", async (status) => {
    const f = fake(status);
    await expect(fetchOsm(small, f.impl)).rejects.toThrow(BUSY);
    await expect(fetchOsm(small, f.impl)).rejects.toBeInstanceOf(DataError);
    expect(f.calls.length).toBe(2); // no automatic retry
  });
  it("says busy when the network fails", async () => {
    const impl = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    await expect(fetchOsm(small, impl)).rejects.toThrow(BUSY);
  });
  it("refuses a 30 km² area without calling out", async () => {
    const f = fake(200);
    const big: Bbox = [-0.40, 51.40, 0.10, 51.52]; // ~ 35 km²
    await expect(fetchOsm(big, f.impl)).rejects.toThrow(TOO_BIG);
    expect(f.calls.length).toBe(0);
  });
  it("treats a 200 with a runtime-error remark as busy", async () => {
    const f = fake(200, { remark: 'runtime error: Query timed out in "query" at line 1 after 91 seconds.', elements: [] });
    await expect(fetchOsm(small, f.impl)).rejects.toThrow(BUSY);
  });
  it("posts the query with the User-Agent and parses the response", async () => {
    const f = fake(200, fixture);
    const ds = await fetchOsm(small, f.impl);
    expect(ds.buildings).toBeDefined();
    expect(f.calls[0].url).toBe("https://overpass-api.de/api/interpreter");
    expect(f.calls[0].init.headers["User-Agent"]).toMatch(/^AffinityGeo\/\S+ \(\+https:\/\/github\.com\/optative-visuals\)$/);
    expect(decodeURIComponent(String(f.calls[0].init.body))).toContain("[out:json][timeout:90];");
  });
});

describe("areaWarning", () => {
  // At 51.5N, 1 degree of latitude is ~111.2 km and of longitude ~69.3 km.
  const around = (km2: number): Bbox => {
    const side = Math.sqrt(km2);
    const dLat = side / 111.2, dLon = side / (111.2 * Math.cos(51.5 * Math.PI / 180));
    return [0, 51.5, dLon, 51.5 + dLat];
  };
  it("is quiet at or under 3 km²", () => {
    expect(areaWarning(around(2.9))).toBeNull();
  });
  it("warns above 3 km²", () => {
    expect(areaWarning(around(3.3))).toBe("This is a large area. Fetching may take a while and maps may be slow to draw.");
  });
});
