import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readDataset } from "../src/read/index.js";

const fx = (p: string) => fileURLToPath(new URL("./fixtures/" + p, import.meta.url));

describe("readDataset kml", () => {
  it("reads points and polygons with ExtendedData as attrs", async () => {
    const ds = await readDataset(fx("places.kml"));
    expect(ds.map((d) => d.kind).sort()).toEqual(["point", "polygon"]);
    const pts = ds.find((d) => d.kind === "point")!;
    const poly = ds.find((d) => d.kind === "polygon")!;
    expect(pts.sourceFormat).toBe("kml");
    expect(pts.features).toHaveLength(2);
    expect(pts.features[0].name).toBe("Cafe One");
    expect(pts.features[0].attrs.seats).toBe("12");
    expect(poly.features[0].name).toBe("Green Park");
    expect(poly.features[0].attrs.owner).toBe("Crown");
    expect(poly.features[0].attrs.hectares).toBe("19");
    expect(poly.features[0].geometry.type).toBe("Polygon");
    expect((poly.features[0].geometry.coordinates as number[][][])[0][0]).toEqual([-0.145, 51.504]);
  });
});
