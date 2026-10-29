// Downloads the large acceptance fixtures into fixtures-large/ (gitignored).
// Idempotent: anything already extracted is skipped. Run: npm run fetch-fixtures
//
// Zip reading comes from geo-core (packages/geo-core/src/project/zip.ts). Run via: npm run fetch-fixtures
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { readZip } from "../packages/geo-core/src/project/zip.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "fixtures-large");

const FIXTURES = [
  {
    name: "Natural Earth 1:50m admin-0 countries",
    dir: "ne_50m_admin_0_countries",
    url: "https://naciscdn.org/naturalearth/50m/cultural/ne_50m_admin_0_countries.zip",
    stem: "ne_50m_admin_0_countries",
  },
  {
    name: "ONS Countries (December 2023) Boundaries UK BUC (EPSG:27700)",
    dir: "ons_ctry_dec_2023_uk_buc",
    // Resolved 2026-10-27 from the ONS Open Geography Portal item
    // "Countries (December 2023) Boundaries UK BUC" (ArcGIS item id
    // 5b71688395b34f7a8cb1bd1e1eaade3c, layer 0) via the ArcGIS Hub download API.
    // It redirects to a ready-made zip; spatialRefId=27700 keeps British National Grid.
    url: "https://hub.arcgis.com/api/v3/datasets/5b71688395b34f7a8cb1bd1e1eaade3c_0/downloads/data?format=shp&spatialRefId=27700",
    stem: "CTRY_DEC_2023_UK_BUC",
  },
];

async function fetchFixture(fx) {
  const dir = join(OUT, fx.dir);
  const needed = ["shp", "dbf", "prj"].map((e) => `${fx.stem}.${e}`);
  if (needed.every((f) => existsSync(join(dir, f)))) {
    console.log(`[skip] ${fx.name}: already in fixtures-large/${fx.dir}`);
    return;
  }
  console.log(`[get]  ${fx.name}`);
  console.log(`       ${fx.url}`);
  const res = await fetch(fx.url, { redirect: "follow" });
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status} for ${fx.url}`);
  const zip = Buffer.from(await res.arrayBuffer());
  console.log(`       downloaded ${(zip.length / 1024).toFixed(0)} KiB`);
  mkdirSync(dir, { recursive: true });
  for (const e of readZip(new Uint8Array(zip))) {
    const target = join(dir, basename(e.name)); // flatten; never trust entry paths
    writeFileSync(target, e.data);
    console.log(`       extracted ${basename(e.name)} (${e.data.length} bytes)`);
  }
  for (const f of needed) {
    if (!existsSync(join(dir, f))) throw new Error(`Expected ${f} in the archive for ${fx.name} but it is missing.`);
  }
  console.log(`[ok]   ${fx.name}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  mkdirSync(OUT, { recursive: true });
  for (const fx of FIXTURES) await fetchFixture(fx);
  console.log("All fixtures present in fixtures-large/.");
}
