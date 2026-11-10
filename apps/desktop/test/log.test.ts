import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { captureConsole, fileLogger, formatLogArgs } from "../src/main/log.js";

function fakeConsole() {
  return { error: vi.fn(), warn: vi.fn() };
}

describe("formatLogArgs", () => {
  it("keeps strings, uses an Error's stack, and inspects other values", () => {
    const e = new Error("boom");
    expect(formatLogArgs(["Couldn't save:", e])).toContain("Couldn't save: Error: boom");
    expect(formatLogArgs(["Couldn't save:", e])).toContain("at ");
    expect(formatLogArgs(["n", 3, { a: 1 }, null, undefined])).toBe('n 3 {"a":1} null undefined');
  });

  it("falls back to the message when there is no stack", () => {
    const e = new Error("no stack");
    e.stack = undefined;
    expect(formatLogArgs([e])).toBe("no stack");
  });

  it("never throws on circular values, BigInt or hostile objects", () => {
    const c: Record<string, unknown> = {};
    c.self = c;
    expect(() => formatLogArgs([c])).not.toThrow();
    expect(formatLogArgs([10n])).toBe("10");
    const hostile = { toJSON() { throw new Error("no"); }, toString() { throw new Error("no"); } };
    expect(() => formatLogArgs([hostile])).not.toThrow();
  });
});

describe("captureConsole", () => {
  it("still prints to the original console and logs one prefixed line", () => {
    const target = fakeConsole();
    const original = target.error;
    const log = vi.fn();
    const restore = captureConsole(log, target);
    target.error("Couldn't save the settings:", new Error("disk full"));
    expect(original).toHaveBeenCalledTimes(1);
    expect(original.mock.calls[0]![0]).toBe("Couldn't save the settings:");
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toMatch(/^\[error\] Couldn't save the settings: Error: disk full/);
    restore();
  });

  it("wraps warn with a [warn] prefix", () => {
    const target = fakeConsole();
    const log = vi.fn();
    captureConsole(log, target);
    target.warn("careful");
    expect(log).toHaveBeenCalledWith("[warn] careful");
  });

  it("restores the originals", () => {
    const target = fakeConsole();
    const { error, warn } = target;
    const restore = captureConsole(vi.fn(), target);
    expect(target.error).not.toBe(error);
    restore();
    expect(target.error).toBe(error);
    expect(target.warn).toBe(warn);
  });

  it("does not recurse when the logger itself reports an error", () => {
    const target = fakeConsole();
    const log = vi.fn(() => { target.error("inside the logger"); });
    captureConsole(log, target);
    target.error("outer");
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("never throws when the logger throws, and still prints", () => {
    const target = fakeConsole();
    const original = target.error;
    captureConsole(() => { throw new Error("log broke"); }, target);
    expect(() => target.error("x")).not.toThrow();
    expect(original).toHaveBeenCalledTimes(1);
  });
});

describe("fileLogger", () => {
  let tmp: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "geo-log-"));
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => { logSpy.mockRestore(); rmSync(tmp, { recursive: true, force: true }); });

  it("appends lines to main.log", () => {
    const log = fileLogger(() => tmp);
    log("one");
    log("two");
    const lines = readFileSync(path.join(tmp, "main.log"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/ two$/);
  });

  it("moves a log over the size cap to main.old.log, replacing the previous one", () => {
    writeFileSync(path.join(tmp, "main.log"), "x".repeat(100));
    writeFileSync(path.join(tmp, "main.old.log"), "ancient");
    const log = fileLogger(() => tmp, { maxBytes: 50 });
    log("fresh");
    expect(readFileSync(path.join(tmp, "main.old.log"), "utf8")).toBe("x".repeat(100));
    const now = readFileSync(path.join(tmp, "main.log"), "utf8");
    expect(now).toMatch(/ fresh\n$/);
    expect(now).not.toContain("xxx");
  });

  it("leaves a small log alone, and only checks the size once", () => {
    writeFileSync(path.join(tmp, "main.log"), "small\n");
    const log = fileLogger(() => tmp, { maxBytes: 1000 });
    log("a");
    expect(existsSync(path.join(tmp, "main.old.log"))).toBe(false);
    expect(readFileSync(path.join(tmp, "main.log"), "utf8")).toMatch(/^small\n.* a\n$/);
  });
});
