import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

export class HomeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HomeError";
  }
}

function userHome(): string {
  return os.homedir().replace(/\\/g, "/");
}

export function resolveHome(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  let home = env.AFFINITYGEO_HOME;
  if (!home) {
    home = platform === "win32" ? "C:\\AffinityGeo" : path.posix.join(userHome(), "AffinityGeo");
  } else if (platform !== "win32" && (home === "~" || home.startsWith("~/"))) {
    home = path.posix.join(userHome(), home.slice(1));
  }
  if (!/^[A-Za-z0-9_\-.:\\/]+$/.test(home)) {
    throw new HomeError(
      `AffinityGeo's folder path can only use plain letters, numbers, - and _ (no spaces or accents): ${home}`,
    );
  }
  return home;
}

/**
 * The text of the "Geo – Connect" script the designer pastes into Affinity: packages/affinity-scripts/loader.js,
 * with the folder swapped in unless it is the default. One source of truth, shared by the app and tools/install-scripts.mjs.
 */
export function loaderText(
  home: string,
  loaderPath: string = fileURLToPath(new URL("../../../packages/affinity-scripts/loader.js", import.meta.url)),
): string {
  const loader = readFileSync(loaderPath, "utf8").replace(/\r\n/g, "\n").trimEnd();
  const fwd = home.replace(/\\/g, "/").replace(/\/+$/, "");
  return fwd.toLowerCase() === "c:/affinitygeo"
    ? loader
    : loader.replace(/require\('.*'\)\.start\(\);/, `require('${fwd}/affinity/connect.js').start({ home: '${fwd}' });`);
}
