// The stored settings, cleaned on every read and write (used by main and the browser fallback).
import type { AppSettings, ThemeMode } from "./geo-app.js";

export const DEFAULT_SETTINGS: AppSettings = { appearance: "system", firstRunDone: false };

const isTheme = (v: unknown): v is ThemeMode => v === "light" || v === "dark" || v === "system";

/** Anything (a parsed file, a bad value) → valid settings; unknown keys are dropped. */
export function cleanSettings(v: unknown): AppSettings {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  return {
    appearance: isTheme(o.appearance) ? o.appearance : DEFAULT_SETTINGS.appearance,
    firstRunDone: o.firstRunDone === true,
  };
}

/** The current settings with the valid parts of `patch` on top. */
export function mergeSettings(current: AppSettings, patch: unknown): AppSettings {
  const p = patch && typeof patch === "object" ? (patch as Record<string, unknown>) : {};
  const base = cleanSettings(current);
  return {
    appearance: isTheme(p.appearance) ? p.appearance : base.appearance,
    firstRunDone: typeof p.firstRunDone === "boolean" ? p.firstRunDone : base.firstRunDone,
  };
}
