import { readFile } from "node:fs/promises";
import { WGS84, crsFromEpsg } from "../crs.js";
import type { CrsInfo, Dataset } from "../types.js";
import { buildDatasets, type RawFeature } from "./build.js";

function fileOf(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function crsFromMember(crs: unknown, file: string): CrsInfo {
  const name = (crs as { properties?: { name?: unknown } } | null)?.properties?.name;
  if (typeof name !== "string") return WGS84;
  if (/CRS84$/i.test(name)) return WGS84;
  const m = /EPSG:+(\d+)$/i.exec(name.trim());
  if (!m) throw new Error(`${file} names a coordinate system ("${name}") that AffinityGeo doesn't recognise.`);
  return crsFromEpsg(Number(m[1]));
}

export async function readGeoJson(path: string): Promise<Dataset[]> {
  const file = fileOf(path);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new Error(`Couldn't open ${file}. Check that the file exists and isn't open in another program.`);
  }
  let json: any;
  try {
    json = JSON.parse(text.replace(/^﻿/, ""));
  } catch {
    throw new Error(`${file} isn't valid GeoJSON (the file couldn't be parsed).`);
  }
  let features: RawFeature[];
  if (json?.type === "FeatureCollection" && Array.isArray(json.features)) features = json.features;
  else if (json?.type === "Feature") features = [json];
  else if (json && typeof json.type === "string" && "coordinates" in json) features = [{ geometry: json, properties: {} }];
  else throw new Error(`${file} isn't valid GeoJSON (expected a FeatureCollection, Feature or geometry).`);
  const crs = crsFromMember(json.crs, file);
  return buildDatasets(features, { path, format: "geojson", crs });
}
