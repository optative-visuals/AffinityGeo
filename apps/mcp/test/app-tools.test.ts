import { describe, expect, it, vi } from "vitest";
import type { ApiClient, ApiReply } from "../src/apiClient.js";
import type { AppDriver } from "../src/driver.js";
import { appLaunch, appLogs, appQuit, appStatus } from "../src/tools/app.js";
import type { ToolContext } from "../src/tool.js";

function ctxWith(running: boolean, replies: Record<string, ApiReply> = {}) {
  const request = vi.fn(async (_m: string, p: string) => replies[p] ?? { status: 404, body: {} });
  const driver = {
    running: vi.fn(() => running), launch: vi.fn(async () => {}), quit: vi.fn(async () => {}),
    logs: vi.fn(async () => ({ mainLog: ["m1", "m2"], consoleErrors: ["c1"] })), version: vi.fn(() => "0.1.0"),
  };
  const ctx: ToolContext = { driver: driver as unknown as AppDriver, api: { request } as unknown as ApiClient };
  return { ctx, request, driver };
}

describe("app_status", () => {
  it("reports running:false without calling the API", async () => {
    const { ctx, request } = ctxWith(false);
    expect(await appStatus.run(ctx, {})).toEqual({ json: { running: false } });
    expect(request).not.toHaveBeenCalled();
  });
  it("reports no project when the app says none is open", async () => {
    const { ctx } = ctxWith(true, {
      affinity: { status: 200, body: { connected: false, busy: false } },
      project: { status: 409, body: { error: "No project is open. Create or open a project first." } },
    });
    expect(await appStatus.run(ctx, {})).toEqual({ json: { running: true, version: "0.1.0", affinity: { connected: false, busy: false }, project: { open: false } } });
  });
  it("folds the affinity and project replies into one object", async () => {
    const { ctx } = ctxWith(true, {
      affinity: { status: 200, body: { connected: true, busy: false } },
      project: { status: 200, body: { dirty: true, project: { name: "Hyde Park", locations: [{ id: "a", name: "Park" }], maps: [{ id: "m1", name: "Overview" }, { id: "m2", name: "Detail" }] } } },
    });
    expect(await appStatus.run(ctx, {})).toEqual({ json: {
      running: true, version: "0.1.0", affinity: { connected: true, busy: false },
      project: { open: true, name: "Hyde Park", dirty: true, locations: ["Park"], maps: ["Overview", "Detail"] },
    } });
  });
});

describe("app_launch and app_quit", () => {
  it("launches with the given options and returns the status", async () => {
    const { ctx, driver } = ctxWith(true, { affinity: { status: 200, body: { connected: false, busy: false } }, project: { status: 409, body: {} } });
    const r = await appLaunch.run(ctx, { build: false, fixtures: true });
    expect(driver.launch).toHaveBeenCalledWith({ build: false, fixtures: true });
    expect((r.json as { running: boolean }).running).toBe(true);
  });
  it("says so when there was nothing to quit", async () => {
    const { ctx, driver } = ctxWith(false);
    expect(await appQuit.run(ctx, {})).toEqual({ text: "AffinityGeo wasn't running." });
    expect(driver.quit).not.toHaveBeenCalled();
  });
  it("quits a running app", async () => {
    const { ctx, driver } = ctxWith(true);
    expect(await appQuit.run(ctx, {})).toEqual({ text: "AffinityGeo has closed. Unsaved changes in the test copy were discarded." });
    expect(driver.quit).toHaveBeenCalled();
  });
});

describe("app_logs", () => {
  it("passes the line count through and returns both sources", async () => {
    const { ctx, driver } = ctxWith(true);
    expect(await appLogs.run(ctx, { lines: 5 })).toEqual({ json: { mainLog: ["m1", "m2"], consoleErrors: ["c1"] } });
    expect(driver.logs).toHaveBeenCalledWith(5);
  });
});
