import { describe, it, expect } from "vitest";

describe("geo-core", () => {
  it("exports the shared types module", async () => {
    const m = await import("../src/index.js");
    expect(m).toBeDefined();
  });
});
