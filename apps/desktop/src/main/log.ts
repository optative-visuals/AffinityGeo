// A tiny log appender for the main process: each line goes to the console and to <logs>/main.log.
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import path from "node:path";
import { inspect } from "node:util";

/** A log bigger than this is moved to main.old.log when the logger first writes (about 2 MB). */
const MAX_LOG_BYTES = 2 * 1024 * 1024;

export function fileLogger(logsDir: () => string, options: { maxBytes?: number } = {}): (message: string) => void {
  const maxBytes = options.maxBytes ?? MAX_LOG_BYTES;
  let checkedSize = false;
  return (message) => {
    const line = `${new Date().toISOString()} ${message}`;
    console.log(line);
    try {
      const dir = logsDir();
      mkdirSync(dir, { recursive: true });
      const file = path.join(dir, "main.log");
      if (!checkedSize) {
        checkedSize = true;
        try {
          if (statSync(file).size > maxBytes) renameSync(file, path.join(dir, "main.old.log")); // replaces the previous one
        } catch { /* no log yet, or it can't be rotated: carry on appending */ }
      }
      appendFileSync(file, `${line}\n`);
    } catch { /* logging must never break the app */ }
  };
}

function formatOne(v: unknown): string {
  try {
    if (typeof v === "string") return v;
    if (v instanceof Error) return v.stack ?? v.message;
    if (v === undefined) return "undefined";
    if (typeof v === "object" && v !== null) {
      try {
        const json = JSON.stringify(v);
        if (json !== undefined) return json;
      } catch { /* circular or hostile: fall through to inspect */ }
      return inspect(v, { depth: 2, breakLength: Infinity });
    }
    return String(v);
  } catch {
    return "[unprintable]";
  }
}

/** console-style arguments as one line of text: strings as-is, Errors by stack, the rest as JSON. Never throws. */
export function formatLogArgs(args: unknown[]): string {
  return args.map(formatOne).join(" ");
}

/**
 * Sends console.error and console.warn to the log as well as the console. The installed app has no console,
 * and the companion server (in this same process) reports its failures that way. Returns a function that undoes it.
 */
export function captureConsole(
  log: (message: string) => void,
  target: { error: (...a: unknown[]) => void; warn: (...a: unknown[]) => void } = console,
): () => void {
  const originals = { error: target.error, warn: target.warn };
  let inside = false;
  const wrap = (level: "error" | "warn") => (...args: unknown[]): void => {
    try { originals[level].apply(target, args); } catch { /* printing must never break the caller */ }
    if (inside) return; // the logger reporting its own trouble must not loop
    inside = true;
    try { log(`[${level}] ${formatLogArgs(args)}`); } catch { /* ignore */ } finally { inside = false; }
  };
  target.error = wrap("error");
  target.warn = wrap("warn");
  return () => { target.error = originals.error; target.warn = originals.warn; };
}
