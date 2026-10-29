// Automatic updates from GitHub releases, kept free of Electron imports so it can be tested with fakes.
// electron-updater downloads in the background; the user is asked once before restarting, and "Later" installs on quit.
import { IPC } from "../shared/geo-app.js";
import type { GuardIpc, GuardWindow } from "./closeGuard.js";

export const UPDATE_FIRST_CHECK_MS = 10_000;
export const UPDATE_CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

/** The parts of electron-updater's autoUpdater used here. */
export interface Updater {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  checkForUpdates(): Promise<unknown>;
  on(event: string, listener: (...args: any[]) => void): unknown;
  removeListener(event: string, listener: (...args: any[]) => void): unknown;
}

/** dialog.showMessageBox, already bound to the window. */
export interface UpdateDialog {
  showMessageBox(options: {
    type: "info"; title: string; message: string; buttons: string[]; defaultId: number; cancelId: number; noLink: boolean;
  }): Promise<{ response: number }>;
}

export interface UpdaterDeps {
  updater: Updater;
  dialog: UpdateDialog;
  /** Where failures go (main.log and the console). Never a dialog. */
  log: (message: string) => void;
  /** An update has downloaded: tell the status bar. */
  notify: (version: string) => void;
  /** "Restart now": close through the unsaved-changes guard, then install (see installOnClose). */
  restart: () => void;
}

/** Packaged builds update themselves; a development run only with GEO_UPDATE_FEED (the acceptance test's feed). */
export function shouldRunUpdater(isPackaged: boolean, feed: string | undefined): boolean {
  return isPackaged || !!feed;
}

const firstLine = (m: unknown): string => String(m instanceof Error ? m.message : m).split("\n")[0]!.trim();

/** electron-updater's own logger, into main.log. Errors can carry whole HTTP responses: only their first line is kept. */
export function updaterLogger(log: (message: string) => void) {
  return { info: (m: unknown) => log(String(m)), warn: (m: unknown) => log(String(m)), error: (m: unknown) => log(firstLine(m)) };
}

export function startUpdater({ updater, dialog, log, notify, restart }: UpdaterDeps): { stop(): void } {
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true; // "Later": the update installs on the next quit

  let loggedThisCheck = false;
  const asked = new Set<string>(); // versions already asked about: a newer download asks again
  const fail = (e: unknown) => {
    if (loggedThisCheck) return; // the error event and the rejected promise are the same failure
    loggedThisCheck = true;
    // electron-updater's HTTP errors carry the whole response (headers, cookies): the first line is enough.
    log(`Update check failed: ${firstLine(e)}`);
  };

  const onError = (e: unknown) => fail(e);
  const onDownloaded = (info: { version?: string } | undefined) => {
    const version = String(info?.version ?? "");
    notify(version);
    if (asked.has(version)) return;
    asked.add(version);
    dialog.showMessageBox({
      type: "info",
      title: version ? `AffinityGeo ${version} is ready` : "An AffinityGeo update is ready",
      message: "Restart AffinityGeo now to update? Your project is saved first if it has a file; otherwise you'll be asked.",
      buttons: ["Restart now", "Later"],
      defaultId: 0, cancelId: 1, noLink: true,
    }).then(({ response }) => { if (response === 0) restart(); }, (e) => log(`Couldn't ask about the update: ${String(e)}`));
  };
  updater.on("error", onError);
  updater.on("update-downloaded", onDownloaded);

  const check = () => {
    loggedThisCheck = false;
    try {
      updater.checkForUpdates().catch(fail);
    } catch (e) {
      fail(e);
    }
  };
  let every: ReturnType<typeof setInterval> | null = null;
  const first = setTimeout(() => {
    check();
    every = setInterval(check, UPDATE_CHECK_EVERY_MS);
  }, UPDATE_FIRST_CHECK_MS);

  return {
    stop() {
      clearTimeout(first);
      if (every) clearInterval(every);
      updater.removeListener("error", onError);
      updater.removeListener("update-downloaded", onDownloaded);
    },
  };
}

/** What "Restart now" runs: silent (no wizard pages, even with the assisted installer) and relaunch afterwards. */
export function installUpdate(updater: { quitAndInstall(isSilent: boolean, isForceRunAfter: boolean): void }): void {
  updater.quitAndInstall(true, true);
}

/**
 * "Restart now" closes the window exactly as its close button does, so the close guard asks about unsaved changes.
 * Once the window has really closed, `install()` runs (installUpdate(autoUpdater)).
 * If the user stays (the UI sends geo:closeCancelled), the restart is forgotten.
 */
export function installOnClose(win: GuardWindow, ipc: GuardIpc, install: () => void): { restart(): void } {
  let installOnClose = false;
  const onCancelled = (e: { sender: unknown }) => { if (e.sender === win.webContents) installOnClose = false; };
  ipc.on(IPC.closeCancelled, onCancelled);
  // A reload or a renderer crash forgets the pending restart, as the close guard forgets its handler.
  win.webContents.on("did-start-loading", () => { installOnClose = false; });
  win.webContents.on("render-process-gone", () => { installOnClose = false; });
  win.on("closed", () => {
    ipc.removeListener(IPC.closeCancelled, onCancelled);
    if (installOnClose) install();
  });
  return {
    restart() {
      installOnClose = true;
      win.close();
    },
  };
}
