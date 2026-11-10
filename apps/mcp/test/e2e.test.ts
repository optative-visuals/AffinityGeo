// Drives a real test copy of AffinityGeo through the window tools and native dialogs, with recorded data.
// Skipped unless GEO_E2E=1 (needs a display, and port 8790 free):
//   GEO_E2E=1 npx vitest run apps/mcp/test/e2e.test.ts
// One file on purpose: every launch needs port 8790, so these tests must not run side by side.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createApiClient } from "../src/apiClient.js";
import { createDriver, NOT_RUNNING, portFree } from "../src/driver.js";
import { appStatus } from "../src/tools/app.js";
import { dialogAnswer, dialogNotes } from "../src/tools/data.js";
import { uiClick, uiDrag, uiPress, uiScreenshot, uiSnapshot, uiType, uiWaitFor } from "../src/tools/ui.js";
import type { ToolContext, ToolDef, ToolResult } from "../src/tool.js";

const root = path.resolve(import.meta.dirname, "../../..");
const driver = createDriver(root);
const ctx: ToolContext = { driver, api: createApiClient() };
// Made in beforeAll, so a skipped run leaves nothing behind.
let scratch = "";
let projectFile = "";

/** Runs a tool as the server would: arguments checked and defaulted by its input schema first. */
const call = (tool: ToolDef, args: Record<string, unknown> = {}): Promise<ToolResult> => tool.run(ctx, z.object(tool.input).parse(args));
const project = async () => ((await call(appStatus)).json as { project: { open: boolean; name?: string; dirty?: boolean } }).project;

const api = ctx.api;

describe.skipIf(process.env.GEO_E2E !== "1")("a real test copy of AffinityGeo", { timeout: 90_000 }, () => {
  afterAll(() => driver.quit());

  it("launches with fixtures in a temp profile, reports status, and quits cleanly", async () => {
    await driver.launch({ build: true, fixtures: true });
    const paths = await driver.electron().evaluate(({ app }) => ({ userData: app.getPath("userData") }));
    expect(paths.userData).toContain("affinitygeo-test-");
    expect(await driver.page().title()).toBe("AffinityGeo");
    expect((await api.request("GET", "affinity")).status).toBe(200);
    expect(((await api.request("GET", "places?q=anything")).body as Array<{ name: string }>)[0]!.name).toContain("recorded test data");
    await expect(driver.launch({ build: false, fixtures: true })).rejects.toThrow("AffinityGeo is already running. Call app_quit first.");
    // With no project open the window logs its own 409 from /api/project: errors are captured, uncaught ones would say so.
    expect((await driver.logs(20)).consoleErrors.filter((l) => l.startsWith("Uncaught"))).toEqual([]);
    await driver.quit();
    expect(driver.running()).toBe(false);
    expect(existsSync(paths.userData)).toBe(false);
    expect(await portFree(8790)).toBe(true);
  });

  it("after the app is closed behind the driver's back, tools report NOT_RUNNING", async () => {
    await driver.launch({ build: false, fixtures: true });
    const profile = await driver.electron().evaluate(({ app }) => app.getPath("userData"));
    await driver.electron().evaluate(({ app }) => { setTimeout(() => app.exit(0), 50); });
    await expect.poll(() => driver.running(), { timeout: 10_000 }).toBe(false);
    expect(() => driver.page()).toThrow(NOT_RUNNING);
    await expect.poll(() => existsSync(profile), { timeout: 10_000 }).toBe(false);
  });
});

