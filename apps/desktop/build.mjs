// Builds the desktop app into dist/: main.cjs (Electron main + the companion server), preload.cjs and ui/.
// Run: node apps/desktop/build.mjs (or npm run build:app). Exits non-zero on any error.
import { copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, "dist");
const version = JSON.parse(readFileSync(path.join(here, "package.json"), "utf8")).version;
const define = { __GEO_VERSION__: JSON.stringify(version) };

const node = {
  bundle: true, platform: "node", format: "cjs", target: "node22", external: ["electron"],
  logLevel: "warning", sourcemap: "linked",
};

try {
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(path.join(dist, "ui"), { recursive: true });

  await Promise.all([
    build({
      ...node,
      entryPoints: [path.join(here, "src/main/main.ts")],
      outfile: path.join(dist, "main.cjs"),
      // The companion's home.ts finds loader.js relative to import.meta.url, which a CJS bundle lacks.
      // dist/main.cjs sits at the same depth as apps/companion/src/home.ts, so the relative path still works.
      banner: { js: 'const __geoImportMetaUrl = require("node:url").pathToFileURL(__filename).href;' },
      define: { ...define, "import.meta.url": "__geoImportMetaUrl" },
    }),
    build({
      ...node,
      entryPoints: [path.join(here, "src/main/preload.ts")],
      outfile: path.join(dist, "preload.cjs"),
      sourcemap: false,
    }),
    build({
      entryPoints: [path.join(here, "src/ui/main.tsx")],
      outdir: path.join(dist, "ui"),
      entryNames: "app",
      bundle: true, platform: "browser", format: "esm", target: "chrome130",
      jsx: "automatic", minify: true, logLevel: "warning",
      define: { ...define, "process.env.NODE_ENV": '"production"' },
    }),
  ]);
  copyFileSync(path.join(here, "src/ui/index.html"), path.join(dist, "ui/index.html"));
  console.log(`Built AffinityGeo ${version} into ${path.relative(process.cwd(), dist) || "."}`);
} catch (e) {
  // esbuild has already printed the details.
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
