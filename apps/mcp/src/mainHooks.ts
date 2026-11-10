// Code that runs inside the test copy's Electron main process (sent there as text by Playwright's
// evaluate), so it must be self-contained: no imports and nothing from this file's scope.

/**
 * Closes the test copy once the MCP server that launched it has gone. A server that is stopped
 * abruptly can't close the app itself, and the app would otherwise stay open holding port 8790.
 */
export function exitWhenParentGone(
  electron: { app: { exit(code: number): void } },
  opts: { pid: number; everyMs: number; isAlive?: (pid: number) => boolean },
): void {
  const isAlive = opts.isAlive ?? ((pid: number) => {
    // Signal 0 sends nothing: it only asks whether the process exists.
    try { process.kill(pid, 0); return true; } catch (e) { return (e as { code?: string }).code === "EPERM"; }
  });
  const timer = setInterval(() => {
    if (isAlive(opts.pid)) return;
    clearInterval(timer);
    electron.app.exit(0);
  }, opts.everyMs);
}
