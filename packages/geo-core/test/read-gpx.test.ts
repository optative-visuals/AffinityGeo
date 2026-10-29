import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readDataset } from "../src/read/index.js";

const fx = (p: string) => fileURLToPath(new URL("./fixtures/" + p, import.meta.url));

describe("readDataset gpx", () => {
  it("reads a track as one line and waypoints as points", async () => {
    const ds = await readDataset(fx("track.gpx"));
    expect(ds).toHaveLength(2);
    const line = ds.find((d) => d.kind === "line")!;
    const pts = ds.find((d) => d.kind === "point")!;
    expect(line.sourceFormat).toBe("gpx");
    expect(line.crs.id).toBe("EPSG:4326");
    expect(line.features).toHaveLength(1);
    expect(line.features[0].name).toBe("Thames walk");
    const g = line.features[0].geometry;
    expect(g.type).toBe("LineString");
    expect((g.coordinates as number[][]).length).toBe(50);
    expect((g.coordinates as number[][])[0]).toEqual([-0.12, 51.5]);
    expect(pts.features.map((f) => f.name)).toEqual(["Big Ben", "London Eye"]);
    for (const v of Object.values(line.features[0].attrs)) expect(["string", "number", "boolean", "object"]).toContain(typeof v);
    expect(JSON.stringify(line.features[0].attrs)).not.toContain("[");
  });
});
