import net from "node:net";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDriver, NOT_RUNNING, PORT_BUSY, portFree, tail } from "../src/driver.js";

const root = path.resolve(import.meta.dirname, "../../..");

function listen(port: number): Promise<net.Server | null> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(null));
    s.listen(port, "127.0.0.1", () => resolve(s));
  });
}
const close = (s: net.Server) => new Promise<void>((r) => s.close(() => r()));

describe("portFree", () => {
  it("is false while something listens and true after it closes", async () => {
    const s = (await listen(0))!;
    const port = (s.address() as net.AddressInfo).port;
    expect(await portFree(port)).toBe(false);
    await close(s);
    expect(await portFree(port)).toBe(true);
  });
});

describe("tail", () => {
  it("returns the last n non-empty lines", () => {
    expect(tail("a\nb\n\nc\n", 2)).toEqual(["b", "c"]);
    expect(tail("a\r\nb\r\n", 5)).toEqual(["a", "b"]);
    expect(tail("", 5)).toEqual([]);
  });
});

describe("the driver before a launch", () => {
  it("page() and electron() throw NOT_RUNNING", () => {
    const driver = createDriver(root);
    expect(driver.running()).toBe(false);
    expect(() => driver.page()).toThrow(NOT_RUNNING);
    expect(() => driver.electron()).toThrow(NOT_RUNNING);
  });
  it("quit is a no-op when nothing is running", async () => {
    await expect(createDriver(root).quit()).resolves.toBeUndefined();
  });
  it("logs are empty", async () => {
    expect(await createDriver(root).logs(10)).toEqual({ mainLog: [], consoleErrors: [] });
  });
  it("refuses to launch while port 8790 is busy, before building", async (t) => {
    const s = await listen(8790);
    if (!s) return t.skip(); // something else (a real AffinityGeo) already has the port
    try {
      const spawnBuild = vi.fn(async () => {});
      const driver = createDriver(root, { spawnBuild });
      await expect(driver.launch({ build: true, fixtures: true })).rejects.toThrow(PORT_BUSY);
      expect(spawnBuild).not.toHaveBeenCalled();
      expect(driver.running()).toBe(false);
    } finally { await close(s); }
  });
});