describe.skipIf(process.env.GEO_E2E !== "1")("driving the window", { timeout: 120_000 }, () => {
  beforeAll(async () => {
    scratch = mkdtempSync(path.join(os.tmpdir(), "affinitygeo-e2e-"));
    projectFile = path.join(scratch, "hyde-park.afgeo");
    await driver.launch({ build: true, fixtures: true });
    await call(uiClick, { target: { role: "button", name: "Skip for now" } });
  }, 90_000);
  afterAll(async () => {
    await driver.quit();
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  it("snapshot names what is on the start screen", async () => {
    const all = (await call(uiSnapshot)).text!;
    expect(all).toContain('button "New project"');
    expect(all).toContain('heading "No project open"');
    const banner = (await call(uiSnapshot, { within: { role: "banner" } })).text!;
    expect(banner).toContain('button "Send to Affinity" [disabled]');
    expect(banner).not.toContain("No project open");
  });

  it("screenshot is a PNG, of the window or of one element, and can be saved", async () => {
    const file = path.join(scratch, "window.png");
    const whole = await call(uiScreenshot, { saveTo: file });
    expect(whole.image!.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(existsSync(file)).toBe(true);
    const part = await call(uiScreenshot, { within: { role: "banner" } });
    expect(part.image!.length).toBeLessThan(whole.image!.length);
    await expect(call(uiScreenshot, { saveTo: "relative.png" })).rejects.toThrow("saveTo must be an absolute path ending in .png.");
  });

  it("a target with no match fails within 6 s with the snapshot hint", async () => {
    const started = Date.now();
    await expect(call(uiClick, { target: { role: "button", name: "Nope" } }))
      .rejects.toThrow('Nothing matches button "Nope". Use ui_snapshot to see what is on screen.');
    expect(Date.now() - started).toBeLessThan(6000);
  });

  it("a target with several matches asks for nth", async () => {
    await expect(call(uiClick, { target: { role: "button" } })).rejects.toThrow(/^\d+ elements match button\. Add nth \(0 is the first\), or be more specific\.$/);
    await expect(call(uiClick, { target: { role: "button", name: "New project", nth: 5 } })).rejects.toThrow("so there is no nth 5");
  });

  it("clicking a disabled button says why instead of hanging", async () => {
    await expect(call(uiClick, { target: { role: "button", name: "Send to Affinity" } })).rejects.toThrow(/^Couldn't click button "Send to Affinity": /);
  });

  it("waiting gives up with a plain sentence", async () => {
    await expect(call(uiWaitFor, { text: "This never appears", timeoutMs: 300 })).rejects.toThrow('Still waiting after 300 ms for "This never appears" to appear.');
    await expect(call(uiWaitFor, {})).rejects.toThrow("Give exactly one of text, gone or target.");
  });

  it("drag moves the mouse with the button held", async () => {
    await driver.page().evaluate(() => {
      const w = window as unknown as { __drag: { down: number; move: number; up: number; last: number[] } };
      w.__drag = { down: 0, move: 0, up: 0, last: [] };
      window.addEventListener("mousedown", () => { w.__drag.down++; }, true);
      window.addEventListener("mousemove", (ev) => { if (ev.buttons === 1) { w.__drag.move++; w.__drag.last = [ev.clientX, ev.clientY]; } }, true);
      window.addEventListener("mouseup", () => { w.__drag.up++; }, true);
    });
    const r = await call(uiDrag, { from: { x: 600, y: 500 }, to: { x: 700, y: 560 }, steps: 10 });
    expect(r.text).toBe("Dragged from 600, 500 to 700, 560.");
    const seen = await driver.page().evaluate(() => (window as unknown as { __drag: { down: number; move: number; up: number; last: number[] } }).__drag);
    expect(seen).toEqual({ down: 1, move: 10, up: 1, last: [700, 560] });
  });

  it("click, type and wait drive the New project flow with recorded data", async () => {
    await call(uiClick, { target: { role: "button", name: "New project" } });
    await call(uiType, { target: { role: "searchbox", name: "Search for a place" }, text: "Hyde Park", enter: true });
    await call(uiWaitFor, { text: "recorded test data" });
    await call(uiClick, { target: { text: "recorded test data" } });
    await call(uiWaitFor, { target: { role: "button", name: "Create and fetch data" } });
    await call(uiType, { target: { label: "Project name" }, text: "Hyde Park test" });
    await call(uiClick, { target: { role: "button", name: "Create and fetch data" } });
    await expect.poll(async () => (await project()).open, { timeout: 30_000 }).toBe(true);
    expect((await project()).name).toBe("Hyde Park test");
    await call(uiPress, { keys: "Escape" });
  });

  it("an unanswered native dialog is cancelled and reported; a queued answer is used", async () => {
    // Nothing queued: Save As… must not hang, and the next reply carries a note.
    await call(uiClick, { target: { role: "button", name: "Save As…" } });
    await expect.poll(() => dialogNotes(driver), { timeout: 5000 })
      .toEqual(['A save dialog ("Save project") opened with no answer queued and was cancelled. Queue one with dialog_answer first.']);
    expect(existsSync(projectFile)).toBe(false);

    expect((await call(dialogAnswer, { kind: "save", path: projectFile })).text).toBe("Queued. 1 answer(s) waiting for the next save dialog.");
    await call(uiClick, { target: { role: "button", name: "Save As…" } });
    await expect.poll(() => existsSync(projectFile), { timeout: 15_000 }).toBe(true);
    await expect.poll(async () => (await project()).dirty, { timeout: 15_000 }).toBe(false);
    expect(await dialogNotes(driver)).toEqual([]);
  });

  it("opens the saved project through a queued Open dialog after a restart", async () => {
    await driver.quit();
    await driver.launch({ build: false, fixtures: true });
    await call(uiClick, { target: { role: "button", name: "Skip for now" } });
    expect((await project()).open).toBe(false);
    await call(dialogAnswer, { kind: "open", path: projectFile });
    await call(uiClick, { target: { role: "button", name: "Open…" } });
    await expect.poll(async () => (await project()).name, { timeout: 15_000 }).toBe("Hyde Park test");
  });
});
