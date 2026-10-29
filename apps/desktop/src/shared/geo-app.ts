// What the Electron preload exposes as window.geoApp. A plain browser has no bridge; platform.ts fills the gaps.
export type ThemeMode = "light" | "dark" | "system";

/** What the app remembers between launches (settings.json next to recent.json). */
export interface AppSettings {
  /** Light, Dark or System (the default). */
  appearance: ThemeMode;
  /** The first-run checklist was finished with Done. */
  firstRunDone: boolean;
}

/** The only page openExternal() may open. */
export const GITHUB_URL = "https://github.com/optative-visuals/AffinityGeo";

export interface GeoApp {
  version: string;
  /** The .afgeo open dialog; null when cancelled. */
  openProject(): Promise<string | null>;
  saveProjectAs(suggested: string): Promise<string | null>;
  /** shp / geojson / json / kml / gpx / csv. */
  openDataFile(): Promise<string | null>;
  copyText(text: string): Promise<void>;
  setTheme(mode: ThemeMode): Promise<void>;
  recent(): Promise<string[]>;
  addRecent(path: string): Promise<string[]>;
  settings(): Promise<AppSettings>;
  /** Merges and stores a change; resolves with the full settings. */
  saveSettings(patch: Partial<AppSettings>): Promise<AppSettings>;
  /** Opens a web page in the browser. Only GITHUB_URL is allowed. */
  openExternal(url: string): Promise<void>;
  /** Close guard: the window asks before closing; answer with confirmClose() to let it close. */
  onCloseRequest(cb: () => void): void;
  confirmClose(): void;
  /** The close was asked about and the user stayed (Cancel, or a save that failed). */
  cancelClose(): void;
  /** An update has downloaded: `cb(version)`, at once if one is already waiting. */
  onUpdateReady(cb: (version: string) => void): void;
  /** Close as the close button does (unsaved changes are asked about), then install the update and restart. */
  restartToUpdate(): void;
}

/** IPC channel names, shared by main and preload. */
export const IPC = {
  openProject: "geo:openProject",
  saveProjectAs: "geo:saveProjectAs",
  openDataFile: "geo:openDataFile",
  copyText: "geo:copyText",
  setTheme: "geo:setTheme",
  recent: "geo:recent",
  addRecent: "geo:addRecent",
  settings: "geo:settings",
  saveSettings: "geo:saveSettings",
  openExternal: "geo:openExternal",
  closeGuardReady: "geo:closeGuardReady",
  closeRequest: "geo:closeRequest",
  closeAck: "geo:closeAck",
  confirmClose: "geo:confirmClose",
  closeCancelled: "geo:closeCancelled",
  updateReady: "geo:updateReady",
  updateStatus: "geo:updateStatus",
  restartToUpdate: "geo:restartToUpdate",
} as const;
