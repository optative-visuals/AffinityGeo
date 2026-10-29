import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readDataset } from "../src/read/index.js";

const fx = (p: string) => fileURLToPath(new URL("./fixtures/" + p, import.meta.url));
function tmp(name: string, text: string): string {
  const p = join(mkdtempSync(join(tmpdir(), "ag-csv-")), name);
  writeFileSync(p, text);
  return p;
}

describe("readDataset csv", () => {
  it("reads points, skips and counts bad rows, parses numbers", async () => {
    const ds = await readDataset(fx("cities.csv"));
    expect(ds).toHaveLength(1);
    const d = ds[0];
    expect(d.kind).toBe("point");
    expect(d.sourceFormat).toBe("csv");
    expect(d.crs.id).toBe("EPSG:4326");
    expect(d.features).toHaveLength(4);
    expect(d.report.skipped).toBe(2);
    expect(d.report.read).toBe(6);
    const london = d.features[0];
    expect(london.name).toBe("London");
    expect(london.geometry).toEqual({ type: "Point", coordinates: [-0.1276, 51.5072] });
    expect(london.attrs.population).toBe(8982000);
    expect(london.attrs.country).toBe("UK");
    expect(d.features[3].attrs.population).toBe(709000);
  });
  it("detects lat/lng headers case-insensitively and a semicolon delimiter", async () => {
    const ds = await readDataset(tmp("pts.csv", "Name;LAT;LNG\nA;1,5;2\nB;3;4\n".replace("1,5", "1.5")));
    expect(ds[0].features.map((f) => f.geometry.coordinates)).toEqual([[2, 1.5], [4, 3]]);
  });
  it("forces tab for .tsv", async () => {
    const ds = await readDataset(tmp("pts.tsv", "name\tlat\tlon\nA\t1\t2\n"));
    expect(ds[0].features).toHaveLength(1);
  });
  it("turns empty cells into null", async () => {
    const ds = await readDataset(tmp("pts.csv", "name,lat,lon,note\nA,1,2,\n"));
    expect(ds[0].features[0].attrs.note).toBeNull();
  });
  it("rejects when there are no lat/lon columns", async () => {
    await expect(readDataset(tmp("x.csv", "a,b\n1,2\n"))).rejects.toThrow(/couldn't find latitude and longitude columns/);
  });
});
