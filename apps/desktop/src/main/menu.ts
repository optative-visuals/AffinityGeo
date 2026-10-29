// The application menu. Kept free of Electron runtime imports so it can be tested.
import type { MenuItemConstructorOptions } from "electron";

/**
 * No menu bar on Windows and Linux: the app has its own top bar, and Chromium handles the text-field
 * shortcuts (Ctrl+C, V, X, A, Z) itself. macOS only routes those shortcuts through a menu, so it keeps
 * a minimal one with the edit roles (it lives in the system menu bar, not the window).
 */
export function appMenuTemplate(platform: NodeJS.Platform): MenuItemConstructorOptions[] | null {
  if (platform !== "darwin") return null;
  return [{ role: "appMenu" }, { role: "editMenu" }];
}
