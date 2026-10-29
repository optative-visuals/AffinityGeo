import { gpx } from "@tmcw/togeojson";
import type { Dataset } from "../types.js";
import type { RawFeature } from "./build.js";
import { readXmlGeo } from "./xml.js";

/** Tracks and routes become lines (one feature each), waypoints become points. */
export function readGpx(path: string): Promise<Dataset[]> {
  return readXmlGeo(path, "gpx", (doc) => gpx(doc) as unknown as { features: RawFeature[] });
}
