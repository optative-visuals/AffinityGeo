import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveHome, HomeError, loaderText } from "../src/home.js";

describe("resolveHome", () => {
  it("defaults to C:\\AffinityGeo on win32", () => {
    expect(resolveHome({}, "win32")).toBe("C:\\AffinityGeo");
  });
  it("defaults to ~/AffinityGeo elsewhere", () => {
    const h = resolveHome({}, "linux");
    expect(h.endsWith("/AffinityGeo")).toBe(true);
  });
  it("uses AFFINITYGEO_HOME", () => {
    expect(resolveHome({ AFFINITYGEO_HOME: "D:\\Maps\\Geo_1" }, "win32")).toBe("D:\\Maps\\Geo_1");
  });
  it("rejects non-ASCII paths", () => {
    expect(() => resolveHome({ AFFINITYGEO_HOME: "C:\\Users\\Zoë\\AffinityGeo" }, "win32")).toThrow(HomeError);
  });
  it("rejects spaces with the exact message", () => {
    expect(() => resolveHome({ AFFINITYGEO_HOME: "C:\\My Maps" }, "win32")).toThrow(
      "AffinityGeo's folder path can only use plain letters, numbers, - and _ (no spaces or accents): C:\\My Maps",
    );
  });
  it("expands ~ on non-win32", () => {
    const h = resolveHome({ AFFINITYGEO_HOME: "~/geo" }, "linux");
    expect(h.startsWith("~")).toBe(false);
    expect(h.endsWith("/geo")).toBe(true);
  });
});

describe("loaderText", () => {
  it("reads the packaged loader, with the home swapped in", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "geo-loader-"));
    try {
      const f = path.join(dir, "loader.js");
      const body = "// Geo – Connect\nrequire('C:/AffinityGeo/affinity/connect.js').start();";
      writeFileSync(f, body + "\n");
      expect(loaderText("C:\\AffinityGeo", f)).toBe(body);
      expect(loaderText("D:\\Maps", f)).toContain("require('D:/Maps/affinity/connect.js').start({ home: 'D:/Maps' });");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
