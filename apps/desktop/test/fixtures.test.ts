import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseOverpass } from "@affinitygeo/geo-core";
import { fixtureOptions } from "../src/main/fixtures.js";

const OSM = "packages/geo-core/test/project/fixtures/osm-parkland.json";
const area = { bbox: [-0.1715, 51.5023, -0.1615, 51.5077] } as never;

describe("fixtureOptions (development-only recorded data)", () => {
  it("is empty in a packaged app, even with both variables set", () => {
    expect(fixtureOptions({ AFFINITYGEO_FIXTURE_OSM: "o.json", AFFINITYGEO_FIXTURE_PLACES: "p.json" }, true, () => "{}")).toEqual({});
  });
  it("is empty with no variables", () => {
    expect(fixtureOptions({}, false, () => "{}")).toEqual({});
  });
  it("answers fetchOsm from the recorded reply", async () => {
    const osm = readFileSync(OSM, "utf8");
    const o = fixtureOptions({ AFFINITYGEO_FIXTURE_OSM: "o.json" }, false, () => osm);
    expect(o.searchPlaces).toBeUndefined();
    expect(await o.fetchOsm!(area)).toEqual(parseOverpass(JSON.parse(osm)));
  });
  it("answers searchPlaces with the recorded list for any query", async () => {
    const o = fixtureOptions({ AFFINITYGEO_FIXTURE_PLACES: "p.json" }, false, () => '[{"name":"Hyde Park"}]');
    expect(o.fetchOsm).toBeUndefined();
    expect(await o.searchPlaces!("anything")).toEqual([{ name: "Hyde Park" }]);
  });
  it("gives no places for an empty search, as the real search does", async () => {
    const o = fixtureOptions({ AFFINITYGEO_FIXTURE_PLACES: "p.json" }, false, () => '[{"name":"Hyde Park"}]');
    expect(await o.searchPlaces!("  ")).toEqual([]);
  });
  it("reads the file lazily, so a missing file fails the request, not app start-up", async () => {
    const read = () => { throw new Error("ENOENT"); };
    const o = fixtureOptions({ AFFINITYGEO_FIXTURE_OSM: "missing.json" }, false, read);
    await expect(o.fetchOsm!(area)).rejects.toThrow("ENOENT");
  });
  it("the committed places fixture is a list of places", () => {
    const list = JSON.parse(readFileSync("apps/mcp/fixtures/places.json", "utf8")) as Array<{ name: string; bboxWgs84: number[]; centre: number[] }>;
    expect(list[0]!.name).toContain("Hyde Park");
    expect(list[0]!.bboxWgs84).toHaveLength(4);
    expect(list[0]!.centre).toHaveLength(2);
  });
});
