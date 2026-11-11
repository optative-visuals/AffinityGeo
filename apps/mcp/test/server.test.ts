import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { createServer, quietStdout } from "../src/server.js";
import { defineTool, ToolError, toMcpError, toMcpResult, type ToolContext, type ToolDef } from "../src/tool.js";

const ctx = {} as ToolContext;

async function connect(tools: ToolDef[], after?: () => Promise<string[]>) {
  const server = createServer(ctx, tools, after ? { after } : {});
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

const echo = defineTool({
  name: "echo", description: "Says the word back.", input: { word: z.string() },
  run: async (_c, a) => ({ text: a.word }),
});

describe("tool results", () => {
  it("turns json into one text block", () => {
    expect(toMcpResult({ json: { a: 1 } }).content).toEqual([{ type: "text", text: '{\n  "a": 1\n}' }]);
  });
  it("puts notes after the main result and the image last", () => {
    const r = toMcpResult({ text: "done", notes: ["A dialog was cancelled."], image: Buffer.from("x") });
    expect(r.content.map((c) => c.type)).toEqual(["text", "text", "image"]);
  });
  it("says Done when a tool returns nothing", () => {
    expect(toMcpResult({}).content).toEqual([{ type: "text", text: "Done." }]);
  });
  it("reports a ToolError as its message only", () => {
    expect(toMcpError(new ToolError("AffinityGeo isn't running. Call app_launch first.")).content[0].text)
      .toBe("AffinityGeo isn't running. Call app_launch first.");
  });
  it("reports an unexpected error with a prefix and no stack", () => {
    const r = toMcpError(new Error("boom"));
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe("Something went wrong: boom");
  });
});

describe("the server", () => {
  afterEach(() => vi.restoreAllMocks());

  it("lists registered tools over an in-memory transport and runs one", async () => {
    const client = await connect([echo]);
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["echo"]);
    const r = await client.callTool({ name: "echo", arguments: { word: "hi" } });
    expect(r.content).toEqual([{ type: "text", text: "hi" }]);
  });
  it("returns a thrown ToolError as an error result, not a protocol failure", async () => {
    const bad = defineTool({ name: "bad", description: "Fails.", input: {}, run: async () => { throw new ToolError("No."); } });
    const r = await (await connect([bad])).callTool({ name: "bad", arguments: {} });
    expect(r.isError).toBe(true);
    expect(r.content).toEqual([{ type: "text", text: "No." }]);
  });
  it("adds the notes gathered after a call, also to an error", async () => {
    const bad = defineTool({ name: "bad", description: "Fails.", input: {}, run: async () => { throw new ToolError("No."); } });
    const client = await connect([echo, bad], async () => ["A note."]);
    expect((await client.callTool({ name: "echo", arguments: { word: "hi" } })).content).toEqual([{ type: "text", text: "hi" }, { type: "text", text: "A note." }]);
    expect((await client.callTool({ name: "bad", arguments: {} })).content).toEqual([{ type: "text", text: "No." }, { type: "text", text: "A note." }]);
  });
  it("never writes to stdout when a tool logs", async () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const restore = quietStdout();
    try {
      const noisy = defineTool({ name: "noisy", description: "Logs.", input: {}, run: async () => { console.log("x"); console.info("y"); return {}; } });
      await (await connect([noisy])).callTool({ name: "noisy", arguments: {} });
    } finally { restore(); }
    expect(out).not.toHaveBeenCalled();
    expect(err.mock.calls).toEqual([["x"], ["y"]]);
  });
});
