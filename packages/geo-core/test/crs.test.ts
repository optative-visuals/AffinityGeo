import { describe, expect, it } from "vitest";
import { WGS84, crsFromEpsg, crsFromPrj } from "../src/crs.js";

const BNG_ESRI =
  'PROJCS["British_National_Grid",GEOGCS["GCS_OSGB_1936",DATUM["D_OSGB_1936",SPHEROID["Airy_1830",6377563.396,299.3249646]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",400000.0],PARAMETER["False_Northing",-100000.0],PARAMETER["Central_Meridian",-2.0],PARAMETER["Scale_Factor",0.9996012717],PARAMETER["Latitude_Of_Origin",49.0],UNIT["Meter",1.0]]';

const NAD83_UTM10 =
  'PROJCS["NAD_1983_UTM_Zone_10N",GEOGCS["GCS_North_American_1983",DATUM["D_North_American_1983",SPHEROID["GRS_1980",6378137.0,298.257222101]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",500000.0],PARAMETER["False_Northing",0.0],PARAMETER["Central_Meridian",-123.0],PARAMETER["Scale_Factor",0.9996],PARAMETER["Latitude_Of_Origin",0.0],UNIT["Meter",1.0]]';

describe("crs", () => {
  it("rejects WKT that proj4 cannot parse", () => {
    expect(() => crsFromPrj("garbage")).toThrow(/couldn't understand the coordinate system/);
    expect(() => crsFromPrj('PROJCS["My_Local_Grid",GEOGCS["GCS_Foo"]]')).toThrow(/couldn't understand/);
  });
  it("WGS84 constant", () => {
    expect(WGS84.id).toBe("EPSG:4326");
  });
  it("recognises ESRI British National Grid WKT", () => {
    expect(crsFromPrj(BNG_ESRI).id).toBe("EPSG:27700");
  });
  it("matches OGC spellings case-insensitively", () => {
    expect(crsFromPrj('PROJCS["OSGB 1936 / British National Grid",GEOGCS["x"]]').id).toBe("EPSG:27700");
    expect(crsFromPrj('projcs["osgb36 / british national grid"]').id).toBe("EPSG:27700");
  });
  it("recognises WGS 84, Web Mercator and UTM", () => {
    expect(crsFromPrj('GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984"]]').id).toBe("EPSG:4326");
    expect(crsFromPrj('PROJCS["WGS_84_Pseudo_Mercator",GEOGCS["x"]]').id).toBe("EPSG:3857");
    expect(crsFromPrj('PROJCS["WGS 84 / UTM zone 30N",GEOGCS["x"]]').id).toBe("EPSG:32630");
    expect(crsFromPrj('PROJCS["WGS_1984_UTM_Zone_33S",GEOGCS["x"]]').id).toBe("EPSG:32733");
  });
  it("unknown WKT keeps the WKT as proj4 and uses its name as label", () => {
    const wkt = NAD83_UTM10;
    const c = crsFromPrj(wkt);
    expect(c.id.startsWith("WKT:")).toBe(true);
    expect(c.proj4).toBe(wkt);
    expect(c.label).toBe("NAD_1983_UTM_Zone_10N");
  });
  it("unknown geographic WKT uses GEOGCS name", () => {
    expect(crsFromPrj('GEOGCS["GCS_Odd",DATUM["D_Odd",SPHEROID["Odd",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]').label).toBe("GCS_Odd");
  });
  it("crsFromEpsg builds known and generated codes", () => {
    expect(crsFromEpsg(27700).proj4).toContain("+towgs84=446.448,-125.157,542.06,0.15,0.247,0.842,-20.489");
    expect(crsFromEpsg(3857).id).toBe("EPSG:3857");
    expect(crsFromEpsg(8857).id).toBe("EPSG:8857");
    expect(crsFromEpsg(32630).proj4).toBe("+proj=utm +zone=30 +datum=WGS84 +units=m +no_defs");
    expect(crsFromEpsg(32733).proj4).toBe("+proj=utm +zone=33 +south +datum=WGS84 +units=m +no_defs");
  });
  it("crsFromEpsg rejects unknown codes", () => {
    expect(() => crsFromEpsg(99999)).toThrow(/EPSG:99999/);
  });
});
