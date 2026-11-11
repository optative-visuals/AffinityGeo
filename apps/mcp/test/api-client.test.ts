import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer } from "../../companion/src/server.js";
import { createApiClient, type ApiClient } from "../src/apiClient.js";
import { NOT_RUNNING } from "../src/driver.js";
import { apiRequest } from "../src/tools/data.js";
import { ToolError, type ToolContext } from "../src/tool.js";

let srv: Awaited<ReturnType<typeof startServer>>;
let client: ApiClient;

beforeAll(async () => {
  srv = await startServer({ port: 0 });
  client = createApiClient(`http://127.0.0.1:${srv.port}`);
});
afterAll(() => srv.close());

describe("the API client", () => {
  it("sends the app header, so GET affinity is allowed", async () => {
    expect(await client.request("GET", "affinity")).toEqual({ status: 200, body: { connected: false, busy: false } });
  });
  it("sends JSON on POST (no 415)", async () => {
    expect((await client.request("POST", "send", {})).status).not.toBe(415);
  });
  it("sends JSON on a POST with no body too", async () => {
    expect((await client.request("POST", "send")).status).not.toBe(415);
  });
  it("returns the app's error body instead of throwing", async () => {
    const r = await client.request("GET", "nothing-here");
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: "There's nothing at that address." });
  });
  it("accepts a path written with /api/ or a leading slash, and keeps the query", async () => {
    expect((await client.request("GET", "/api/affinity")).status).toBe(200);
    expect((await client.request("GET", "/affinity")).status).toBe(200);
    expect((await client.request("GET", "places?q=")).body).toEqual([]);
  });
  it("says the app isn't running when nothing listens", async () => {
    await expect(createApiClient("http://127.0.0.1:1").request("GET", "affinity")).rejects.toThrow(NOT_RUNNING);
  });
  it("refuses a path that leaves /api", async () => {
    await expect(client.request("GET", "../affinity/next")).rejects.toThrow(ToolError);
    // Extra slashes can't point the request at another host: it stays under /api.
    expect((await client.request("GET", "//example.com/x")).status).toBe(404);
  });
});

describe("api_request", () => {
  it("returns the status and body", async () => {
    const ctx = { api: client } as ToolContext;
    expect(await apiRequest.run(ctx, { method: "GET", path: "affinity" })).toEqual({ json: { status: 200, body: { connected: false, busy: false } } });
  });
});
