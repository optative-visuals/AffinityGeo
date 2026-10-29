// Copies the Affinity scripts into <AFFINITYGEO_HOME>/affinity so the loader can require them (the developer's copy of what the app does at start).
// Run with: npm run install-scripts   (node --import tsx tools/install-scripts.mjs)
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveHome, HomeError, loaderText } from "../apps/companion/src/home.ts";
import { ensureScripts } from "../apps/desktop/src/main/scripts.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = path.join(root, "packages", "affinity-scripts", "src");
const version = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;

let home;
try {
  home = resolveHome();
} catch (e) {
  console.error(e instanceof HomeError ? e.message : String(e));
  process.exit(1);
}

const r = ensureScripts(home, { dir: srcDir }, version, { force: true });
if (r.status === "failed") {
  console.error(`Couldn't install the scripts in ${path.join(home, "affinity")}: ${r.reason}`);
  process.exit(1);
}
console.log(`Copied the scripts to ${path.join(home, "affinity")} (${r.status}).`);
// One source of truth: packages/affinity-scripts/loader.js, with the folder swapped in if it isn't the default.
const text = loaderText(home);
console.log("\nIn Affinity, create a NEW script in the Script Editor, paste exactly this, and run it:\n");
console.log(text);
