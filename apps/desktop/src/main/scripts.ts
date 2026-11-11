// Ships the Affinity scripts with the app and keeps <home>/affinity up to date at every start.
// No Electron imports: tools/install-scripts.mjs reuses ensureScripts.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Scripts earlier versions installed and nothing loads any more (draw.js: the first frame and layer drawer). */
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

/** The text of version.js for a version. */
const versionJs = (version: string): string => `module.exports = ${JSON.stringify(version)};\n`;

/** True when every shipped script and version.js in `dest` matches what ensureScripts would write (a missing file counts as different). */
function installedMatches(srcDir: string, dest: string, files: string[], version: string): boolean {
  const same = (a: string, b: string | Buffer): boolean => {
    try { return readFileSync(a).equals(Buffer.from(b)); } catch { return false; }
  };
  return files.every((f) => same(path.join(dest, f), readFileSync(path.join(srcDir, f)))) && same(path.join(dest, "version.js"), versionJs(version));
}

/**
 * Copies the shipped *.js scripts (not loader.js) into <home>/affinity and writes version.js and VERSION. It copies when VERSION is
 * missing or differs, when `force` is set, or when VERSION matches but the installed files don't: any shipped script's bytes differ from
 * its installed copy (or the copy is missing), or version.js lacks the expected text. So an edited script is picked up while the version
 * number stays the same in development, and a damaged install is repaired. It returns "installed" when there was no VERSION, "updated"
 * when it copied because the version or any file differed (Affinity caches old modules, so the designer must run Geo – Connect again),
 * and "current" when everything already matched, even under `force` (which still rewrites the files). It removes only the names in
 * OBSOLETE and never touches any other file there. Never throws.
 */
export function ensureScripts(home: string, src: { dir: string }, version: string, opts: { force?: boolean } = {}): ScriptsResult {
  try {
    const dest = path.join(home, "affinity");
    const versionFile = path.join(dest, "VERSION");
    let previous: string | null = null;
    try { previous = readFileSync(versionFile, "utf8").trim(); } catch { /* none yet */ }
    const files = readdirSync(src.dir).filter((f) => f.endsWith(".js") && f !== "loader.js"); // the loader text is read from resources, never installed
    const unchanged = previous === version && installedMatches(src.dir, dest, files, version);
    if (unchanged && !opts.force) return { status: "current" };
    mkdirSync(dest, { recursive: true });
    for (const f of files) copyFileSync(path.join(src.dir, f), path.join(dest, f));
    for (const old of OBSOLETE) {
      if (!files.includes(old) && existsSync(path.join(dest, old))) rmSync(path.join(dest, old));
    }
    // version.js is shipped too: connect.js reads it at start and reports it, so the app can tell a re-run Geo – Connect from an old poller.
    writeFileSync(path.join(dest, "version.js"), versionJs(version));
    writeFileSync(versionFile, version);
    return { status: previous === null ? "installed" : unchanged ? "current" : "updated" };
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
