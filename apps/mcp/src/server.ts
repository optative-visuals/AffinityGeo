// The AffinityGeo test MCP server: lets Claude launch and drive a development copy of AffinityGeo.
// Developer tooling only; nothing here is part of the released app.
// Run: node --import tsx apps/mcp/src/server.ts (Claude Code starts it from .mcp.json).
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createApiClient } from "./apiClient.js";
import { createDriver } from "./driver.js";
import { appLaunch, appLogs, appQuit, appStatus } from "./tools/app.js";
import { apiRequest, dialogAnswer, dialogNotes } from "./tools/data.js";
import { uiClick, uiDrag, uiPress, uiScreenshot, uiSnapshot, uiType, uiWaitFor } from "./tools/ui.js";
import { toMcpError, toMcpResult, type ToolContext, type ToolDef } from "./tool.js";

export interface ServerHooks {
  /** Runs after every tool call; its lines are added to the reply (for example, a dialog that was cancelled). */
  after?: () => Promise<string[]>;
}

export function createServer(ctx: ToolContext, tools: ToolDef[], hooks: ServerHooks = {}): McpServer {
  const server = new McpServer({ name: "affinitygeo", version: "0.0.0" });
  for (const tool of tools) {
    server.registerTool(tool.name, { description: tool.description, inputSchema: tool.input }, async (args: unknown) => {
      let reply: ReturnType<typeof toMcpResult> | ReturnType<typeof toMcpError>;
      try {
        reply = toMcpResult(await tool.run(ctx, args));
      } catch (e) {
        reply = toMcpError(e);
      }
      let notes: string[] = [];
      try { notes = (await hooks.after?.()) ?? []; } catch { /* a note is never worth failing the call for */ }
      if (!notes.length) return reply;
      // Notes go after the text and before any image.
      const content = [...reply.content];
      const at = content.findIndex((c) => c.type === "image");
      content.splice(at < 0 ? content.length : at, 0, ...notes.map((text) => ({ type: "text" as const, text })));
      return { ...reply, content };
    });
  }
  return server;
}

/**
 * stdout carries the protocol, so ordinary logging goes to stderr instead. Returns a function that undoes it.
 */
export function quietStdout(): () => void {
  const { log, info, debug } = console;
  console.log = console.info = console.debug = (...args: unknown[]) => console.error(...args);
  return () => { Object.assign(console, { log, info, debug }); };
}

export const ALL_TOOLS: ToolDef[] = [
  appLaunch, appQuit, appStatus, appLogs,
  uiSnapshot, uiScreenshot, uiClick, uiType, uiPress, uiDrag, uiWaitFor,
  apiRequest, dialogAnswer,
];

async function main(): Promise<void> {
  quietStdout();
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const driver = createDriver(repoRoot);
  const server = createServer({ driver, api: createApiClient() }, ALL_TOOLS, { after: () => dialogNotes(driver) });
  // Never leave a test copy of the app running once Claude has gone.
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void driver.quit().finally(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  process.stdin.on("close", stop);
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
