// The window's close guard, kept free of Electron imports so it can be tested with fakes.
import { IPC } from "../shared/geo-app.js";

/** The parts of a BrowserWindow the guard uses. */
export interface GuardWindow {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- must stay compatible with Electron's EventEmitter signatures
  on(event: string, listener: (...args: any[]) => void): unknown;
  close(): void;
  webContents: {
    send(channel: string): void;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- must stay compatible with Electron's EventEmitter signatures
    on(event: string, listener: (...args: any[]) => void): unknown;
  };
}

/** The parts of ipcMain the guard uses. */
export interface GuardIpc {
  on(channel: string, listener: (e: { sender: unknown }) => void): unknown;
  removeListener(channel: string, listener: (e: { sender: unknown }) => void): unknown;
}

/**
 * Once the UI has registered its close handler (geo:closeGuardReady), a close is held back and the UI is asked
 * (geo:closeRequest). It acks at once (geo:closeAck), asks about unsaved changes, and answers with geo:confirmClose.
 * No ack within `timeoutMs` means the UI is stuck or crashed: the window closes anyway, so nobody is trapped.
 * A reload or a renderer crash forgets the handler. The IPC listeners go when the window has closed.
 */
export function closeGuard(win: GuardWindow, ipc: GuardIpc, timeoutMs: number): void {
  let guardReady = false;
  let closing = false;
  let fallback: ReturnType<typeof setTimeout> | null = null;

  const clearFallback = () => { if (fallback) { clearTimeout(fallback); fallback = null; } };
  const forceClose = () => { clearFallback(); closing = true; win.close(); };
  const ours = (e: { sender: unknown }) => e.sender === win.webContents;

  const onReady = (e: { sender: unknown }) => { if (ours(e)) guardReady = true; };
  const onAck = (e: { sender: unknown }) => { if (ours(e)) clearFallback(); };
  const onConfirm = (e: { sender: unknown }) => { if (ours(e) && !closing) forceClose(); };
  ipc.on(IPC.closeGuardReady, onReady);
  ipc.on(IPC.closeAck, onAck);
  ipc.on(IPC.confirmClose, onConfirm);

  win.webContents.on("did-start-loading", () => { guardReady = false; });
  win.webContents.on("render-process-gone", () => { guardReady = false; });

  win.on("close", (e: { preventDefault(): void }) => {
    if (closing || !guardReady) return;
    e.preventDefault();
    clearFallback();
    fallback = setTimeout(forceClose, timeoutMs);
    win.webContents.send(IPC.closeRequest);
  });
  win.on("closed", () => {
    clearFallback();
    ipc.removeListener(IPC.closeGuardReady, onReady);
    ipc.removeListener(IPC.closeAck, onAck);
    ipc.removeListener(IPC.confirmClose, onConfirm);
  });
}
