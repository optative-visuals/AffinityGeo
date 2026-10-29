import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const raw = readFileSync(here("../../../.github/workflows/release.yml"), "utf8");
const wf = parse(raw);
const job = Object.values(wf.jobs)[0] as { "runs-on": string; steps: Array<Record<string, any>> };
const text = (s: Record<string, any>) => String(s.run ?? s.uses ?? "");
const indexOf = (needle: string) => job.steps.findIndex((s) => text(s).includes(needle));
const tagCheck = job.steps.find((s) => String(s.env?.TAG ?? "").includes("github.ref_name"));
const publish = job.steps.find((s) => text(s).includes("electron-builder"));
const draft = job.steps.find((s) => text(s).includes("gh release create"));

describe("release workflow", () => {
  it("runs on version tags only, on one Windows job", () => {
    expect(wf.on).toEqual({ push: { tags: ["v*"] } });
    expect(Object.keys(wf.jobs)).toHaveLength(1);
    expect(job["runs-on"]).toBe("windows-latest");
  });

  it("can write releases and uses only the built-in token, on the draft and publish steps alone", () => {
    expect(wf.permissions).toEqual({ contents: "write" });
    expect(wf.env).toBeUndefined();
    expect(draft).toBeDefined();
    expect(draft).not.toBe(publish);
    expect(draft?.env?.GH_TOKEN).toBe("${{ secrets.GITHUB_TOKEN }}");
    expect(publish?.env).toEqual({ GH_TOKEN: "${{ secrets.GITHUB_TOKEN }}" });
    const others = job.steps.filter((s) => s !== publish && s !== draft);
    expect(others.every((s) => !JSON.stringify(s).includes("secrets."))).toBe(true);
    const secrets = raw.match(/secrets\.[A-Za-z_]+/g) ?? [];
    expect(new Set(secrets)).toEqual(new Set(["secrets.GITHUB_TOKEN"]));
  });

  it("sets up Node 24 with an npm cache", () => {
    const node = job.steps.find((s) => String(s.uses).startsWith("actions/setup-node@"));
    expect(node?.with).toMatchObject({ "node-version": 24, cache: "npm" });
    expect(String(job.steps[0].uses)).toMatch(/^actions\/checkout@/);
  });

  it("doesn't leave git credentials behind after checkout", () => {
    expect(job.steps[0].with).toEqual({ "persist-credentials": false });
  });

  it("passes the tag through an env var, never inside the script", () => {
    expect(tagCheck?.shell).toBe("pwsh");
    expect(tagCheck?.env).toEqual({ TAG: "${{ github.ref_name }}" });
    expect(tagCheck?.run).toContain("$env:TAG");
    expect(String(tagCheck?.run)).not.toContain("${{");
    expect(raw.match(/\$\{\{\s*github\.ref_name\s*\}\}/g)).toHaveLength(2);
  });

  it("checks the tag against both package.json versions", () => {
    const run = String(tagCheck?.run);
    expect(run).toContain("'package.json'");
    expect(run).toContain("'apps/desktop/package.json'");
    expect(run).toContain("both package.json files");
  });

  it("checks the tag first, then installs, tests, builds and publishes, in that order", () => {
    const order = [
      job.steps.indexOf(tagCheck!),
      indexOf("npm ci"),
      indexOf("npm test"),
      indexOf("npm run build:app"),
      job.steps.indexOf(publish!),
    ];
    expect(order.every((i) => i >= 0)).toBe(true);
    for (let i = 1; i < order.length; i++) expect(order[i - 1]).toBeLessThan(order[i]!);
    expect(text(publish!)).toContain("electron-builder --projectDir apps/desktop --publish always");
  });
});

describe("release workflow draft step", () => {
  it("creates the draft after the build and before the publish step", () => {
    const build = indexOf("npm run build:app");
    expect(build).toBeGreaterThanOrEqual(0);
    expect(job.steps.indexOf(draft!)).toBeGreaterThan(build);
    expect(job.steps.indexOf(draft!)).toBeLessThan(job.steps.indexOf(publish!));
  });

  it("creates the release only when none exists, and passes the tag through env", () => {
    const run = String(draft?.run);
    expect(draft?.shell).toBe("pwsh");
    expect(draft?.env?.TAG).toBe("${{ github.ref_name }}");
    expect(run).not.toContain("${{");
    expect(run).toContain('gh release view "$env:TAG"');
    expect(run).toContain(
      'gh release create "$env:TAG" --draft --title "AffinityGeo $env:VERSION" --verify-tag --notes "See CHANGELOG.md."',
    );
    expect(run.indexOf("gh release view")).toBeLessThan(run.indexOf("gh release create"));
  });
});

describe("release workflow icon check", () => {
  const iconCheck = job.steps.find((s) => text(s).includes("icon.ico"));
  it("warns (never fails) before the build when the app icon is missing", () => {
    expect(iconCheck?.shell).toBe("pwsh");
    expect(String(iconCheck?.run)).toContain("::warning::No app icon");
    expect(String(iconCheck?.run)).toContain("apps/desktop/build/icon.ico");
    expect(String(iconCheck?.run)).not.toMatch(/exit 1|Write-Error|throw/);
    expect(job.steps.indexOf(iconCheck!)).toBeLessThan(job.steps.indexOf(publish!));
  });
});
