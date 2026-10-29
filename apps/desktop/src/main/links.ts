// Which links the window may open. Kept free of Electron imports so it can be tested.
import { GITHUB_URL } from "../shared/geo-app.js";

/**
 * The window-open handler: only the exact GitHub page opens, in the browser (through `open`).
 * The window itself never opens anything, so the answer is always deny.
 */
export function windowOpenAction(url: string, open: (url: string) => void): { action: "deny" } {
  if (url === GITHUB_URL) open(GITHUB_URL);
  return { action: "deny" };
}
