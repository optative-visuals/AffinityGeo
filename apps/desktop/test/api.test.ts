import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiFail, api, isNotConnected, pendingRequests } from "../src/ui/api.js";

function reply(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("api", () => {
  it("api adds X-Geo-App and turns a 400 into ApiFail with the server message and position", async () => {
    const fetch = vi.fn(async () => reply(400, { error: "Unexpected word at 9", position: 9 }));
    vi.stubGlobal("fetch", fetch);
    const err = await api.match("buildings", "height > ").catch((e) => e);
    expect(err).toBeInstanceOf(ApiFail);
    expect(err.status).toBe(400);
    expect(err.message).toBe("Unexpected word at 9");
    expect(err.position).toBe(9);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/data/buildings/match?filter=height%20%3E%20");
    expect(new Headers(init.headers).get("X-Geo-App")).toBe("1");
  });

  it("sends JSON bodies with the content type the server requires", async () => {
    const fetch = vi.fn(async () => reply(200, { mapId: "m1" }));
    vi.stubGlobal("fetch", fetch);
    await api.patchMap("m 1", { scale: 2500 });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/maps/m%201");
    expect(init.method).toBe("PATCH");
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
    expect(JSON.parse(String(init.body))).toEqual({ scale: 2500 });
  });

  it("isNotConnected is true only for a 503", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply(503, { error: "Affinity isn't connected." })));
    const err = await api.targets().catch((e) => e);
    expect(isNotConnected(err)).toBe(true);
    expect(isNotConnected(new ApiFail(504, "x"))).toBe(false);
    expect(isNotConnected(new Error("x"))).toBe(false);
  });

  it("project() reads 409 (no project open) as project null", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply(409, { error: "No project is open." })));
    expect(await api.project()).toEqual({ project: null, dirty: false, counts: null });
  });

  it("a network failure becomes ApiFail 0, and pending writes are counted", async () => {
    let release!: () => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((_, reject) => { release = () => reject(new TypeError("Failed to fetch")); })));
    const p = api.save().catch((e) => e);
    expect(pendingRequests()).toBe(1);
    release();
    const err = await p;
    expect(err).toBeInstanceOf(ApiFail);
    expect(err.status).toBe(0);
    expect(pendingRequests()).toBe(0);
  });
});
