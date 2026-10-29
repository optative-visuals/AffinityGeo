import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const raw = readFileSync(here("../../../.github/workflows/ci.yml"), "utf8");
const wf = parse(raw);
const job = Object.values(wf.jobs)[0] as { "runs-on": string; steps: Array<Record<string, any>> };
const text = (s: Record<string, any>) => String(s.run ?? s.uses ?? "");
const indexOf = (needle: string) => job.steps.findIndex((s) => text(s) === needle);

describe("CI workflow", () => {
  it("runs on pushes to main and on pull requests, on one Windows job", () => {
    expect(wf.on).toEqual({ push: { branches: ["main"] }, pull_request: null });
    expect(Object.keys(wf.jobs)).toHaveLength(1);
    expect(job["runs-on"]).toBe("windows-latest");
  });

  it("can only read the repository and uses no secrets", () => {
    expect(wf.permissions).toEqual({ contents: "read" });
    expect(raw).not.toMatch(/secrets\./);
    expect(raw).not.toMatch(/GH_TOKEN|GITHUB_TOKEN/);
  });

  it("checks out without leaving git credentials behind", () => {
    expect(String(job.steps[0].uses)).toMatch(/^actions\/checkout@v4$/);
    expect(job.steps[0].with).toEqual({ "persist-credentials": false });
  });

  it("sets up Node 24 with an npm cache before installing", () => {
    const node = job.steps.findIndex((s) => String(s.uses).startsWith("actions/setup-node@v4"));
    expect(job.steps[node].with).toMatchObject({ "node-version": 24, cache: "npm" });
    expect(node).toBeLessThan(indexOf("npm ci"));
  });

  it("installs, lints, type-checks, tests and builds, in that order", () => {
    const order = ["npm ci", "npm run lint", "npm run typecheck", "npm test", "npm run build:app"].map(indexOf);
    expect(order.every((i) => i >= 0)).toBe(true);
    for (let i = 1; i < order.length; i++) expect(order[i - 1]).toBeLessThan(order[i]!);
  });
});
