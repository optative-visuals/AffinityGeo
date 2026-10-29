import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WGS84 } from "../src/crs.js";
import { buildDatasets, type RawFeature } from "../src/read/build.js";
import { readDataset } from "../src/read/index.js";

const pt = (properties: Record<string, unknown>, id?: unknown): RawFeature => ({
  ...(id === undefined ? {} : { id }),
  properties,
  geometry: { type: "Point", coordinates: [1, 2] },
});
const build = (raw: RawFeature[]) => buildDatasets(raw, { path: "C:\\data\\test.geojson", format: "geojson", crs: WGS84 })[0]!;

describe("buildDatasets text cleaning", () => {
  it("strips NUL padding from string attributes and from the feature name", () => {
    const ds = build([pt({ NAME: "France\u0000\u0000\u0000", ISO: " FR \u0000\u0000", POP: 67 })]);
    const f = ds.features[0]!;
    expect(f.attrs.NAME).toBe("France");
    expect(f.attrs.ISO).toBe("FR");
    expect(f.attrs.POP).toBe(67);
    expect(f.name).toBe("France");
  });

  it("treats an all-NUL value as empty when naming", () => {
    const ds = build([pt({ name: "\u0000\u0000", ADMIN: "Spain\u0000" })]);
    expect(ds.features[0]!.name).toBe("Spain");
  });
});

describe("buildDatasets feature ids from code-like columns", () => {
  it("prefers NE_ID, then ADM0_A3, then ISO_A3 when unique", () => {
    const ne = build([
      pt({ NE_ID: 1159320379, ADM0_A3: "FRA", ISO_A3: "-99" }),
      pt({ NE_ID: 1159320403, ADM0_A3: "NOR", ISO_A3: "-99" }),
    ]);
    expect(ne.features.map((f) => f.fid)).toEqual(["1159320379", "1159320403"]);

    const adm = build([pt({ ADM0_A3: "FRA\u0000", ISO_A3: "FRA" }), pt({ ADM0_A3: "NOR", ISO_A3: "NOR" })]);
    expect(adm.features.map((f) => f.fid)).toEqual(["FRA", "NOR"]);

    // ISO_A3 has a -99, so it is not used; nothing else qualifies.
    const iso = build([pt({ ISO_A3: "FRA" }), pt({ ISO_A3: "-99" })]);
    expect(iso.features.map((f) => f.fid)).toEqual(["f0", "f1"]);

    // NE_ID not unique: fall through to ADM0_A3.
    const dup = build([pt({ NE_ID: 1, ADM0_A3: "AAA" }), pt({ NE_ID: 1, ADM0_A3: "BBB" })]);
    expect(dup.features.map((f) => f.fid)).toEqual(["AAA", "BBB"]);
  });

  it("uses an ONS-style code column (…CD) when it is unique and complete", () => {
    const ons = build([
      pt({ CTRY23CD: "E92000001", CTRY23NM: "England" }),
      pt({ CTRY23CD: "W92000004", CTRY23NM: "Wales" }),
    ]);
    expect(ons.features.map((f) => f.fid)).toEqual(["E92000001", "W92000004"]);
    expect(build([pt({ lad_code: "A" }), pt({ lad_code: "B" })]).features.map((f) => f.fid)).toEqual(["A", "B"]);
    expect(build([pt({ CODE: "A" }), pt({ CODE: "B" })]).features.map((f) => f.fid)).toEqual(["A", "B"]);
    expect(build([pt({ LAD23CD01: "A" }), pt({ LAD23CD01: "B" })]).features.map((f) => f.fid)).toEqual(["A", "B"]);
  });

  it("skips a code column with a gap or a repeat", () => {
    expect(build([pt({ CTRY23CD: "E1" }), pt({ CTRY23CD: "" })]).features.map((f) => f.fid)).toEqual(["f0", "f1"]);
    expect(build([pt({ CTRY23CD: "E1" }), pt({ CTRY23CD: "E1" })]).features.map((f) => f.fid)).toEqual(["f0", "f1"]);
  });

  it("an explicit id or id-like column still wins over a code column", () => {
    expect(build([pt({ CTRY23CD: "E1" }, "x1"), pt({ CTRY23CD: "E2" }, "x2")]).features.map((f) => f.fid)).toEqual(["x1", "x2"]);
    expect(build([pt({ FID: 1, CTRY23CD: "E1" }), pt({ FID: 2, CTRY23CD: "E2" })]).features.map((f) => f.fid)).toEqual(["1", "2"]);
  });
});

describe("reader error messages", () => {
  it("name the file, not the whole Windows path", async () => {
    await expect(readDataset("C:\\nowhere\\at\\all\\missing.csv")).rejects.toThrow(/^Couldn't open missing\.csv\./);
    await expect(readDataset("C:\\nowhere\\at\\all\\missing.kml")).rejects.toThrow(/^Couldn't open missing\.kml\./);
  });

  it("KML with only xmldom warnings still reads", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ageo-kml-"));
    const file = join(dir, "warn.kml");
    writeFileSync(file,
      '<kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark><name>A</name>' +
      '<Point a="1"b="2"><coordinates>1,2</coordinates></Point></Placemark></Document></kml>');
    const [ds] = await readDataset(file);
    expect(ds!.features).toHaveLength(1);
    expect(ds!.features[0]!.name).toBe("A");
  });
});
