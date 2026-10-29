import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../src/ui/tokens.css", import.meta.url), "utf8");
const token = (name: string) => css.match(new RegExp(`--${name}:\\s*([^;]+);`))?.[1]?.trim();

describe("tokens.css", () => {
  it("mode pill colours and the lime accent match the design", () => {
    expect(token("mode-area")).toBe("#F2B880");
    expect(token("mode-maps")).toBe("#8FD3F5");
    expect(token("mode-style")).toBe("#F59AC8");
    expect(token("mode-data")).toBe("#C3A6F5");
    expect(token("lime")).toBe("#B5F27A");
  });

  it("defines the light palette once", () => {
    expect(css.match(/--canvas:/g)).toHaveLength(1);
  });

  it("has no type smaller than 11 px", () => {
    const sizes = [...css.matchAll(/font-size:\s*([\d.]+)px/g), ...css.matchAll(/--fs[\w-]*:\s*([\d.]+)px/g)].map((m) => Number(m[1]));
    expect(sizes.length).toBeGreaterThan(0);
    for (const s of sizes) expect(s).toBeGreaterThanOrEqual(11);
  });
});
