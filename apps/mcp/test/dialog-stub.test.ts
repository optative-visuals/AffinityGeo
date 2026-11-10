import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../src/apiClient.js";
import { installDialogStub, queueDialogAnswer, takeUnanswered, unansweredNote } from "../src/dialogStub.js";
import type { AppDriver } from "../src/driver.js";
import { dialogAnswer, dialogNotes } from "../src/tools/data.js";
import { ToolError, type ToolContext } from "../src/tool.js";

type Fn = (...args: unknown[]) => Promise<unknown>;
let e: { dialog: Record<string, Fn> };

beforeEach(() => {
  delete (globalThis as { __geoTestDialogs?: unknown }).__geoTestDialogs;
  e = { dialog: {} };
  installDialogStub(e);
});

describe("the dialog stub", () => {
  it("answers an open dialog from the queue, then cancels the next one", async () => {
    expect(queueDialogAnswer(null, { kind: "open", path: "C:/t/hyde.afgeo" })).toBe(1);
    expect(await e.dialog.showOpenDialog!({}, { title: "Open project" })).toEqual({ canceled: false, filePaths: ["C:/t/hyde.afgeo"] });
    expect(await e.dialog.showOpenDialog!({}, { title: "Open project" })).toEqual({ canceled: true, filePaths: [] });
    expect(takeUnanswered()).toEqual([{ kind: "open", title: "Open project" }]);
    expect(takeUnanswered()).toEqual([]);
  });
  it("works when the window argument is left out", async () => {
    await e.dialog.showOpenDialog!({ title: "Use a data file" });
    expect(takeUnanswered()).toEqual([{ kind: "open", title: "Use a data file" }]);
  });
  it("answers a save dialog", async () => {
    queueDialogAnswer(null, { kind: "save", path: "C:/t/new.afgeo" });
    expect(await e.dialog.showSaveDialog!({}, { title: "Save project" })).toEqual({ canceled: false, filePath: "C:/t/new.afgeo" });
    expect(await e.dialog.showSaveDialog!({}, { title: "Save project" })).toEqual({ canceled: true, filePath: "" });
  });
  it("keeps the answers for each kind apart, in order", async () => {
    queueDialogAnswer(null, { kind: "save", path: "s1" });
    queueDialogAnswer(null, { kind: "open", path: "o1" });
    expect(queueDialogAnswer(null, { kind: "open", path: "o2" })).toBe(2);
    expect(await e.dialog.showOpenDialog!({})).toEqual({ canceled: false, filePaths: ["o1"] });
    expect(await e.dialog.showOpenDialog!({})).toEqual({ canceled: false, filePaths: ["o2"] });
    expect(await e.dialog.showSaveDialog!({})).toEqual({ canceled: false, filePath: "s1" });
  });
  it("a queued cancel is honoured and not reported as unanswered", async () => {
    queueDialogAnswer(null, { kind: "open", cancel: true });
    expect(await e.dialog.showOpenDialog!({}, { title: "Open project" })).toEqual({ canceled: true, filePaths: [] });
    expect(takeUnanswered()).toEqual([]);
  });
  it("message boxes return the queued button, or cancelId when unanswered", async () => {
    queueDialogAnswer(null, { kind: "message", button: 1 });
    expect(await e.dialog.showMessageBox!({}, { message: "Restart now?", cancelId: 2 })).toEqual({ response: 1, checkboxChecked: false });
    expect(await e.dialog.showMessageBox!({}, { message: "Restart now?", cancelId: 2 })).toEqual({ response: 2, checkboxChecked: false });
    expect(await e.dialog.showMessageBox!({ message: "No cancel button" })).toEqual({ response: 0, checkboxChecked: false });
    expect(takeUnanswered()).toEqual([{ kind: "message", title: "Restart now?" }, { kind: "message", title: "No cancel button" }]);
  });
  it("showErrorBox is recorded and returns at once", () => {
    expect((e.dialog.showErrorBox as unknown as (a: string, b: string) => void)("AffinityGeo", "Port 8790 is in use.")).toBeUndefined();
    expect(takeUnanswered()).toEqual([{ kind: "error", title: "AffinityGeo: Port 8790 is in use." }]);
  });
  it("installing twice keeps the queue and the same stubs", async () => {
    queueDialogAnswer(null, { kind: "open", path: "kept" });
    const before = e.dialog.showOpenDialog;
    installDialogStub(e);
    expect(e.dialog.showOpenDialog).toBe(before);
    expect(await e.dialog.showOpenDialog!({})).toEqual({ canceled: false, filePaths: ["kept"] });
  });
  it("an answer queued before the stub is installed still counts", async () => {
    delete (globalThis as { __geoTestDialogs?: unknown }).__geoTestDialogs;
    queueDialogAnswer(null, { kind: "open", path: "early" });
    const fresh: { dialog: Record<string, Fn> } = { dialog: {} };
    installDialogStub(fresh);
    expect(await fresh.dialog.showOpenDialog!({})).toEqual({ canceled: false, filePaths: ["early"] });
  });
  it("each function is self-contained (it is sent to another process as text)", () => {
    for (const f of [installDialogStub, queueDialogAnswer, takeUnanswered]) {
      const src = f.toString();
      expect(() => new Function(`return (${src})`)()).not.toThrow();
      expect(src).not.toMatch(/\bimport\b|\brequire\(|unansweredNote/);
    }
  });
  it("words the notes", () => {
    expect(unansweredNote({ kind: "open", title: "Open project" }))
      .toBe('A open dialog ("Open project") opened with no answer queued and was cancelled. Queue one with dialog_answer first.');
    expect(unansweredNote({ kind: "error", title: "AffinityGeo: Port 8790 is in use." })).toBe("The app showed an error box: AffinityGeo: Port 8790 is in use.");
  });
});

describe("dialog_answer and the notes", () => {
  function ctxWith(running: boolean) {
    const evaluate = vi.fn(async (fn: (e: unknown, a?: unknown) => unknown, arg?: unknown) => fn(null, arg));
    const driver = { running: () => running, electron: () => ({ evaluate }) } as unknown as AppDriver;
    return { ctx: { driver, api: {} as ApiClient } as ToolContext, evaluate, driver };
  }
  it("queues an answer in the app and says how many wait", async () => {
    const { ctx } = ctxWith(true);
    expect(await dialogAnswer.run(ctx, { kind: "save", path: "C:/t/a.afgeo" })).toEqual({ text: "Queued. 1 answer(s) waiting for the next save dialog." });
    expect(await e.dialog.showSaveDialog!({})).toEqual({ canceled: false, filePath: "C:/t/a.afgeo" });
  });
  it("open and save need a path or cancel", async () => {
    const { ctx } = ctxWith(true);
    await expect(dialogAnswer.run(ctx, { kind: "open" })).rejects.toThrow(new ToolError("Give a path, or cancel: true."));
    await expect(dialogAnswer.run(ctx, { kind: "open", cancel: true })).resolves.toBeDefined();
    await expect(dialogAnswer.run(ctx, { kind: "message" })).resolves.toBeDefined();
  });
  it("turns unanswered dialogs into notes, once", async () => {
    const { driver } = ctxWith(true);
    await e.dialog.showOpenDialog!({}, { title: "Open project" });
    expect(await dialogNotes(driver)).toEqual(['A open dialog ("Open project") opened with no answer queued and was cancelled. Queue one with dialog_answer first.']);
    expect(await dialogNotes(driver)).toEqual([]);
  });
  it("has no notes when the app isn't running", async () => {
    const { driver, evaluate } = ctxWith(false);
    expect(await dialogNotes(driver)).toEqual([]);
    expect(evaluate).not.toHaveBeenCalled();
  });
});
