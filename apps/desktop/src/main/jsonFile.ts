// Small JSON files (settings, recent projects) written so that a crash or power cut can't leave them half-written.
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Writes to <file>.tmp in the same folder, then renames it over the target. Throws on failure, leaving the old file intact. */
export function writeJsonAtomic(file: string, value: unknown): void {
  const tmp = `${file}.tmp`;
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(tmp, JSON.stringify(value, null, 2));
    renameSync(tmp, file);
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch { /* nothing more to do */ }
    throw e;
  }
}
