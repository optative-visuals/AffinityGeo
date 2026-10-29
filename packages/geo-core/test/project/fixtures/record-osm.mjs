// One-off: records a real Overpass response for a small small area (Hyde Park around the Serpentine, London).
// Not run by tests. Usage (from the repo root): npx tsx packages/geo-core/test/project/fixtures/record-osm.mjs
import { writeFileSync } from "node:fs";
import { buildOverpassQuery, USER_AGENT } from "../../../src/project/osm.ts";

const bbox = [-0.1715, 51.5023, -0.1615, 51.5077]; // west, south, east, north (about 0.4 km2)
const res = await fetch("https://overpass-api.de/api/interpreter", {
  method: "POST",
  headers: { "User-Agent": USER_AGENT, "Content-Type": "application/x-www-form-urlencoded" },
  body: "data=" + encodeURIComponent(buildOverpassQuery(bbox)),
});
if (!res.ok) throw new Error("Overpass answered " + res.status);
const text = await res.text();
writeFileSync(new URL("./osm-parkland.json", import.meta.url), text);
console.log("saved", text.length, "bytes");
