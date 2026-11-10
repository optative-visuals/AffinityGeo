// Native dialogs (Open, Save, message boxes) would stop a test run: nobody is there to click them.
// These functions run inside the test copy's Electron main process (through Playwright's evaluate) and
// replace the dialogs with answers queued in advance. A dialog with no answer waiting is cancelled and noted.
//
// IMPORTANT: each function is sent to the other process as text, so it must be self-contained:
// no imports and nothing from this file's scope (types are fine: they are erased).

export type DialogKind = "open" | "save" | "message";
export interface DialogAnswer { kind: DialogKind; path?: string; button?: number; cancel?: boolean }
export interface UnansweredDialog { kind: DialogKind | "error"; title: string }

interface DialogState {
  installed: boolean;
  queue: Record<DialogKind, DialogAnswer[]>;
  unanswered: UnansweredDialog[];
}

/** Replaces showOpenDialog, showSaveDialog, showMessageBox and showErrorBox on Electron's dialog module. Safe to call twice. */
export function installDialogStub(electron: { dialog: Record<string, unknown> }): void {
  const g = globalThis as { __geoTestDialogs?: DialogState };
  g.__geoTestDialogs ??= { installed: false, queue: { open: [], save: [], message: [] }, unanswered: [] };
  const state = g.__geoTestDialogs;
  if (state.installed) return;
  state.installed = true;
  // Dialogs are called as (window, options) or (options): the options are always last.
  const optionsOf = (args: unknown[]) => (args[args.length - 1] ?? {}) as { title?: string; message?: string; cancelId?: number };
  const titleOf = (args: unknown[]) => String(optionsOf(args).title ?? optionsOf(args).message ?? "");
  const d = electron.dialog;
  d.showOpenDialog = async (...args: unknown[]) => {
    const a = state.queue.open.shift();
    if (!a) state.unanswered.push({ kind: "open", title: titleOf(args) });
    return !a || a.cancel || !a.path ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [a.path] };
  };
  d.showSaveDialog = async (...args: unknown[]) => {
    const a = state.queue.save.shift();
    if (!a) state.unanswered.push({ kind: "save", title: titleOf(args) });
    return !a || a.cancel || !a.path ? { canceled: true, filePath: "" } : { canceled: false, filePath: a.path };
  };
  d.showMessageBox = async (...args: unknown[]) => {
    const a = state.queue.message.shift();
    if (!a) state.unanswered.push({ kind: "message", title: titleOf(args) });
    const cancelled = optionsOf(args).cancelId ?? 0;
    return { response: !a || a.cancel ? cancelled : a.button ?? 0, checkboxChecked: false };
  };
  d.showErrorBox = (title: unknown, content: unknown) => {
    state.unanswered.push({ kind: "error", title: `${String(title)}: ${String(content)}` });
  };
}

/** Queues the answer for the next dialog of that kind. Returns how many answers now wait for that kind. */
export function queueDialogAnswer(_electron: unknown, a: DialogAnswer): number {
  const g = globalThis as { __geoTestDialogs?: DialogState };
  g.__geoTestDialogs ??= { installed: false, queue: { open: [], save: [], message: [] }, unanswered: [] };
  return g.__geoTestDialogs.queue[a.kind].push(a);
}

/** The dialogs that opened with no answer queued since the last call. */
export function takeUnanswered(): UnansweredDialog[] {
  const state = (globalThis as { __geoTestDialogs?: DialogState }).__geoTestDialogs;
  return state ? state.unanswered.splice(0) : [];
}

/** The line added to a tool's reply for a dialog that had no answer waiting. */
export function unansweredNote(d: UnansweredDialog): string {
  return d.kind === "error"
    ? `The app showed an error box: ${d.title}`
    : `${d.kind === "open" ? "An" : "A"} ${d.kind} dialog ("${d.title}") opened with no answer queued and was cancelled. Queue one with dialog_answer first.`;
}
