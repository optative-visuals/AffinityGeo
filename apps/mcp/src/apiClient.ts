// Talks to the running app's local API, the same one the AffinityGeo window uses.
import { ToolError } from "./tool.js";

export interface ApiReply { status: number; body: unknown }
export type ApiMethod = "GET" | "POST" | "PATCH" | "DELETE";
export interface ApiClient {
  /** `path` is what follows /api/ (a leading slash or "api/" is fine), query string included. */
  request(method: ApiMethod, path: string, body?: unknown): Promise<ApiReply>;
}

export const APP_ORIGIN = "http://127.0.0.1:8790";
import { NOT_RUNNING } from "./driver.js";

export function createApiClient(origin: string = APP_ORIGIN): ApiClient {
  return {
    async request(method, path, body) {
      const rest = path.replace(/^\/+/, "").replace(/^api\//, "");
      const url = new URL(`/api/${rest}`, origin);
      // The app's other addresses (Affinity's job queue) are not for tests to call.
      if (url.origin !== new URL(origin).origin || !url.pathname.startsWith("/api/") || /^\/|\.\./.test(rest)) {
        throw new ToolError(`'${path}' isn't an address under /api.`);
      }
      const sendsBody = method === "POST" || method === "PATCH";
      let res: Response;
      try {
        res = await fetch(url, {
          method,
          headers: { "X-Geo-App": "1", ...(sendsBody ? { "Content-Type": "application/json" } : {}) },
          ...(sendsBody ? { body: JSON.stringify(body ?? {}) } : {}),
        });
      } catch {
        throw new ToolError(NOT_RUNNING);
      }
      const text = await res.text();
      let parsed: unknown = text;
      try { parsed = JSON.parse(text); } catch { /* not JSON: return the text */ }
      return { status: res.status, body: parsed };
    },
  };
}
