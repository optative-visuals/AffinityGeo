import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const html = readFileSync(new URL("../src/ui/index.html", import.meta.url), "utf8");
const csp = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1] ?? "";
const directive = (name: string) => csp.split(";").map((d) => d.trim()).find((d) => d.startsWith(`${name} `));

describe("Content-Security-Policy", () => {
  it("lets the street basemap load its style and tiles from OpenFreeMap", () => {
    expect(directive("connect-src")).toBe("connect-src 'self' https://tiles.openfreemap.org");
    expect(directive("img-src")).toBe("img-src 'self' data: blob: https://tiles.openfreemap.org");
  });
  it("lets MapLibre run its worker from a blob", () => {
    expect(directive("worker-src")).toBe("worker-src blob:");
    expect(directive("child-src")).toBe("child-src blob:");
  });
  it("allows no other remote host", () => {
    expect([...html.matchAll(/https?:\/\/[^\s"'<>;]+/g)].map((m) => new URL(m[0]).host)).toEqual(["tiles.openfreemap.org", "tiles.openfreemap.org"]);
  });
});
