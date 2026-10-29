import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, utimesSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureScripts, scriptsSource, scriptsNote, scriptsVersion } from "../src/main/scripts.js";

let tmp: string;
let src: string;
let home: string;
beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "geo-scripts-"));
  src = path.join(tmp, "src");
  home = path.join(tmp, "home");
  mkdirSync(src);
  writeFileSync(path.join(src, "connect.js"), "// connect");
  writeFileSync(path.join(src, "plan.js"), "// plan");
  writeFileSync(path.join(src, "notes.txt"), "not a script");
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("ensureScripts", () => {
  it("first start installs the scripts and writes VERSION", () => {
    expect(ensureScripts(home, { dir: src }, "1.0.0")).toEqual({ status: "installed" });
    const dest = path.join(home, "affinity");
    expect(readFileSync(path.join(dest, "connect.js"), "utf8")).toBe("// connect");
    expect(existsSync(path.join(dest, "plan.js"))).toBe(true);
    expect(existsSync(path.join(dest, "notes.txt"))).toBe(false);
    expect(readFileSync(path.join(dest, "VERSION"), "utf8").trim()).toBe("1.0.0");
  });

  it("writes version.js, which exports the version", () => {
    ensureScripts(home, { dir: src }, "1.0.0");
    const f = path.join(home, "affinity", "version.js");
    expect(readFileSync(f, "utf8").trim()).toBe('module.exports = "1.0.0";');
    ensureScripts(home, { dir: src }, "1.1.0");
    expect(readFileSync(f, "utf8").trim()).toBe('module.exports = "1.1.0";');
  });

  it("same version leaves the folder alone", () => {
    ensureScripts(home, { dir: src }, "1.0.0");
    const f = path.join(home, "affinity", "connect.js");
    const old = new Date("2020-01-01T00:00:00Z");
    utimesSync(f, old, old);
    writeFileSync(path.join(src, "connect.js"), "// changed");
    expect(ensureScripts(home, { dir: src }, "1.0.0")).toEqual({ status: "current" });
    expect(statSync(f).mtimeMs).toBe(old.getTime());
    expect(readFileSync(f, "utf8")).toBe("// connect");
  });

  it("a newer app version rewrites the scripts and reports it", () => {
    ensureScripts(home, { dir: src }, "1.0.0");
    const dest = path.join(home, "affinity");
    writeFileSync(path.join(dest, "draw.js"), "// old");
    writeFileSync(path.join(src, "connect.js"), "// connect 2");
    expect(ensureScripts(home, { dir: src }, "1.1.0")).toEqual({ status: "updated" });
    expect(readFileSync(path.join(dest, "connect.js"), "utf8")).toBe("// connect 2");
    expect(existsSync(path.join(dest, "draw.js"))).toBe(false);
    expect(readFileSync(path.join(dest, "VERSION"), "utf8").trim()).toBe("1.1.0");
  });

  it("never touches the designer's own files", () => {
    const dest = path.join(home, "affinity");
    mkdirSync(dest, { recursive: true });
    writeFileSync(path.join(dest, "My map.af"), "mine");
    ensureScripts(home, { dir: src }, "1.0.0");
    ensureScripts(home, { dir: src }, "1.1.0");
    expect(readFileSync(path.join(dest, "My map.af"), "utf8")).toBe("mine");
  });

  it("force copies even when the version matches", () => {
    ensureScripts(home, { dir: src }, "1.0.0");
    writeFileSync(path.join(src, "connect.js"), "// changed");
    expect(ensureScripts(home, { dir: src }, "1.0.0", { force: true }).status).toBe("updated");
    expect(readFileSync(path.join(home, "affinity", "connect.js"), "utf8")).toBe("// changed");
  });

  it("an unwritable home reports the reason and does not throw", () => {
    const file = path.join(tmp, "a-file");
    writeFileSync(file, "x");
    const r = ensureScripts(path.join(file, "sub"), { dir: src }, "1.0.0");
    expect(r.status).toBe("failed");
    expect(r.reason).toBeTruthy();
  });

  it("a missing source folder fails without throwing", () => {
    expect(ensureScripts(home, { dir: path.join(tmp, "nope") }, "1.0.0").status).toBe("failed");
  });
});

describe("scriptsSource", () => {
  it("uses the app's resources when packaged", () => {
    const s = scriptsSource({ isPackaged: true, resourcesPath: "/r", repoRoot: "/repo" });
    expect(s.dir).toBe(path.join("/r", "affinity-scripts"));
    expect(s.loader).toBe(path.join("/r", "affinity-scripts", "loader.js"));
  });
  it("uses the repo's package in development", () => {
    const s = scriptsSource({ isPackaged: false, resourcesPath: "/r", repoRoot: "/repo" });
    expect(s.dir).toBe(path.join("/repo", "packages", "affinity-scripts", "src"));
    expect(s.loader).toBe(path.join("/repo", "packages", "affinity-scripts", "loader.js"));
  });
});

describe("scriptsNote", () => {
  it("says what happened only when there is something to say", () => {
    expect(scriptsNote({ status: "current" }, "C:\\AffinityGeo")).toBeNull();
    expect(scriptsNote({ status: "installed" }, "C:\\AffinityGeo")).toBeNull();
    expect(scriptsNote({ status: "updated" }, "C:\\AffinityGeo")).toBe("Scripts updated. In Affinity, run Geo – Connect again.");
    expect(scriptsNote({ status: "failed", reason: "EPERM" }, "C:\\AffinityGeo")).toBe("Scripts couldn't be installed in C:\\AffinityGeo\\affinity: EPERM");
  });
});

describe("scripts hardening", () => {
  it("does not copy loader.js into the installed folder", () => {
    writeFileSync(path.join(src, "loader.js"), "// loader");
    ensureScripts(home, { dir: src }, "1.0.0");
    expect(existsSync(path.join(home, "affinity", "connect.js"))).toBe(true);
    expect(existsSync(path.join(home, "affinity", "loader.js"))).toBe(false);
  });
  it("stamps a packaged app with its own version", () => {
    expect(scriptsVersion({ isPackaged: true, appVersion: "0.2.0", rootVersion: () => "9.9.9" })).toBe("0.2.0");
  });
  it("stamps a development run with the root package.json version, not Electron's", () => {
    expect(scriptsVersion({ isPackaged: false, appVersion: "41.0.0", rootVersion: () => "0.2.0" })).toBe("0.2.0");
  });
  it("falls back to the app version if the root package.json can't be read", () => {
    expect(scriptsVersion({ isPackaged: false, appVersion: "41.0.0", rootVersion: () => { throw new Error("nope"); } })).toBe("41.0.0");
  });
});
