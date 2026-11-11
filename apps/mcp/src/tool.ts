// The contract every tool follows, and how a tool's result becomes an MCP reply.
import type { z, ZodRawShape } from "zod";
import type { ApiClient } from "./apiClient.js";
import type { AppDriver } from "./driver.js";

export interface ToolResult {
  text?: string;
  /** Shown as indented JSON. */
  json?: unknown;
  /** A PNG. */
  image?: Buffer;
  /** Extra lines after the main result, such as a dialog that was cancelled. */
  notes?: string[];
}

export interface ToolContext {
  driver: AppDriver;
  api: ApiClient;
}

export interface ToolDef {
  name: string;
  description: string;
  input: ZodRawShape;
  run(ctx: ToolContext, args: unknown): Promise<ToolResult>;
}

/** Declares a tool with its arguments typed from the input shape. */
export function defineTool<S extends ZodRawShape>(def: {
  name: string;
  description: string;
  input: S;
  run(ctx: ToolContext, args: z.infer<z.ZodObject<S>>): Promise<ToolResult>;
}): ToolDef {
  return def as unknown as ToolDef;
}

/** A failure the caller should read as a sentence, not a stack trace. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

type TextBlock = { type: "text"; text: string };
type ImageBlock = { type: "image"; data: string; mimeType: "image/png" };

export function toMcpResult(r: ToolResult): { content: Array<TextBlock | ImageBlock> } {
  const content: Array<TextBlock | ImageBlock> = [];
  if (r.text !== undefined) content.push({ type: "text", text: r.text });
  if (r.json !== undefined) content.push({ type: "text", text: JSON.stringify(r.json, null, 2) });
  if (!content.length && !r.image) content.push({ type: "text", text: "Done." });
  for (const note of r.notes ?? []) content.push({ type: "text", text: note });
  if (r.image) content.push({ type: "image", data: r.image.toString("base64"), mimeType: "image/png" });
  return { content };
}

export function toMcpError(e: unknown): { isError: true; content: TextBlock[] } {
  const text = e instanceof ToolError ? e.message : `Something went wrong: ${e instanceof Error ? e.message : String(e)}`;
  return { isError: true, content: [{ type: "text", text }] };
}
