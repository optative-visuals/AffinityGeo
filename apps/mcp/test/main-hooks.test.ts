import { mkdirSync, mkdtempSync, existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { removeStaleProfiles } from "../src/driver.js";
import { exitWhenParentGone } from "../src/mainHooks.js";

describe("exitWhenParentGone (runs inside the test copy)", () => {
  afterEach(() => vi.useRealTimers());

  it("closes the app once the server that launched it has gone", () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    const alive = vi.fn(() => true);
    exitWhenParentGone({ app: { exit } }, { pid: 4242, everyMs: 1000, isAlive: alive });
    vi.advanceTimersByTime(3000);
    expect(alive).toHaveBeenCalledWith(4242);
    expect(exit).not.toHaveBeenCalled();
    alive.mockReturnValue(false);
    vi.advanceTimersByTime(1000);
    expect(exit).toHaveBeenCalledWith(0);
  });
  it("by default checks the real process table", () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    exitWhenParentGone({ app: { exit } }, { pid: process.pid, everyMs: 1000 });
    vi.advanceTimersByTime(2000);
    expect(exit).not.toHaveBeenCalled(); // this test process is alive
    const gone = vi.fn();
    exitWhenParentGone({ app: { exit: gone } }, { pid: 2 ** 30, everyMs: 1000 }); // no such process
    vi.advanceTimersByTime(1000);
    expect(gone).toHaveBeenCalledWith(0);
  });
  it("is self-contained (it is sent to another process as text)", () => {
    const src = exitWhenParentGone.toString();
    expect(() => new Function(`return (${src})`)()).not.toThrow();
    expect(src).not.toMatch(/\bimport\b|\brequire\(/);
  });
});

describe("removeStaleProfiles", () => {
  it("removes left-over test profiles and nothing else", () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "geo-stale-"));
    try {
      for (const d of ["affinitygeo-test-abc", "affinitygeo-test-def", "affinitygeo-e2e-keep", "other"]) mkdirSync(path.join(tmp, d));
      expect(removeStaleProfiles(tmp).sort()).toEqual(["affinitygeo-test-abc", "affinitygeo-test-def"]);
      expect(existsSync(path.join(tmp, "affinitygeo-test-abc"))).toBe(false);
      expect(existsSync(path.join(tmp, "affinitygeo-e2e-keep"))).toBe(true);
      expect(existsSync(path.join(tmp, "other"))).toBe(true);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });
});
