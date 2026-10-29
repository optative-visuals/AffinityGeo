import { fileURLToPath } from "node:url";
import { copyFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readDataset } from "../src/read/index.js";
import { WGS84 } from "../src/crs.js";

const fx = (p: string) => fileURLToPath(new URL("./fixtures/" + p, import.meta.url));

describe("readDataset shapefile", () => {
  it("reads bng3 with CRS detected from .prj", async () => {
    const ds = await readDataset(fx("bng3/bng3.shp"));
    expect(ds).toHaveLength(1);
    const d = ds[0];
    expect(d.name).toBe("Bng3");
    expect(d.sourceFormat).toBe("shapefile");
    expect(d.kind).toBe("polygon");
    expect(d.crs.id).toBe("EPSG:27700");
    expect(d.features).toHaveLength(3);
    expect(d.features[0].fid).toBe("f0");
    expect(d.features[0].name).toBe("Alpha");
    expect(d.features[0].attrs).toEqual({ NAME: "Alpha", POP: 1200 });
    expect(typeof d.features[1].attrs.POP).toBe("number");
    expect(d.features[0].geometry.type).toBe("Polygon");
    expect(d.report).toEqual({ read: 3, skipped: 0, reasons: [] });
  });
  it("assumes WGS84 without .prj when coordinates fit lon/lat", async () => {
    const ds = await readDataset(fx("wgsnoprj/wgsnoprj.shp"));
    expect(ds[0].crs).toEqual(WGS84);
    expect(ds[0].features).toHaveLength(3);
  });
  it("rejects projected coordinates without .prj", async () => {
    await expect(readDataset(fx("noprj/noprj.shp"))).rejects.toThrow(/doesn't say which coordinate system/);
  });
  it("rejects a garbled .prj naming the file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "geo-"));
    for (const e of ["shp", "shx", "dbf"]) copyFileSync(fx(`bng3/bng3.${e}`), join(dir, `bad.${e}`));
    writeFileSync(join(dir, "bad.prj"), "this is not a projection");
    await expect(readDataset(join(dir, "bad.shp"))).rejects.toThrow(/couldn't understand the coordinate system in bad\.prj/);
  });
  it("reports a missing file plainly", async () => {
    await expect(readDataset(fx("bng3/missing.shp"))).rejects.toThrow(/couldn't open/i);
  });
});
