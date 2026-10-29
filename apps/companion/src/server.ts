import { createReadStream, lstatSync } from "node:fs";
import path from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { FilterError, type PlaceResult } from "@affinitygeo/geo-core";
import { createApi, type AffinityOutcome } from "./api.js";
import { AffinityWaitError, JobQueue, NOT_CONNECTED, type AffinityOp, type QueueLimits } from "./queue.js";
import { ApiError, ProjectSession, type FetchOsm } from "./session.js";

const FOREIGN_HOST = "AffinityGeo only accepts requests from this computer.";
const NOT_APP = "Only the AffinityGeo app can use this address.";
const NOT_CONNECT = "Only the Geo – Connect script in Affinity can use this address.";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png",
};

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(text) });
  res.end(text);
}

export interface ServerOptions {
  port?: number;
  /** How long to wait for Affinity; see QueueLimits. Tests shorten these. */
  affinityLimits?: Partial<QueueLimits>;
  /** Injectable for tests; defaults to the real Overpass fetch. */
  fetchOsm?: FetchOsm;
  /** Injectable for tests; defaults to the real Nominatim search. */
  searchPlaces?: (q: string) => Promise<PlaceResult[]>;
  /** AffinityGeo's folder, for the scripts route. Defaults to the usual one. */
  home?: string;
  /** The packaged loader.js and a note about the scripts install. A note with `untilConnected` clears on the first poll whose X-Geo-Scripts header equals `version` (an old poller doesn't count). */
  scripts?: { loaderPath?: string; note?: string | null; untilConnected?: boolean; version?: string };
  /** A folder of built UI files, served at / (only regular files directly inside it). */
  uiDir?: string;
}

