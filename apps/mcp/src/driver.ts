// Starts, watches and stops a test copy of AffinityGeo.
// The copy is the development build (apps/desktop/dist), run in a throwaway profile folder so the
// designer's own recent projects and settings are never touched.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { _electron, type ElectronApplication, type Page } from "playwright-core";
import { installDialogStub } from "./dialogStub.js";
import { exitWhenParentGone } from "./mainHooks.js";
import { ToolError } from "./tool.js";

export interface LaunchOptions { build: boolean; fixtures: boolean }

export interface AppDriver {
  launch(opts: LaunchOptions): Promise<void>;
  quit(): Promise<void>;
  running(): boolean;
  /** Throws a ToolError when the app isn't running. */
  page(): Page;
  /** Throws a ToolError when the app isn't running. */
  electron(): ElectronApplication;
  logs(lines: number): Promise<{ mainLog: string[]; consoleErrors: string[] }>;
  /** AffinityGeo's own version (the desktop package's), not Electron's. */
  version(): string;
}

export const APP_PORT = 8790;
export const NOT_RUNNING = "AffinityGeo isn't running. Call app_launch first.";
export const ALREADY_RUNNING = "AffinityGeo is already running. Call app_quit first.";
export const PORT_BUSY = `Port ${APP_PORT} is in use. Close your own AffinityGeo window, then try again.`;
const START_TIMEOUT_MS = 30_000;
const QUIT_TIMEOUT_MS = 5000;
const MAX_CONSOLE_ERRORS = 200;
const PROFILE_PREFIX = "affinitygeo-test-";
/** How often the test copy checks that this server is still there. */
const PARENT_CHECK_MS = 2000;

/**
 * Removes test profiles a stopped run left behind in `tmpDir`, and returns their names. Only call it when
 * no test copy is running (port 8790 free): a profile in use must stay.
 */
export function removeStaleProfiles(tmpDir: string): string[] {
  const removed: string[] = [];
  let names: string[];
  try { names = readdirSync(tmpDir); } catch { return removed; }
  for (const name of names) {
    if (!name.startsWith(PROFILE_PREFIX)) continue;
    try { rmSync(path.join(tmpDir, name), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); removed.push(name); }
    catch { /* still locked: leave it for next time */ }
  }
  return removed;
}

/** True when nothing is listening on the port. */
export function portFree(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, host, () => probe.close(() => resolve(true)));
  });
}

/** The last `lines` non-empty lines of a text. */
export function tail(text: string, lines: number): string[] {
  return text.split(/\r?\n/).filter((l) => l.trim()).slice(-lines);
}

/** Builds the desktop app. Its output goes to stderr: stdout belongs to the MCP protocol. */
function buildApp(repoRoot: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["apps/desktop/build.mjs"], { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.on("data", (chunk: Buffer) => { output += chunk.toString(); process.stderr.write(chunk); });
    }
    child.once("error", (e) => reject(new ToolError(`The build couldn't start: ${e.message}`)));
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new ToolError(`The build failed:\n${tail(output, 20).join("\n")}`));
    });
  });
}

interface Running { app: ElectronApplication; page: Page; profile: string; logsDir: string; consoleErrors: string[]; closed: Promise<void> }

