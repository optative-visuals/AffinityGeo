// The README: sections in order, short enough to read, and the name always spelt "AffinityGeo".
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const text = readFileSync(fileURLToPath(new URL("../../../README.md", import.meta.url)), "utf8");

describe("README", () => {
  it("has the sections in order", () => {
    const headings = [...text.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    expect(headings).toEqual([
      "What it is", "Install", "First run", "A 2-minute quickstart", "How your edits are kept",
      "Updates", "Known limits", "Development", "Licence and credits",
    ]);
  });

  it("is under 900 words", () => {
    expect(text.split(/\s+/).filter(Boolean).length).toBeLessThan(900);
  });

  it("always writes the name as AffinityGeo", () => {
    expect(text).not.toMatch(/Affinity Geo|AffinityGEO|Affinitygeo/);
    expect(text.startsWith("# AffinityGeo")).toBe(true);
  });

  it("links the Releases page in Install and Updates, and explains Later", () => {
    const url = "https://github.com/optative-visuals/AffinityGeo/releases";
    const section = (name: string) => text.split(new RegExp(`^## ${name}$`, "m"))[1]!.split(/^## /m)[0]!;
    expect(section("Install")).toContain(url);
    expect(section("Updates")).toContain(url);
    expect(section("Updates")).toContain("Later installs the update next time you quit.");
    expect(section("Updates")).toContain("If AffinityGeo says the scripts were updated, run Geo – Connect again in Affinity.");
  });

  it("credits OpenStreetMap and avoids jargon", () => {
    expect(text).toContain("Map data © OpenStreetMap contributors");
    expect(text).not.toMatch(/\b(CRS|EPSG|feature class)\b/);
    expect(text).toContain("<!-- screenshot: the Maps screen -->");
  });
});
