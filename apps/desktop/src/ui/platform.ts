// window.geoApp inside Electron, or plain-browser stand-ins (for working on the UI in a browser tab).
import { GITHUB_URL, type AppSettings, type GeoApp, type ThemeMode } from "../shared/geo-app.js";
import { pushRecent } from "../shared/recent.js";
import { cleanSettings, mergeSettings } from "../shared/settings.js";

export type { AppSettings, GeoApp, ThemeMode };

declare global {
  interface Window { geoApp?: GeoApp }
}
declare const __GEO_VERSION__: string | undefined;

const RECENT_KEY = "affinitygeo.recent";
const SETTINGS_KEY = "affinitygeo.settings";

/** `data-theme` on <html>: tokens.css follows it, and the OS setting when it is absent ("system"). */
export function applyTheme(mode: ThemeMode): void {
  const root = document.documentElement;
  if (mode === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", mode);
}

function readRecent(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(v) ? pushRecent(v, "") : [];
  } catch {
    return [];
  }
}

function readSettings(): AppSettings {
  try {
    return cleanSettings(JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "null"));
  } catch {
    return cleanSettings(null);
  }
}

function ask(message: string, suggested = ""): Promise<string | null> {
  const v = window.prompt(message, suggested);
  return Promise.resolve(v && v.trim() ? v.trim() : null);
}

const browser: GeoApp = {
  version: typeof __GEO_VERSION__ === "string" ? __GEO_VERSION__ : "dev",
  openProject: () => ask("Path to the project file"),
  saveProjectAs: (suggested) => ask("Path to the project file", suggested),
  openDataFile: () => ask("Path to the data file (shp, geojson, json, kml, gpx or csv)"),
  copyText: async (text) => { await navigator.clipboard.writeText(text); },
  setTheme: async (mode) => { applyTheme(mode); },
  recent: async () => readRecent(),
  addRecent: async (path) => {
    const list = pushRecent(readRecent(), path);
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch { /* storage blocked: keep it for this call only */ }
    return list;
  },
  settings: async () => readSettings(),
  saveSettings: async (patch) => {
    const next = mergeSettings(readSettings(), patch);
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(next)); } catch { /* storage blocked: forgotten on reload */ }
    return next;
  },
  openExternal: async (url) => {
    if (url !== GITHUB_URL) throw new Error("Not allowed.");
    window.open(GITHUB_URL, "_blank", "noopener");
  },
  onCloseRequest: () => { /* a browser tab has no close guard */ },
  confirmClose: () => {},
  cancelClose: () => {},
  onUpdateReady: () => { /* a browser tab never updates itself */ },
  restartToUpdate: () => {},
};

function fromBridge(bridge: GeoApp): GeoApp {
  return {
    ...bridge,
    // Electron sets nativeTheme (and so prefers-color-scheme); data-theme keeps the page in step at once.
    setTheme: async (mode) => { applyTheme(mode); await bridge.setTheme(mode); },
  };
}

const bridge = typeof window !== "undefined" ? window.geoApp : undefined;

export const platform: GeoApp = bridge ? fromBridge(bridge) : browser;
