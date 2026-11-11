import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeJsonAtomic } from "../src/main/jsonFile.js";

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(path.join(os.tmpdir(), "geo-json-")); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

describe("writeJsonAtomic", () => {
  it("writes pretty JSON and leaves no temp file", () => {
    const file = path.join(tmp, "settings.json");
    writeJsonAtomic(file, { a: 1 });
    expect(readFileSync(file, "utf8")).toBe(JSON.stringify({ a: 1 }, null, 2));
    expect(readdirSync(tmp)).toEqual(["settings.json"]);
  });

  it("creates the folder", () => {
    const file = path.join(tmp, "deep", "er", "recent.json");
    writeJsonAtomic(file, ["x"]);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(["x"]);
  });

  it("replaces an existing file", () => {
    const file = path.join(tmp, "s.json");
    writeFileSync(file, "old");
    writeJsonAtomic(file, { b: 2 });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ b: 2 });
  });

  it("keeps the old file and removes the temp file when the write fails", () => {
    const file = path.join(tmp, "s.json");
    writeFileSync(file, "old");
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => writeJsonAtomic(file, circular)).toThrow();
    expect(readFileSync(file, "utf8")).toBe("old");
    expect(readdirSync(tmp)).toEqual(["s.json"]);
  });

  it("removes the temp file when the rename fails", () => {
    const target = path.join(tmp, "dir.json");
    mkdirSync(target); // a folder can't be replaced by a file
    expect(() => writeJsonAtomic(target, { c: 3 })).toThrow();
    expect(readdirSync(tmp)).toEqual(["dir.json"]);
  });
});
