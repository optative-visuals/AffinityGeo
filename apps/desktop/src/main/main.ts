// The Electron main process: one window on the companion server, which runs in this process.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, shell, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { autoUpdater } from "electron-updater";
import { resolveHome } from "../../../companion/src/home.js";
import { startServer } from "../../../companion/src/server.js";
import { GITHUB_URL, IPC, type AppSettings, type ThemeMode } from "../shared/geo-app.js";
import { pushRecent } from "../shared/recent.js";
import { cleanSettings, mergeSettings } from "../shared/settings.js";
import { closeGuard } from "./closeGuard.js";
import { windowOpenAction } from "./links.js";
import { listenWithRetry } from "./listenRetry.js";
import { fileLogger } from "./log.js";
import { appMenuTemplate } from "./menu.js";
import { ensureScripts, scriptsNote, scriptsSource, scriptsVersion } from "./scripts.js";
import { installOnClose, installUpdate, shouldRunUpdater, startUpdater, updaterLogger } from "./updater.js";

declare const __GEO_VERSION__: string;

const PORT = 8790;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const PORT_IN_USE = `Port ${PORT} is in use. Close the other AffinityGeo window or app using it.`;
/** A UI that doesn't answer the close request in this time is treated as crashed, and the window closes. */
const CLOSE_TIMEOUT_MS = 5000;

let win: BrowserWindow | null = null;
let server: { close(): Promise<void> } | null = null;
/** "Restart now" for a downloaded update, bound to the current window. */
let restartToUpdate: (() => void) | null = null;
/** The version of an update that has downloaded, for a UI that starts listening late (or reloads). */
let updateReady: string | null = null;

const log = fileLogger(() => app.getPath("logs"));

const recentFile = () => path.join(app.getPath("userData"), "recent.json");

function readRecent(): string[] {
  try {
    const v: unknown = JSON.parse(readFileSync(recentFile(), "utf8"));
    return Array.isArray(v) ? pushRecent(v, "") : [];
  } catch {
    return [];
  }
}

function writeRecent(list: string[]): void {
  try {
    mkdirSync(path.dirname(recentFile()), { recursive: true });
    writeFileSync(recentFile(), JSON.stringify(list, null, 2));
  } catch (e) {
    console.error("Couldn't save the recent projects list:", e);
  }
}

const settingsFile = () => path.join(app.getPath("userData"), "settings.json");

function readSettings(): AppSettings {
  try {
    return cleanSettings(JSON.parse(readFileSync(settingsFile(), "utf8")));
  } catch {
    return cleanSettings(null);
  }
}

function writeSettings(s: AppSettings): void {
  try {
    mkdirSync(path.dirname(settingsFile()), { recursive: true });
    writeFileSync(settingsFile(), JSON.stringify(s, null, 2));
  } catch (e) {
    console.error("Couldn't save the settings:", e);
  }
}

/** Only our own window may call the IPC handlers. */
function fromOurWindow(e: IpcMainEvent | IpcMainInvokeEvent): boolean {
  return !!win && e.sender === win.webContents;
}

function handle(channel: string, fn: (...args: unknown[]) => unknown): void {
  ipcMain.handle(channel, (e, ...args: unknown[]) => {
    if (!fromOurWindow(e)) throw new Error("Not allowed.");
    return fn(...args);
  });
}

function registerIpc(): void {
  handle(IPC.openProject, async () => {
    const r = await dialog.showOpenDialog(win!, {
      title: "Open project", properties: ["openFile"],
      filters: [{ name: "AffinityGeo project", extensions: ["afgeo"] }],
    });
    return r.canceled ? null : r.filePaths[0] ?? null;
  });
  handle(IPC.saveProjectAs, async (suggested) => {
    const r = await dialog.showSaveDialog(win!, {
      title: "Save project", ...(typeof suggested === "string" ? { defaultPath: suggested } : {}),
      filters: [{ name: "AffinityGeo project", extensions: ["afgeo"] }],
    });
    return r.canceled ? null : r.filePath ?? null;
  });
  handle(IPC.openDataFile, async () => {
    const r = await dialog.showOpenDialog(win!, {
      title: "Use a data file", properties: ["openFile"],
      filters: [
        { name: "Map data", extensions: ["shp", "geojson", "json", "kml", "gpx", "csv"] },
        { name: "All files", extensions: ["*"] },
      ],
    });
    return r.canceled ? null : r.filePaths[0] ?? null;
  });
  handle(IPC.copyText, (text) => { clipboard.writeText(String(text)); });
  handle(IPC.setTheme, (mode) => {
    const m: ThemeMode = mode === "light" || mode === "dark" ? mode : "system";
    nativeTheme.themeSource = m;
  });
  handle(IPC.recent, () => readRecent());
  handle(IPC.addRecent, (p) => {
    if (typeof p !== "string") return readRecent();
    const list = pushRecent(readRecent(), p);
    writeRecent(list);
    return list;
  });
  handle(IPC.settings, () => readSettings());
  handle(IPC.saveSettings, (patch) => {
    const next = mergeSettings(readSettings(), patch);
    writeSettings(next);
    return next;
  });
  // Only the project page: the UI can't be talked into opening anything else.
  handle(IPC.openExternal, async (url) => {
    if (url !== GITHUB_URL) throw new Error("Not allowed.");
    await shell.openExternal(GITHUB_URL);
  });
  handle(IPC.updateStatus, () => updateReady);
  ipcMain.on(IPC.restartToUpdate, (e) => { if (fromOurWindow(e)) restartToUpdate?.(); });
}

