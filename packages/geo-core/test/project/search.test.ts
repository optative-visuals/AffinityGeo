import { describe, expect, it } from "vitest";
import { parseSearch, searchPath, searchPlaces } from "../../src/project/search.js";
import { DataError } from "../../src/project/osm.js";

const nominatim = [{
  display_name: "Serpentine, Hyde Park, London, England",
  lat: "51.5114", lon: "-0.1618", boundingbox: ["51.5000", "51.5200", "-0.1800", "-0.1400"],
}];
const fake = (body: unknown, status = 200) => {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const impl = (async (url: string, init?: { headers?: Record<string, string> }) => {
    calls.push({ url: String(url), headers: init?.headers ?? {} });
    return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) };
  }) as unknown as typeof fetch;
  return { impl, calls };
};

describe("searchPlaces", () => {
  it("parses the bounding box as [west, south, east, north]", async () => {
    const f = fake(nominatim);
    const res = await searchPlaces("Hyde Park", f.impl, () => 10_000);
    expect(res).toEqual([{ name: nominatim[0].display_name, bboxWgs84: [-0.18, 51.50, -0.14, 51.52], centre: [-0.1618, 51.5114] }]);
  });
  it("sends the AffinityGeo User-Agent and the query", async () => {
    const f = fake(nominatim);
    await searchPlaces("Hyde Park & co", f.impl, () => 100_000);
    expect(f.calls[0].url).toContain("https://nominatim.openstreetmap.org/search?");
    expect(f.calls[0].url).toContain("q=Hyde%20Park%20%26%20co");
    expect(f.calls[0].headers["User-Agent"]).toMatch(/^AffinityGeo\/\S+ \(\+https:\/\/github\.com\/optative-visuals\)$/);
  });
  it("waits so calls are at least a second apart", async () => {
    const f = fake(nominatim);
    let now = 200_000;
    const waits: number[] = [];
    const sleep = async (ms: number) => { waits.push(ms); now += ms; };
    await searchPlaces("a", f.impl, () => now, sleep);
    now += 300;
    await searchPlaces("b", f.impl, () => now, sleep);
    expect(waits.length).toBe(1);
    expect(waits[0]).toBeGreaterThanOrEqual(700);
    expect(waits[0]).toBeLessThanOrEqual(1000);
  });
  it("returns nothing for a blank query without calling out", async () => {
    const f = fake(nominatim);
    expect(await searchPlaces("   ", f.impl)).toEqual([]);
    expect(f.calls.length).toBe(0);
  });
  it("gives a plain message when the service is busy", async () => {
    const f = fake([], 429);
    await expect(searchPlaces("x", f.impl, () => 900_000)).rejects.toBeInstanceOf(DataError);
  });
});

describe("outlines", () => {
  const poly = { type: "Polygon", coordinates: [[[-0.18, 51.50], [-0.14, 51.50], [-0.14, 51.52], [-0.18, 51.50]]] };
  const base = { lat: "51.51", lon: "-0.16", boundingbox: ["51.50", "51.52", "-0.18", "-0.14"], display_name: "X" };
  it("asks Nominatim for polygons", () => {
    expect(searchPath("a")).toContain("&polygon_geojson=1&polygon_threshold=0.0005");
  });
  it("keeps a Polygon outline and drops a Point one", () => {
    const res = parseSearch([{ ...base, geojson: poly }, { ...base, geojson: { type: "Point", coordinates: [-0.16, 51.51] } }]);
    expect(res[0]!.outline).toEqual(poly);
    expect(res[1]!.outline).toBeUndefined();
  });
});
