import type { Dataset } from "../types.js";
import { readGeoJson } from "./geojson.js";
import { readShapefile } from "./shapefile.js";
import { readKml } from "./kml.js";
import { readGpx } from "./gpx.js";
import { readCsv } from "./csv.js";

export async function readDataset(path: string): Promise<Dataset[]> {
  const ext = (/\.([^.\\/]+)$/.exec(path)?.[1] ?? "").toLowerCase();
  switch (ext) {
    case "geojson":
    case "json":
      return readGeoJson(path);
    case "shp":
      return readShapefile(path);
    case "kml":
      return readKml(path);
    case "gpx":
      return readGpx(path);
    case "csv":
    case "tsv":
      return readCsv(path);
    default: {
      const file = path.split(/[\\/]/).pop() ?? path;
      throw new Error(`AffinityGeo can't read .${ext} files yet (${file}). Supported: GeoJSON, Shapefile, KML, GPX and CSV.`);
    }
  }
}
