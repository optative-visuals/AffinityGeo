// Development only: answer map-data requests from recorded files instead of the internet, so a test run
// (see apps/mcp) works offline and gives the same result every time. A packaged app ignores these variables.
import { parseOverpass, type PlaceResult } from "@affinitygeo/geo-core";
import type { ServerOptions } from "../../../companion/src/server.js";

/**
 * AFFINITYGEO_FIXTURE_OSM: a recorded Overpass reply (JSON) used for every data fetch.
 * AFFINITYGEO_FIXTURE_PLACES: a JSON list of places returned for every place search.
 * The files are read when first needed, so a wrong path fails that request and not the app's start.
 */
export function fixtureOptions(
  env: Record<string, string | undefined>, isPackaged: boolean, read: (file: string) => string,
): Pick<ServerOptions, "fetchOsm" | "searchPlaces"> {
  if (isPackaged) return {};
  const out: Pick<ServerOptions, "fetchOsm" | "searchPlaces"> = {};
  const osm = env.AFFINITYGEO_FIXTURE_OSM;
  const places = env.AFFINITYGEO_FIXTURE_PLACES;
  if (osm) out.fetchOsm = async () => parseOverpass(JSON.parse(read(osm)));
  if (places) out.searchPlaces = async (q) => (q.trim() ? (JSON.parse(read(places)) as PlaceResult[]) : []);
  return out;
}
