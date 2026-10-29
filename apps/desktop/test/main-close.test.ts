import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeGuard } from "../src/main/closeGuard.js";
import { IPC } from "../src/shared/geo-app.js";

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

let win: FakeWindow;
let ipc: EventEmitter;
const fromUi = () => ({ sender: win.webContents });
const ready = () => ipc.emit(IPC.closeGuardReady, fromUi());

beforeEach(() => {
  vi.useFakeTimers();
  win = new FakeWindow();
  ipc = new EventEmitter();
  closeGuard(win, ipc, 5000);
});
afterEach(() => { vi.useRealTimers(); });

describe("main asks before closing a dirty project", () => {
  it("closes straight away until the UI has registered its close handler", () => {
    win.close();
    expect(win.closed).toBe(true);
    expect(win.webContents.send).not.toHaveBeenCalled();
  });

  it("asks the UI, waits for its answer, and closes on confirmClose", () => {
    ready();
    win.close();
    expect(win.closed).toBe(false);
    expect(win.webContents.send).toHaveBeenCalledWith(IPC.closeRequest);
    ipc.emit(IPC.closeAck, fromUi()); // the UI is alive and asking the user
    vi.advanceTimersByTime(60_000);
    expect(win.closed).toBe(false);
    ipc.emit(IPC.confirmClose, fromUi());
    expect(win.closed).toBe(true);
  });

  it("closes anyway when the UI doesn't answer within 5 s", () => {
    ready();
    win.close();
    vi.advanceTimersByTime(4999);
    expect(win.closed).toBe(false);
    vi.advanceTimersByTime(1);
    expect(win.closed).toBe(true);
  });

  it("ignores messages from other web contents", () => {
    ipc.emit(IPC.closeGuardReady, { sender: {} });
    win.close();
    expect(win.closed).toBe(true);
  });

  it("forgets the UI's handler on a reload or a crash", () => {
    ready();
    win.webContents.emit("did-start-loading");
    win.close();
    expect(win.closed).toBe(true);

    const w2 = new FakeWindow();
    const ipc2 = new EventEmitter();
    closeGuard(w2, ipc2, 5000);
    ipc2.emit(IPC.closeGuardReady, { sender: w2.webContents });
    w2.webContents.emit("render-process-gone");
    w2.close();
    expect(w2.closed).toBe(true);
  });

  it("removes its IPC listeners once the window has closed", () => {
    ready();
    expect(ipc.listenerCount(IPC.confirmClose)).toBe(1);
    win.close();
    ipc.emit(IPC.confirmClose, fromUi());
    expect(ipc.listenerCount(IPC.closeGuardReady)).toBe(0);
    expect(ipc.listenerCount(IPC.closeAck)).toBe(0);
    expect(ipc.listenerCount(IPC.confirmClose)).toBe(0);
  });
});
