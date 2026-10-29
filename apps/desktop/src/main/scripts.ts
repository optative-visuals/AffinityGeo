// Ships the Affinity scripts with the app and keeps <home>/affinity up to date at every start.
// No Electron imports: tools/install-scripts.mjs reuses ensureScripts.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Scripts earlier versions installed and nothing loads any more (draw.js: the 1a frame/layer drawer). */
export const OBSOLETE = ["draw.js"];

export type ScriptsResult = { status: "installed" | "updated" | "current" | "failed"; reason?: string };

/** Where the scripts to install come from: the app's resources once packaged, the repo while developing. */
export function scriptsSource(o: { isPackaged: boolean; resourcesPath: string; repoRoot: string }): { dir: string; loader: string } {
  const dir = o.isPackaged
    ? path.join(o.resourcesPath, "affinity-scripts")
    : path.join(o.repoRoot, "packages", "affinity-scripts", "src");
  const loader = o.isPackaged
    ? path.join(o.resourcesPath, "affinity-scripts", "loader.js")
    : path.join(o.repoRoot, "packages", "affinity-scripts", "loader.js");
  return { dir, loader };
}

/**
 * The version scripts are stamped with. A development run (npm run app) reports Electron's own version from
 * app.getVersion(), so it uses the repo's root package.json instead: switching between a dev run and the
 * installed app then doesn't rewrite the scripts and show "Scripts updated" each time.
 */
export function scriptsVersion(o: { isPackaged: boolean; appVersion: string; rootVersion: () => string }): string {
  if (o.isPackaged) return o.appVersion;
  try { return o.rootVersion(); } catch { return o.appVersion; }
}

/**
 * Copies the shipped *.js scripts (not loader.js) into <home>/affinity and writes VERSION, only when VERSION is missing or differs
 * (or `force`). It removes only the names in OBSOLETE and never touches any other file there. Never throws.
 */
export function ensureScripts(home: string, src: { dir: string }, version: string, opts: { force?: boolean } = {}): ScriptsResult {
  try {
    const dest = path.join(home, "affinity");
    const versionFile = path.join(dest, "VERSION");
    let previous: string | null = null;
    try { previous = readFileSync(versionFile, "utf8").trim(); } catch { /* none yet */ }
    if (previous === version && !opts.force) return { status: "current" };
    const files = readdirSync(src.dir).filter((f) => f.endsWith(".js") && f !== "loader.js"); // the loader text is read from resources, never installed
    mkdirSync(dest, { recursive: true });
    for (const f of files) copyFileSync(path.join(src.dir, f), path.join(dest, f));
    for (const old of OBSOLETE) {
      if (!files.includes(old) && existsSync(path.join(dest, old))) rmSync(path.join(dest, old));
    }
    // version.js is shipped too: connect.js reads it at start and reports it, so the app can tell a re-run Geo – Connect from an old poller.
    writeFileSync(path.join(dest, "version.js"), `module.exports = ${JSON.stringify(version)};\n`);
    writeFileSync(versionFile, version);
    return { status: previous === null ? "installed" : "updated" };
  } catch (e) {
    return { status: "failed", reason: (e as Error).message };
  }
}

/** What the designer should be told about the result, or null when there is nothing to say. */
export function scriptsNote(r: ScriptsResult, home: string): string | null {
  if (r.status === "updated") return "Scripts updated. In Affinity, run Geo – Connect again.";
  if (r.status === "failed") {
    const sep = home.includes("\\") ? "\\" : "/";
    return `Scripts couldn't be installed in ${home.replace(/[\\/]+$/, "")}${sep}affinity: ${r.reason ?? "unknown error"}`;
  }
  return null;
}
