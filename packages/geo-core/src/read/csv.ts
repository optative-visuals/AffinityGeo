// Ported from CavalryGeo (GPL-3.0-or-later), src/core/csv.js
import { readFile } from "node:fs/promises";
import { WGS84 } from "../crs.js";
import type { Dataset } from "../types.js";
import { buildDatasets, type RawFeature } from "./build.js";

const LAT_HEADERS = ["lat", "latitude"];
const LON_HEADERS = ["lon", "lng", "long", "longitude"];

type Delimiter = "," | ";" | "\t";

/** Quoted-field CSV parser (RFC 4180 style) with a configurable delimiter. */
export function parse(text: string, delimiter: Delimiter = ","): { header: string[]; rows: string[][] } {
  let s = String(text || "");
  let rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let q = false;
  let i = 0;
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  while (i < s.length) {
    const c = s.charAt(i);
    if (q) {
      if (c === '"') {
        if (s.charAt(i + 1) === '"') { field += '"'; i += 2; continue; }
        q = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { q = true; i++; continue; }
    if (c === delimiter) { row.push(field); field = ""; i++; continue; }
    if (c === "\r") { i++; continue; }
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
    field += c; i++;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  rows = rows.filter((r) => r.some((c) => c.trim() !== ""));
  return { header: rows.length ? rows[0].map((h) => h.trim()) : [], rows: rows.slice(1) };
}

function sniffDelimiter(text: string): Delimiter {
  const first = text.replace(/^﻿/, "").split(/\r?\n/, 1)[0] ?? "";
  let best: Delimiter = ",";
  let bestCount = -1;
  for (const d of [",", ";", "\t"] as Delimiter[]) {
    const n = first.split(d).length - 1;
    if (n > bestCount) { best = d; bestCount = n; }
  }
  return best;
}

/** Plain numbers, or thousands-separated ones like "1,234,567"; anything else stays a string. */
function parseCell(raw: string | undefined): string | number | null {
  const t = (raw ?? "").trim();
  if (t === "") return null;
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) return Number(t.replace(/,/g, ""));
  if (/^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(t)) {
    const n = Number(t);
    if (Number.isFinite(n)) return n;
  }
  return t;
}

function coord(raw: string | undefined, limit: number): number | null {
  const t = (raw ?? "").trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) && Math.abs(n) <= limit ? n : null;
}

export async function readCsv(path: string): Promise<Dataset[]> {
  const file = path.split(/[\\/]/).pop() ?? path;
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new Error(`Couldn't open ${file}. Check that the file exists and isn't open in another program.`);
  }
  const delimiter: Delimiter = /\.tsv$/i.test(path) ? "\t" : sniffDelimiter(text);
  const table = parse(text, delimiter);
  const find = (names: string[]) => table.header.findIndex((h) => names.includes(h.toLowerCase()));
  const lati = find(LAT_HEADERS);
  const loni = find(LON_HEADERS);
  if (lati < 0 || loni < 0) {
    throw new Error("AffinityGeo couldn't find latitude and longitude columns in this CSV. Name them lat and lon (or latitude and longitude).");
  }
  const features: RawFeature[] = [];
  const badRows: string[] = [];
  table.rows.forEach((r, n) => {
    const lat = coord(r[lati], 90);
    const lon = coord(r[loni], 180);
    if (lat === null || lon === null) {
      badRows.push(`Row ${n + 2} has a missing or invalid latitude/longitude`);
      return;
    }
    const properties: Record<string, unknown> = {};
    table.header.forEach((h, c) => {
      if (h && c !== lati && c !== loni) properties[h] = parseCell(r[c]);
    });
    features.push({ properties, geometry: { type: "Point", coordinates: [lon, lat] } });
  });
  const datasets = buildDatasets(features, { path, format: "csv", crs: WGS84 });
  const d = datasets[0];
  d.report = { read: table.rows.length, skipped: badRows.length, reasons: badRows };
  return datasets;
}
