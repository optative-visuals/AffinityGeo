// @vitest-environment jsdom
// The area preview: an explicit loading / none / ready state, retries, and no stale replies.
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MapsScreen } from "../src/ui/maps/MapsScreen.js";
import { getActions, getApp, resetApp, setApp, useAppPolling, type AppState } from "../src/ui/store.js";

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
const data = (n: number) => ({ bounds: [0, 0, n, n], layers: [] });
const project = {
  id: "p1", name: "W", maps: [], dataVersion: 1,
  area: { placeName: "W", bboxWgs84: [-0.17, 51.50, -0.14, 51.52], projectionId: "bng" },
  style: { presetName: "T", roles: {}, marker: {} },
} as unknown as NonNullable<AppState["project"]>;

function Poller() { useAppPolling(); return null; }

beforeEach(() => {
  resetApp();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("area preview state", () => {
  it("a 409 gives 'none', and the connection poll retries until the data is 'ready'", async () => {
    vi.useFakeTimers();
    let previews = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "/api/affinity") return reply({ connected: false, busy: false });
      if (url === "/api/project") return reply({ project, dirty: false, counts: {} });
      if (url === "/api/preview/area") return ++previews === 1 ? reply({ error: "Fetch the data first." }, 409) : reply(data(5));
      return reply({ error: "nope" }, 404);
    }));
    setApp({ project });
    await act(async () => { await getActions().refreshPreview(); });
    expect(getApp().preview.status).toBe("none");
    render(<Poller />);
    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    expect(getApp().preview.status).toBe("ready");
    expect(getApp().preview.data?.bounds).toEqual([0, 0, 5, 5]);
  });

  it("a slow older reply can't overwrite a newer one", async () => {
    const pending: Array<(r: Response) => void> = [];
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((res) => { pending.push(res); })));
    setApp({ project });
    const { refreshPreview } = getActions();
    const first = refreshPreview();
    const second = refreshPreview();
    pending[1]!(reply(data(2)));
    await second;
    pending[0]!(reply(data(1)));
    await first;
    expect(getApp().preview).toEqual({ status: "ready", data: data(2) });
  });

  it("shows a quiet loading line while loading, and the hint only for 'none'", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    setApp({ project, preview: { status: "loading" } });
    render(<MapsScreen />);
    expect(screen.getByText("Loading the map…")).toBeTruthy();
    expect(screen.queryByText(/No map data yet/)).toBeNull();
    act(() => { setApp({ preview: { status: "none" } }); });
    expect(screen.getByText(/No map data yet/)).toBeTruthy();
    expect(screen.queryByText("Loading the map…")).toBeNull();
  });

  it("a failure other than 409 shows a toast", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply({ error: "The preview broke." }, 500)));
    setApp({ project });
    render(<MapsScreen />); // the Shell mounts the ToastHost
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(screen.getByText("The preview broke.")).toBeTruthy();
    expect(getApp().preview.status).toBe("none");
  });

  it("window focus and visibilitychange re-read the project", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(url);
      if (url === "/api/affinity") return reply({ connected: false, busy: false });
      if (url === "/api/project") return reply({ project, dirty: false, counts: {} });
      return reply({ error: "Fetch the data first." }, 409);
    }));
    render(<Poller />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const n = calls.filter((c) => c === "/api/project").length;
    await act(async () => { window.dispatchEvent(new Event("focus")); await vi.advanceTimersByTimeAsync(0); });
    expect(calls.filter((c) => c === "/api/project").length).toBe(n + 1);
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); await vi.advanceTimersByTimeAsync(0); });
    expect(calls.filter((c) => c === "/api/project").length).toBe(n + 2);
  });
});
