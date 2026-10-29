import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { closeGuard } from "../src/main/closeGuard.js";
import { installOnClose, installUpdate, shouldRunUpdater, startUpdater, UPDATE_CHECK_EVERY_MS, UPDATE_FIRST_CHECK_MS, updaterLogger } from "../src/main/updater.js";
import { IPC } from "../src/shared/geo-app.js";

/** A stand-in for electron-updater's autoUpdater. */
class FakeUpdater extends EventEmitter {
  autoDownload = false;
  autoInstallOnAppQuit = false;
  checkForUpdates = vi.fn(async () => null as unknown);
  quitAndInstall = vi.fn();
}

/** A stand-in BrowserWindow: close() emits a preventable "close", then "closed" unless prevented. */
class FakeWindow extends EventEmitter {
  webContents = Object.assign(new EventEmitter(), { send: vi.fn() });
  closed = false;
  close(): void {
    let prevented = false;
    this.emit("close", { preventDefault: () => { prevented = true; } });
    if (prevented) return;
    this.closed = true;
    this.emit("closed");
  }
}

let updater: FakeUpdater;
let dialog: { showMessageBox: Mock<(o: object) => Promise<{ response: number }>> };
let log: Mock<(message: string) => void>;
let notify: Mock<(version: string) => void>;
let restart: Mock<() => void>;
let stop: () => void;

function start(answer = 1): void {
  dialog = { showMessageBox: vi.fn(async (_o: object) => ({ response: answer })) };
  stop = startUpdater({ updater, dialog, log, notify, restart }).stop;
}

beforeEach(() => {
  vi.useFakeTimers();
  updater = new FakeUpdater();
  log = vi.fn<(message: string) => void>();
  notify = vi.fn<(version: string) => void>();
  restart = vi.fn<() => void>();
});
afterEach(() => { stop?.(); vi.useRealTimers(); });

