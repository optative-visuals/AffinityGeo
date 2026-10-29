// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { badgeFor } from "../src/ui/maps/status.js";
import { getActions, getApp, resetApp, setApp, useAppPolling, type AppState } from "../src/ui/store.js";

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function Poller() { useAppPolling(); return null; }

const project = { id: "p1", name: "W", maps: [{ id: "m1", target: { docId: "d", docTitle: "Doc" } }] } as unknown as NonNullable<AppState["project"]>;

beforeEach(() => { vi.useFakeTimers(); resetApp(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("store polling", () => {
  it("polls /api/affinity every 2 s, statuses every 5 s while connected, and stops on unmount", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(url);
      if (url === "/api/affinity") return reply({ connected: true, busy: false });
      if (url === "/api/project") return reply({ project, dirty: false, counts: {} });
      if (url === "/api/maps/status") return reply([{ mapId: "m1", status: "Up to date" }]);
      if (url === "/api/targets") return reply({ documents: [{ docId: "d", title: "Doc", artboards: [] }] });
      return reply({ error: "nope" }, 404);
    }));
    const { unmount } = render(<Poller />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(getApp().connection.connected).toBe(true);
    expect(getApp().project?.name).toBe("W");

    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(calls.filter((c) => c === "/api/affinity").length).toBeGreaterThanOrEqual(3);
    expect(getApp().statuses).toEqual({ m1: "Up to date" });
    expect(getApp().targets).toHaveLength(1);

    unmount();
    const before = calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
    expect(calls.length).toBe(before);
  });

  it("a map with no target reads \"Not sent\" whatever its server status", () => {
    expect(badgeFor({ target: null }, "Up to date")).toBe("Not sent");
    expect(badgeFor({ target: { docId: "d", docTitle: "D" } }, "Changed since sent")).toBe("Changed since sent");
    expect(badgeFor({ target: { docId: "d", docTitle: "D" } }, undefined)).toBe("Not sent");
  });

  it("after a project switch, a failed preview read drops the previous project's area", async () => {
    vi.useRealTimers();
    const data = { bounds: [0, 0, 1, 1], layers: [] };
    let fail = false;
    vi.stubGlobal("fetch", vi.fn(async () => (fail ? reply({ error: "The preview broke." }, 500) : reply(data))));
    setApp({ project });
    await getActions().refreshPreview();
    expect(getApp().preview.status).toBe("ready");
    // The same project: a failed re-read keeps what is shown.
    fail = true;
    await getActions().refreshPreview().catch(() => undefined);
    expect(getApp().preview.status).toBe("ready");
    // Another project: the old area must not stay on screen.
    setApp({ project: { ...project, id: "p2" } });
    await getActions().refreshPreview().catch(() => undefined);
    expect(getApp().preview).toEqual({ status: "none" });
  });
});
