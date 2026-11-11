// Tools that start, stop and report on the test copy of AffinityGeo.
import { z } from "zod";
import { defineTool, type ToolContext } from "../tool.js";

async function status(ctx: ToolContext): Promise<unknown> {
  if (!ctx.driver.running()) return { running: false };
  const [affinity, project] = await Promise.all([ctx.api.request("GET", "affinity"), ctx.api.request("GET", "project")]);
  const p = project.status === 200
    ? (project.body as { dirty?: boolean; project?: { name?: string; locations?: Array<{ name?: string }>; maps?: Array<{ name?: string }> } })
    : null;
  return {
    running: true,
    version: ctx.driver.version(),
    affinity: affinity.body,
    project: p?.project
      ? { open: true, name: p.project.name, dirty: p.dirty === true, locations: (p.project.locations ?? []).map((l) => l.name), maps: (p.project.maps ?? []).map((m) => m.name) }
      : { open: false },
  };
}

export const appLaunch = defineTool({
  name: "app_launch",
  description:
    "Build and start a test copy of AffinityGeo (the development build) in a throwaway profile, so the designer's own recent projects " +
    "and settings are untouched. The designer's own AffinityGeo must be closed first: both use port 8790. " +
    "`fixtures: true` answers place searches and data fetches from recorded Hyde Park data instead of the internet (repeatable, works offline). " +
    "To test against Affinity, the designer must have Affinity open and Geo – Connect running; check `affinity.connected` in the reply.",
  input: {
    build: z.boolean().default(true).describe("Rebuild the app first, so the test runs the current code."),
    fixtures: z.boolean().default(false).describe("Use recorded Hyde Park data instead of live OpenStreetMap."),
  },
  run: async (ctx, a) => {
    await ctx.driver.launch({ build: a.build, fixtures: a.fixtures });
    return { json: await status(ctx) };
  },
});

export const appQuit = defineTool({
  name: "app_quit",
  description: "Close the test copy of AffinityGeo and delete its throwaway profile. Unsaved changes are discarded without asking.",
  input: {},
  run: async (ctx) => {
    if (!ctx.driver.running()) return { text: "AffinityGeo wasn't running." };
    await ctx.driver.quit();
    return { text: "AffinityGeo has closed. Unsaved changes in the test copy were discarded." };
  },
});

export const appStatus = defineTool({
  name: "app_status",
  description: "Whether the test copy is running, whether Affinity is connected or busy, and which project is open (name, unsaved changes, locations, maps).",
  input: {},
  run: async (ctx) => ({ json: await status(ctx) }),
});

export const appLogs = defineTool({
  name: "app_logs",
  description: "The end of the app's log file (main.log) and any errors the window has printed since launch. Look here when something fails without a message on screen.",
  input: { lines: z.number().int().min(1).max(500).default(80) },
  run: async (ctx, a) => ({ json: await ctx.driver.logs(a.lines) }),
});
