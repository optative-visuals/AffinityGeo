import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const config = parse(readFileSync(here("../electron-builder.yml"), "utf8"));
const pkg = JSON.parse(readFileSync(here("../package.json"), "utf8"));
const rootPkg = JSON.parse(readFileSync(here("../../../package.json"), "utf8"));

describe("installer config", () => {
  it("is a per-user assisted NSIS installer (asks where to install) with the right artefact name", () => {
    expect(config.appId).toBe("studio.optative.affinitygeo");
    expect(config.productName).toBe("AffinityGeo");
    expect(config.win.target).toBe("nsis");
    expect(config.nsis.oneClick).toBe(false);
    expect(config.nsis.allowToChangeInstallationDirectory).toBe(true);
    expect(config.nsis.perMachine).toBe(false);
    expect(config.nsis.createDesktopShortcut).toBe(true);
    expect(config.nsis.createStartMenuShortcut).toBe(true);
    expect(config.nsis.shortcutName).toBe("AffinityGeo");
    expect(config.nsis.artifactName).toBe("AffinityGeo-Setup-${version}.exe");
  });

  it("installs into an AffinityGeo folder, not the workspace package name", () => {
    // With oneClick off, electron-builder names the folder from productName (see getWindowsInstallationDirName).
    expect(config.nsis.oneClick).toBe(false);
    expect(config.productName).toBe("AffinityGeo");
    expect(config.productName).toMatch(/^[-_+0-9a-zA-Z .]+$/);
  });

  it("publishes drafts to GitHub", () => {
    expect(config.publish).toMatchObject({ provider: "github", owner: "optative-visuals", repo: "AffinityGeo", releaseType: "draft" });
  });

  it("ships the Affinity scripts and the loader as resources", () => {
    expect(config.extraResources).toContainEqual({ from: "../../packages/affinity-scripts/src", to: "affinity-scripts", filter: ["*.js"] });
    expect(config.extraResources).toContainEqual({ from: "../../packages/affinity-scripts/loader.js", to: "affinity-scripts/loader.js" });
  });

  it("is unsigned and bundles everything (no node_modules)", () => {
    expect(config.win.certificateFile).toBeUndefined();
    expect(config.win.certificatePassword).toBeUndefined();
    expect(config.npmRebuild).toBe(false);
    expect(config.files).toEqual(["dist/**", "package.json"]);
  });

  it("desktop package.json is AffinityGeo at the root version", () => {
    expect(pkg.version).toBe(rootPkg.version);
    expect(pkg.productName).toBe("AffinityGeo");
    expect(pkg.main).toBe("dist/main.cjs");
  });
});

describe("brand kit", () => {
  it("reads icon.ico and the installer bitmaps from build/ (all optional)", () => {
    expect(config.directories.buildResources).toBe("build");
    expect(config.win.icon).toBeUndefined();
  });
});