export function createDriver(repoRoot: string, deps: { spawnBuild?: (cwd: string) => Promise<void> } = {}): AppDriver {
  const build = deps.spawnBuild ?? buildApp;
  let current: Running | null = null;
  let starting = false;

  function removeProfile(profile: string): void {
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
    catch (e) { console.error(`Couldn't remove the test profile ${profile}:`, e); }
  }

  function need(): Running {
    if (!current) throw new ToolError(NOT_RUNNING);
    return current;
  }

  return {
    running: () => current !== null,
    page: () => need().page,
    electron: () => need().app,
    version: () => (JSON.parse(readFileSync(path.join(repoRoot, "apps/desktop/package.json"), "utf8")) as { version: string }).version,

    async launch(opts) {
      if (current || starting) throw new ToolError(ALREADY_RUNNING);
      // Checked first: with the port taken the app would only show an error box nobody can see.
      if (!(await portFree(APP_PORT))) throw new ToolError(PORT_BUSY);
      starting = true;
      let profile: string | null = null;
      let app: ElectronApplication | null = null;
      try {
        if (opts.build) await build(repoRoot);
        if (!existsSync(path.join(repoRoot, "apps/desktop/dist/main.cjs"))) {
          throw new ToolError("AffinityGeo hasn't been built yet. Launch with build: true.");
        }
        // The port is free, so no test copy is running: any profile still here was left by a stopped run.
        removeStaleProfiles(os.tmpdir());
        profile = mkdtempSync(path.join(os.tmpdir(), PROFILE_PREFIX));
        const env: Record<string, string> = {};
        for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
        delete env.AFFINITYGEO_FIXTURE_OSM;
        delete env.AFFINITYGEO_FIXTURE_PLACES;
        if (opts.fixtures) {
          env.AFFINITYGEO_FIXTURE_OSM = path.join(repoRoot, "packages/geo-core/test/project/fixtures/osm-parkland.json");
          env.AFFINITYGEO_FIXTURE_PLACES = path.join(repoRoot, "apps/mcp/fixtures/places.json");
        }
        // The electron package's main export is the path of its executable.
        const executablePath = createRequire(path.join(repoRoot, "package.json"))("electron") as string;
        app = await _electron.launch({
          executablePath, cwd: repoRoot, env, timeout: START_TIMEOUT_MS,
          args: ["apps/desktop/dist/main.cjs", `--user-data-dir=${profile}`],
        });
        const page = await app.firstWindow({ timeout: START_TIMEOUT_MS });
        await page.waitForLoadState("domcontentloaded");
// tsx wraps nested functions in a __name() helper that the app's processes don't have: give them one,
        // so functions sent across (the dialog stub, page scripts) run there.
        await app.evaluate("globalThis.__name ??= (f) => f");
        await page.evaluate("globalThis.__name ??= (f) => f");
        // Nobody is there to click a native dialog: answer them from a queue instead (see dialog_answer).
        // The cast: the stub only needs the dialog module, which Playwright types as the whole of Electron.
        await app.evaluate(installDialogStub as never);
        // If this server is stopped abruptly it can't close the app: the app watches for that and closes itself.
        await app.evaluate(exitWhenParentGone as never, { pid: process.pid, everyMs: PARENT_CHECK_MS });
        const logsDir = await app.evaluate(({ app: a }) => a.getPath("logs"));

        const consoleErrors: string[] = [];
        const keep = (line: string) => { consoleErrors.push(line); if (consoleErrors.length > MAX_CONSOLE_ERRORS) consoleErrors.shift(); };
        page.on("console", (m) => { if (m.type() === "error") keep(m.text()); });
        page.on("pageerror", (e) => keep(`Uncaught: ${e.message}`));

        const mine: Running = { app, page, profile, logsDir, consoleErrors, closed: Promise.resolve() };
        // However the app ends (app_quit, a crash, the window closed by hand), forget it and clear up.
        mine.closed = new Promise<void>((resolve) => {
          app!.once("close", () => {
            if (current === mine) current = null;
            removeProfile(mine.profile);
            resolve();
          });
        });
        current = mine;
      } catch (e) {
        // Kill, not close: a half-started app may be showing a dialog nobody can answer.
        if (app) { try { app.process().kill(); } catch { /* already gone */ } }
        if (profile && !current) removeProfile(profile);
        if (e instanceof ToolError) throw e;
        throw new ToolError(`AffinityGeo couldn't start: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
      } finally {
        starting = false;
      }
    },

    async quit() {
      const mine = current;
      if (!mine) return;
      // app.exit skips the unsaved-changes question on purpose: this is a throwaway copy.
      try { await mine.app.evaluate(({ app: a }) => { setTimeout(() => a.exit(0), 0); }); } catch { /* it may already be closing */ }
      const timedOut = await Promise.race([
        mine.closed.then(() => false),
        new Promise<boolean>((r) => setTimeout(() => r(true), QUIT_TIMEOUT_MS)),
      ]);
      if (timedOut) {
        try { mine.app.process().kill(); } catch { /* already gone */ }
        await Promise.race([mine.closed, new Promise((r) => setTimeout(r, QUIT_TIMEOUT_MS))]);
        if (current === mine) { current = null; removeProfile(mine.profile); }
      }
    },

    async logs(lines) {
      if (!current) return { mainLog: [], consoleErrors: [] };
      const file = path.join(current.logsDir, "main.log");
      const mainLog = existsSync(file) ? tail(readFileSync(file, "utf8"), lines) : [];
      return { mainLog, consoleErrors: current.consoleErrors.slice(-lines) };
    },
  };
}
