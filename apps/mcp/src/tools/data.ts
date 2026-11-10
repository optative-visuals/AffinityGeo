// Tools that read and change the app's state directly, without going through the window.
import { z } from "zod";
import { defineTool } from "../tool.js";

export const apiRequest = defineTool({
  name: "api_request",
  description:
    "Call AffinityGeo's local API (the one its window uses) and get the status and JSON reply. `path` is what follows /api/, " +
    "for example `project`, `affinity`, `maps/status`, `places?q=Hyde Park`. Use it to read the real state behind the screen, " +
    "or to set something up faster than clicking. The app must be running (app_launch).",
  input: {
    method: z.enum(["GET", "POST", "PATCH", "DELETE"]).default("GET"),
    path: z.string().min(1),
    body: z.unknown().optional().describe("JSON body for POST and PATCH."),
  },
  run: async (ctx, a) => ({ json: await ctx.api.request(a.method, a.path, a.body) }),
});
