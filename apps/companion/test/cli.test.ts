import { describe, expect, it } from "vitest";
import { run } from "../src/cli.js";

async function cli(...args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(args, { out: (s) => out.push(s), err: (s) => err.push(s) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("cli", () => {
  it("only knows serve; anything else prints the usage and exits 1", async () => {
    for (const args of [[], ["frame", "UK"], ["projections"], ["serve", "extra"]]) {
      const r = await cli(...args);
      expect(r.code).toBe(1);
      expect(r.err).toContain("Usage:\n  affinitygeo serve [--port n]");
    }
  });

  it("rejects a bad port", async () => {
    const r = await cli("serve", "--port", "abc");
    expect(r.code).toBe(1);
    expect(r.err).toBe("--port must be a number from 1 to 65535.");
  });
});