/** The regular file directly inside `dir` that the address names, or null. Anything that looks like climbing out is null. */
function staticFile(dir: string, rawUrl: string, parts: string[]): { full: string; name: string; size: number } | null {
  const rawPath = rawUrl.split(/[?#]/)[0]!;
  if (/\.\.|%2e|%2f|%5c|\\/i.test(rawPath)) return null;
  if (parts.length > 1) return null;
  const name = parts[0] ?? "index.html";
  if (!name || name.startsWith(".") || /[\\/\0:]/.test(name)) return null;
  const full = path.join(dir, name);
  try {
    const st = lstatSync(full); // lstat: a symlink is not a regular file here
    return st.isFile() ? { full, name, size: st.size } : null;
  } catch {
    return null;
  }
}

export async function startServer(opts: ServerOptions = {}): Promise<{ port: number; session: ProjectSession; close(): Promise<void> }> {
  const queue = new JobQueue(Date.now, opts.affinityLimits);
  const session = new ProjectSession(opts.fetchOsm ? { fetchOsm: opts.fetchOsm } : {});
  let port = 0;

  // A job Affinity finished after the app stopped waiting. The API call already reported a
  // failure, so the result is only logged: a late sendMap is never recorded as sent (the next
  // send compares against the document again).
  queue.onLateCompletion = (op, outcome) => {
    const o = outcome as AffinityOutcome | null;
    const what = op.op === "sendMap" ? `Sending '${op.job.mapName}'` : `A ${op.op} job`;
    console.log(`${what} finished in Affinity after the time limit (${o?.ok === false ? `it failed: ${o.error}` : "it worked"}). Send again to update AffinityGeo.`);
  };

  async function affinity(op: AffinityOp): Promise<AffinityOutcome> {
    // Nobody polling and nothing running: say so now rather than queue a job nobody will take.
    if (!queue.connected()) throw new ApiError(503, NOT_CONNECTED);
    const id = queue.push(op);
    try {
      return ((await queue.waitFor(id)) ?? {}) as AffinityOutcome;
    } catch (e) {
      // Not taken yet: drop it so it can't run later. Already running: it is never handed out
      // again, and onLateCompletion gets its result.
      queue.cancel(id);
      if (e instanceof AffinityWaitError) throw new ApiError(e.kind === "notConnected" ? 503 : 504, e.message);
      throw e;
    }
  }

  let scriptsNote: string | null = opts.scripts?.note ?? null;
  const scripts = () => ({ ...(opts.scripts?.loaderPath ? { loaderPath: opts.scripts.loaderPath } : {}), note: scriptsNote });
  const api = createApi({ session, scripts, affinity, affinityState: () => ({ connected: queue.connected(), busy: queue.busy() }), ...(opts.searchPlaces ? { searchPlaces: opts.searchPlaces } : {}), ...(opts.home ? { home: opts.home } : {}) });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    let parts: string[];
    try { parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent); }
    catch { throw new ApiError(400, "That address isn't valid."); }
    const method = req.method ?? "GET";

    // Only this computer: a web page elsewhere can't reach the app through DNS tricks.
    const host = req.headers.host;
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) throw new ApiError(403, FOREIGN_HOST);
    // A custom header makes a browser ask first (a preflight this server never answers), so no other web page can call the API.
    if (parts[0] === "api" && req.headers["x-geo-app"] !== "1") throw new ApiError(403, NOT_APP);
    if (parts[0] === "api" && (method === "POST" || method === "PATCH")) {
      // A JSON content type can't be sent cross-site without a CORS preflight, which this server never answers.
      const type = String(req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
      if (type !== "application/json") throw new ApiError(415, "Send the request as JSON (Content-Type: application/json).");
    }

    if (parts[0] === "affinity") {
      // Plain GETs any web page could fire (an <img>, say): the custom header makes a browser
      // ask first with a preflight, which this server never answers, so only connect.js gets in.
      if (req.headers["x-geo-connect"] !== "1") throw new ApiError(403, NOT_CONNECT);
      if (method !== "GET") throw new ApiError(405, "That route only accepts GET.");
      if (parts[1] === "next" && parts.length === 2) {
        const job = queue.next();
        if (opts.scripts?.untilConnected && req.headers["x-geo-scripts"] === opts.scripts.version) scriptsNote = null; // the re-run Geo – Connect is polling: the note has done its job
        return send(res, 200, job ?? { idle: true });
      }
      if (parts[1] === "done" && parts.length === 2) {
        const id = url.searchParams.get("id");
        if (!id) throw new ApiError(400, "Please provide the job id.");
        const header = req.headers["x-geo-result"];
        let result: unknown = { ok: true };
        if (typeof header === "string" && header) {
          try { result = JSON.parse(decodeURIComponent(header)); }
          catch { throw new ApiError(400, "The X-Geo-Result header isn't valid percent-encoded JSON."); }
        }
        queue.complete(id, result);
        return send(res, 200, { ok: true });
      }
    } else if (parts[0] === "api") {
      const body = await api(method, parts, url, req);
      if (body !== undefined) return send(res, 200, body);
    }
    else if (opts.uiDir && (method === "GET" || method === "HEAD")) {
      const file = staticFile(opts.uiDir, req.url ?? "/", parts);
      if (file) {
        const ext = path.extname(file.name).toLowerCase();
        res.writeHead(200, {
          "Content-Type": CONTENT_TYPES[ext] ?? "application/octet-stream", "Content-Length": file.size,
          "X-Content-Type-Options": "nosniff",
        });
        if (method === "HEAD") { res.end(); return; }
        createReadStream(file.full).on("error", () => res.destroy()).pipe(res);
        return;
      }
    }
    throw new ApiError(404, "There's nothing at that address.");
  }

  // Affinity sends results in a header (its POST bodies arrive empty). A map's object ids
  // run to tens of KB, past Node's 16 KB default, which made the result vanish (live, 28 Oct).
  const server = createServer({ maxHeaderSize: 16 * 1024 * 1024 }, (req, res) => {
    handle(req, res).catch((e) => {
      if (res.headersSent) { res.end(); return; }
      if (e instanceof FilterError) return send(res, 400, { error: e.message, position: e.position });
      if (e instanceof ApiError) return send(res, e.status, e.code ? { error: e.message, code: e.code } : { error: e.message });
      console.error(e instanceof Error ? e.stack : e);
      send(res, 500, { error: `Something went wrong: ${e instanceof Error ? e.message : String(e)}` });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 8790, "127.0.0.1", resolve);
  });
  const addr = server.address();
  port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    port,
    session,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}
