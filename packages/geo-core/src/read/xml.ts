import { readFile } from "node:fs/promises";
import { DOMParser } from "@xmldom/xmldom";
import type { CrsInfo, Dataset } from "../types.js";
import { WGS84 } from "../crs.js";
import { buildDatasets, type RawFeature } from "./build.js";

/** Shared KML/GPX path: parse XML, convert with togeojson, then reuse the common dataset builder. */
export async function readXmlGeo(
  path: string,
  format: "kml" | "gpx",
  convert: (doc: Document) => { features: RawFeature[] },
): Promise<Dataset[]> {
  const file = path.split(/[\\/]/).pop() ?? path;
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new Error(`Couldn't open ${file}. Check that the file exists and isn't open in another program.`);
  }
  let features: RawFeature[];
  try {
    const errors: string[] = [];
    // xmldom also reports harmless warnings (e.g. a missing space between attributes): only errors fail the read.
    const onError = (level: string, msg: string) => { if (level !== "warning") errors.push(msg); };
    const doc = new DOMParser({ onError }).parseFromString(
      text.replace(/^﻿/, ""),
      "text/xml",
    ) as unknown as Document;
    if (errors.length || !doc.documentElement) throw new Error("bad xml");
    features = convert(doc).features;
  } catch {
    throw new Error(`${file} isn't a valid ${format.toUpperCase()} file (the file couldn't be parsed).`);
  }
  const crs: CrsInfo = WGS84;
  return buildDatasets(features.map(scalarProps), { path, format, crs });
}

/** Keep only simple scalar properties; drop arrays/objects such as coordinateProperties. */
function scalarProps(f: RawFeature): RawFeature {
  const props: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(f.properties ?? {})) {
    if (v === null || ["string", "number", "boolean"].includes(typeof v)) props[k] = v;
  }
  return { ...f, properties: props };
}