describe("automatic updates", () => {
  it("checks after 10 s and every 6 h", () => {
    start();
    expect(UPDATE_FIRST_CHECK_MS).toBe(10_000);
    expect(UPDATE_CHECK_EVERY_MS).toBe(6 * 60 * 60 * 1000);
    expect(updater.autoDownload).toBe(true);
    expect(updater.autoInstallOnAppQuit).toBe(true);
    vi.advanceTimersByTime(9_999);
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(6 * 60 * 60 * 1000);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(6 * 60 * 60 * 1000);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(3);
    stop();
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(3);
  });

  it("a failed update check is logged, not shown", async () => {
    updater.checkForUpdates.mockImplementation(async () => {
      const e = new Error("HttpError: 404 \nHeaders: { \"set-cookie\": [] }");
      updater.emit("error", e);
      throw e;
    });
    start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(log).toHaveBeenCalledTimes(1); // the event and the rejected promise are one failure
    expect(String(log.mock.calls[0]![0])).toContain("404");
    expect(String(log.mock.calls[0]![0])).not.toContain("Headers");
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000); // the next check logs again, once
    expect(log).toHaveBeenCalledTimes(2);
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
  });

  it("update-downloaded notifies and asks once", async () => {
    start();
    updater.emit("update-downloaded", { version: "0.2.0" });
    await vi.advanceTimersByTimeAsync(0);
    expect(notify).toHaveBeenCalledWith("0.2.0");
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);
    expect(dialog.showMessageBox.mock.calls[0]![0]).toMatchObject({
      title: "AffinityGeo 0.2.0 is ready",
      message: "Restart AffinityGeo now to update? Your project is saved first if it has a file; otherwise you'll be asked.",
      buttons: ["Restart now", "Later"],
      defaultId: 0,
      cancelId: 1,
    });
    updater.emit("update-downloaded", { version: "0.2.0" });
    await vi.advanceTimersByTimeAsync(0);
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);
  });

  it("Later never restarts; quit installs", async () => {
    start(1);
    updater.emit("update-downloaded", { version: "0.2.0" });
    await vi.advanceTimersByTimeAsync(0);
    expect(restart).not.toHaveBeenCalled();
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    expect(updater.autoInstallOnAppQuit).toBe(true);
  });

  it("Restart now goes through the unsaved guard then installs", async () => {
    const win = new FakeWindow();
    const ipc = new EventEmitter();
    closeGuard(win, ipc, 5000);
    const fromUi = { sender: win.webContents };
    ipc.emit(IPC.closeGuardReady, fromUi);
    const install = installOnClose(win, ipc, () => installUpdate(updater));
    restart.mockImplementation(() => install.restart());

    start(0);
    updater.emit("update-downloaded", { version: "0.2.0" });
    await vi.advanceTimersByTimeAsync(0);
    expect(restart).toHaveBeenCalledTimes(1);
    // The UI is asked (its unsaved-changes guard runs); nothing installs until it confirms.
    expect(win.webContents.send).toHaveBeenCalledWith(IPC.closeRequest);
    ipc.emit(IPC.closeAck, fromUi);
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    ipc.emit(IPC.confirmClose, fromUi);
    expect(win.closed).toBe(true);
    expect(updater.quitAndInstall).toHaveBeenCalledWith(true, true);
  });

  it("installs silently and relaunches (the assisted installer must not show its wizard)", () => {
    installUpdate(updater);
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(updater.quitAndInstall).toHaveBeenCalledWith(true, true);
  });

  it("cancelling the unsaved question forgets the restart", () => {
    const win = new FakeWindow();
    const ipc = new EventEmitter();
    closeGuard(win, ipc, 5000);
    const fromUi = { sender: win.webContents };
    ipc.emit(IPC.closeGuardReady, fromUi);
    const quitAndInstall = vi.fn();
    const install = installOnClose(win, ipc, quitAndInstall);

    install.restart();
    ipc.emit(IPC.closeAck, fromUi);
    ipc.emit(IPC.closeCancelled, { sender: {} }); // another window's message is ignored
    ipc.emit(IPC.closeCancelled, fromUi);
    // A later ordinary close doesn't relaunch (the update still installs on quit, without a restart).
    win.close();
    ipc.emit(IPC.confirmClose, fromUi);
    expect(win.closed).toBe(true);
    expect(quitAndInstall).not.toHaveBeenCalled();
    expect(ipc.listenerCount(IPC.closeCancelled)).toBe(0);
  });

  it("asks again when a newer version downloads", async () => {
    start();
    updater.emit("update-downloaded", { version: "0.2.0" });
    await vi.advanceTimersByTimeAsync(0);
    updater.emit("update-downloaded", { version: "0.2.0" });
    updater.emit("update-downloaded", { version: "0.3.0" });
    await vi.advanceTimersByTimeAsync(0);
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(2);
    expect(dialog.showMessageBox.mock.calls[1]![0]).toMatchObject({ title: "AffinityGeo 0.3.0 is ready" });
    expect(notify).toHaveBeenLastCalledWith("0.3.0");
  });

  it("titles the dialog without a double space when the version is missing", async () => {
    start();
    updater.emit("update-downloaded", undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(dialog.showMessageBox.mock.calls[0]![0]).toMatchObject({ title: "An AffinityGeo update is ready" });
  });

  it("a reload or a renderer crash forgets a pending restart", () => {
    for (const event of ["did-start-loading", "render-process-gone"]) {
      const win = new FakeWindow();
      win.close = () => {}; // the close is held back, as by the close guard
      const install = vi.fn();
      installOnClose(win, new EventEmitter(), install).restart();
      win.webContents.emit(event);
      win.emit("closed");
      expect(install).not.toHaveBeenCalled();
    }
    // Without a reload the restart still installs.
    const win = new FakeWindow();
    const install = vi.fn();
    installOnClose(win, new EventEmitter(), install).restart();
    expect(install).toHaveBeenCalledTimes(1);
  });

  it("puts the first line of electron-updater's own errors in main.log", () => {
    const logger = updaterLogger(log);
    logger.info("Checking for update");
    logger.warn("careful");
    logger.error(new Error("Cannot download: 404 \nHeaders: { cookie }"));
    logger.error("plain failure\nmore");
    expect(log.mock.calls.map((c) => c[0])).toEqual(["Checking for update", "careful", "Cannot download: 404", "plain failure"]);
  });

  it("runs only when packaged, or in development with GEO_UPDATE_FEED", () => {
    expect(shouldRunUpdater(true, undefined)).toBe(true);
    expect(shouldRunUpdater(false, undefined)).toBe(false);
    expect(shouldRunUpdater(false, "")).toBe(false);
    expect(shouldRunUpdater(false, "http://127.0.0.1:8080/")).toBe(true);
  });
});
