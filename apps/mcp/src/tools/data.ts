// Tools that read and change the app's state directly, without going through the window.
import { z } from "zod";
import { queueDialogAnswer, takeUnanswered, unansweredNote, type DialogAnswer } from "../dialogStub.js";
import type { AppDriver } from "../driver.js";
import { defineTool, ToolError } from "../tool.js";

export const apiRequest = defineTool({
  name: "api_request",
  description:
    "Call AffinityGeo's local API (the one its window uses) and get the status and JSON reply. `path` is what follows /api/, " +
    "for example `project`, `affinity`, `maps/status`, `places?q=Hyde Park`. Use it to read the real state behind the screen, " +
    "or to set something up faster than clicking. The app must be running (app_launch).",
  input: {
    method: z.enum(["GET", "POST", "PATCH", "DELETE"]).default("GET"),
    path: z.string().min(1),
    body: z.unknown().optional().describe("JSON body for POST and PATCH."),
  },
  run: async (ctx, a) => ({ json: await ctx.api.request(a.method, a.path, a.body) }),
});

export const dialogAnswer = defineTool({
  name: "dialog_answer",
  description:
    "Decide in advance how the next native Windows dialog is answered, because nobody is there to click it. Call this BEFORE the " +
    "action that opens the dialog. kind `open` (Open project, Use a data file) and `save` (Save As) take the file `path`, or " +
    "`cancel: true`; kind `message` takes the index of the `button` to press. A dialog with no answer queued is cancelled, and " +
    "the next tool reply says so.",
  input: {
    kind: z.enum(["open", "save", "message"]),
    path: z.string().optional().describe("Absolute path of the file to open or save."),
    button: z.number().int().min(0).optional().describe("For message boxes: which button, counting from 0."),
    cancel: z.boolean().optional(),
  },
  run: async (ctx, a) => {
    if (a.kind !== "message" && !a.path && !a.cancel) throw new ToolError("Give a path, or cancel: true.");
    const answer: DialogAnswer = { kind: a.kind, ...(a.path ? { path: a.path } : {}), ...(a.button !== undefined ? { button: a.button } : {}), ...(a.cancel ? { cancel: true } : {}) };
    const waiting = await ctx.driver.electron().evaluate(queueDialogAnswer, answer);
    return { text: `Queued. ${waiting} answer(s) waiting for the next ${a.kind} dialog.` };
  },
});

/** Lines about dialogs that opened with no answer queued since the last call. Empty when the app isn't running. */
export async function dialogNotes(driver: AppDriver): Promise<string[]> {
  if (!driver.running()) return [];
  return (await driver.electron().evaluate(takeUnanswered)).map(unansweredNote);
}