function createWindow(): void {
  const w = new BrowserWindow({
    width: 1280, height: 800, minWidth: 1024, minHeight: 680,
    title: "AffinityGeo", backgroundColor: "#141414", show: false, autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true, sandbox: true, nodeIntegration: false,
      additionalArguments: [`--geo-version=${__GEO_VERSION__}`],
    },
  });
  win = w;
  nativeTheme.themeSource = readSettings().appearance; // the stored Appearance from the first frame
  w.once("ready-to-show", () => w.show());

  // Stay on the app's own pages; the only web page that may open (in the browser) is the GitHub project.
  w.webContents.on("will-navigate", (e, url) => { if (!url.startsWith(`${ORIGIN}/`)) e.preventDefault(); });
  w.webContents.setWindowOpenHandler(({ url }) => windowOpenAction(url, (u) => { void shell.openExternal(u); }));

  // Close guard: ask the UI first (unsaved changes); a UI that doesn't answer within 5 s doesn't trap the user.
  // Its IPC listeners only accept this window's messages and are removed when the window closes.
  closeGuard(w, ipcMain, CLOSE_TIMEOUT_MS);
  // "Restart now" closes through that same guard; the update installs once the window has really closed.
  restartToUpdate = installOnClose(w, ipcMain, () => installUpdate(autoUpdater)).restart;
  w.on("closed", () => { win = null; restartToUpdate = null; });

  void w.loadURL(`${ORIGIN}/`);
}

function installScripts(): { home?: string; scripts?: { loaderPath: string; note: string | null; untilConnected: boolean; version: string } } {
  let home: string;
  try { home = resolveHome(); } catch { return {}; } // the scripts route reports a bad folder itself
  const src = scriptsSource({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, repoRoot: path.resolve(__dirname, "../../..") });
  const version = scriptsVersion({
    isPackaged: app.isPackaged, appVersion: app.getVersion(),
    rootVersion: () => (JSON.parse(readFileSync(path.resolve(__dirname, "../../../package.json"), "utf8")) as { version: string }).version,
  });
  const result = ensureScripts(home, src, version);
  if (result.status === "failed") console.error("Couldn't install the Affinity scripts:", result.reason);
  return { home, scripts: { loaderPath: src.loader, note: scriptsNote(result, home), untilConnected: result.status === "updated", version } };
}

async function start(): Promise<void> {
  try {
    // Install or update the Affinity scripts first, so Affinity always runs the version that matches this app.
    const options = { port: PORT, uiDir: path.join(__dirname, "ui"), ...installScripts() };
    // A just-closed AffinityGeo may still be releasing the port: wait up to 5 s before giving up.
    server = await listenWithRetry(() => startServer(options), {
      tries: 10, delayMs: 500, sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    dialog.showErrorBox("AffinityGeo", code === "EADDRINUSE" ? PORT_IN_USE : `AffinityGeo couldn't start: ${(e as Error).message}`);
    app.quit();
    return;
  }
  // No File/Edit/View/Window bar: the app's own top bar has every command.
  const template = appMenuTemplate(process.platform);
  Menu.setApplicationMenu(template ? Menu.buildFromTemplate(template) : null);
  registerIpc();
  createWindow();
  runUpdater();
}

/**
 * Background updates from GitHub releases (app-update.yml, generated from electron-builder.yml's publish).
 * Not in development, unless GEO_UPDATE_FEED names a generic feed (used to test the updater). A failed check, such as
 * the 404 while the repository is private, is only logged.
 */
function runUpdater(): void {
  const feed = process.env.GEO_UPDATE_FEED;
  if (!shouldRunUpdater(app.isPackaged, feed)) return;
  if (feed) {
    autoUpdater.setFeedURL({ provider: "generic", url: feed });
    autoUpdater.forceDevUpdateConfig = !app.isPackaged; // let an unpackaged run check this feed
    log(`Updates come from ${feed} (GEO_UPDATE_FEED).`);
  }
  // Progress goes to main.log, and so does the first line of electron-updater's own errors.
  autoUpdater.logger = updaterLogger(log);
  startUpdater({
    updater: autoUpdater,
    dialog: { showMessageBox: (o) => (win ? dialog.showMessageBox(win, o) : dialog.showMessageBox(o)) },
    log,
    notify: (version) => {
      updateReady = version;
      win?.webContents.send(IPC.updateReady, version);
    },
    restart: () => restartToUpdate?.(),
  });
}

if (!app.requestSingleInstanceLock()) {
  // Another AffinityGeo is running: it gets 'second-instance' and comes to the front.
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.on("window-all-closed", () => {
    void (server?.close() ?? Promise.resolve()).finally(() => app.quit());
  });
  void app.whenReady().then(start);
}
