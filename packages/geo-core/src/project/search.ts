// Ported from CavalryGeo (GPL-3.0-or-later), src/core/search.js: the Nominatim request path and response parsing.
import type { Bbox, Geometry } from "../types.js";
import { DataError, USER_AGENT } from "./osm.js";

export interface PlaceResult { name: string; bboxWgs84: Bbox; centre: [number, number]; outline?: Geometry }

const BASE = "https://nominatim.openstreetmap.org";
const BUSY = "Place search is busy right now. Try again in a moment.";
const MIN_GAP_MS = 1000; // Nominatim's usage policy: at most one request per second
let lastCall = -Infinity;

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function searchPath(query: string): string {
  return "/search?format=jsonv2&limit=5&accept-language=en&polygon_geojson=1&polygon_threshold=0.0005&q=" + encodeURIComponent(query);
}

export function parseSearch(json: unknown): PlaceResult[] {
  if (!Array.isArray(json)) return [];
  const out: PlaceResult[] = [];
  for (const r of json as Array<Record<string, unknown>>) {
    const lat = Number(r.lat), lon = Number(r.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const b = Array.isArray(r.boundingbox) && r.boundingbox.length === 4 ? r.boundingbox.map(Number) : [lat, lat, lon, lon];
    if (b.some((v) => !Number.isFinite(v))) continue;
    // Nominatim orders it south, north, west, east; geo-core uses west, south, east, north.
    const place: PlaceResult = { name: String(r.display_name ?? ""), bboxWgs84: [b[2], b[0], b[3], b[1]], centre: [lon, lat] };
    const g = r.geojson as { type?: unknown; coordinates?: unknown } | undefined;
    if (g && (g.type === "Polygon" || g.type === "MultiPolygon") && Array.isArray(g.coordinates)) place.outline = g as Geometry;
    out.push(place);
  }
  return out;
}

export async function searchPlaces(
  q: string, fetchImpl: typeof fetch = fetch, now: () => number = Date.now, sleep: (ms: number) => Promise<void> = realSleep,
): Promise<PlaceResult[]> {
  const query = q.trim();
  if (!query) return [];
  const wait = lastCall + MIN_GAP_MS - now();
  if (wait > 0) await sleep(wait);
  lastCall = now();
  let res: Response;
  try {
    res = await fetchImpl(BASE + searchPath(query), { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
  } catch { throw new DataError(BUSY); }
  if (!res.ok) throw new DataError(BUSY);
  let json: unknown;
  try { json = await res.json(); } catch { throw new DataError(BUSY); }
  return parseSearch(json);
}
