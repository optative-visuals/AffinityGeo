// A tiny log appender for the main process: each line goes to the console and to <logs>/main.log.
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

export function fileLogger(logsDir: () => string): (message: string) => void {
  return (message) => {
    const line = `${new Date().toISOString()} ${message}`;
    console.log(line);
    try {
      const dir = logsDir();
      mkdirSync(dir, { recursive: true });
      appendFileSync(path.join(dir, "main.log"), `${line}\n`);
    } catch { /* logging must never break the app */ }
  };
}
