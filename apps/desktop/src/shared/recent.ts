// The recent-projects list, shared by the Electron main process (a JSON file) and the browser fallback (localStorage).
export const MAX_RECENT = 8;

/** Windows paths (C:\… or \\server\…) compare without case and with either slash; others compare exactly. */
function key(p: string): string {
  return /^[a-z]:[\\/]|^\\\\/i.test(p) ? p.replace(/\//g, "\\").toLowerCase() : p;
}

/** Puts `path` first, drops any earlier copy of it, and keeps the newest MAX_RECENT. Never mutates `list`. */
export function pushRecent(list: readonly unknown[], path: string): string[] {
  const clean = list.filter((p): p is string => typeof p === "string" && p.trim() !== "");
  if (path.trim() === "") return clean.slice(0, MAX_RECENT);
  const k = key(path);
  return [path, ...clean.filter((p) => key(p) !== k)].slice(0, MAX_RECENT);
}
