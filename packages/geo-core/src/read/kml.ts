import { kml } from "@tmcw/togeojson";
import type { Dataset } from "../types.js";
import type { RawFeature } from "./build.js";
import { readXmlGeo } from "./xml.js";

export function readKml(path: string): Promise<Dataset[]> {
  return readXmlGeo(path, "kml", (doc) => kml(doc) as unknown as { features: RawFeature[] });
}
