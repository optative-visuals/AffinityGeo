// Really launches AffinityGeo. Skipped unless GEO_E2E=1 (needs a display, and port 8790 free):
//   GEO_E2E=1 npx vitest run apps/mcp/test/e2e.test.ts
import { existsSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createApiClient } from "../src/apiClient.js";
import { createDriver, NOT_RUNNING, portFree } from "../src/driver.js";

const root = path.resolve(import.meta.dirname, "../../..");
const driver = createDriver(root);
const api = createApiClient();

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
