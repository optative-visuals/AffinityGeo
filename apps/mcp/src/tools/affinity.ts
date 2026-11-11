// Ready-made scripts that read an Affinity document back, for use with the Affinity MCP's execute_script.
// This server can't reach Affinity itself; it only hands over the script text.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { defineTool, ToolError } from "../tool.js";

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../affinity-checks");
const PRELUDE = "_prelude.js";

/** The checks' names, in alphabetical order. Files starting with an underscore are shared parts, not checks. */
export function checkNames(): string[] {
  return readdirSync(DIR)
    .filter((f) => /^[a-z0-9-]+\.js$/.test(f))
    .map((f) => f.slice(0, -3))
    .sort();
}

const read = (file: string) => readFileSync(path.join(DIR, file), "utf8").replace(/\r\n/g, "\n");

/** The full script for a check: the shared helpers, then the check. Each Affinity MCP call starts from an empty scope. */
export function checkScript(name: string): string {
  const names = checkNames();
  // Only names from the folder listing are ever read, so a name can't point anywhere else.
  if (!names.includes(name)) throw new ToolError(`There's no check called '${name}'. Available: ${names.join(", ")}.`);
  return `${read(PRELUDE).trimEnd()}\n\n${read(`${name}.js`).trimEnd()}\n`;
}

export const affinityCheck = defineTool({
  name: "affinity_check",
  description:
    "Ready-made scripts that read the current Affinity document back (they never change it), to check what AffinityGeo drew. " +
    "Without a name: the list of checks. With a name: the complete script; pass that text unchanged to the Affinity MCP's " +
    "execute_script, which prints the result as JSON. The Script Editor in Affinity must be closed, or the call queues.",
  input: { name: z.string().optional() },
  run: async (_ctx, a) => {
    if (a.name === undefined) {
      const checks = checkNames().map((name) => ({ name, description: read(`${name}.js`).split("\n")[0]!.replace(/^\/\/\s*/, "") }));
      return { json: { checks } };
    }
    return { text: checkScript(a.name) };
  },
});
