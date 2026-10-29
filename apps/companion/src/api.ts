// The /api routes the AffinityGeo app calls. All JSON. See ProjectSession for the project rules.
import { existsSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import {
  PRESETS, buildMapJob, searchPlaces as realSearchPlaces, DataError,
  type PlaceResult, type RoleId,
} from "@affinitygeo/geo-core";
import type { AffinityOp } from "./queue.js";
import { HomeError, loaderText, resolveHome } from "./home.js";
import { ApiError, ProjectSession, type Targets } from "./session.js";

export const MAX_BODY = 50 * 1024 * 1024;

/** What connect.js reported for a job: `{ ok, result }` or `{ ok: false, error }`. */
export interface AffinityOutcome { ok?: boolean; result?: unknown; error?: string }

export interface ApiDeps {
  session: ProjectSession;
  /**
   * Queues a job and waits for Affinity. Throws ApiError(503) if Affinity isn't connected (nobody
   * polling, or the job wasn't picked up), or ApiError(504) if a running job passes the run cap.
   */
  affinity: (op: AffinityOp) => Promise<AffinityOutcome>;
  /** Whether connect.js is polling, and whether it is running a job. Queues nothing. */
  affinityState?: () => { connected: boolean; busy: boolean };
  searchPlaces?: (q: string) => Promise<PlaceResult[]>;
  /** AffinityGeo's folder (where the Affinity scripts are installed). Defaults to resolveHome(). */
  home?: string;
  /** Where loader.js is (the packaged copy in the app), and a note about the scripts install to show the designer. */
  scripts?: () => { loaderPath?: string; note: string | null };
}

export async function readJson(req: IncomingMessage): Promise<Record<string, any>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) {
      req.resume();
      throw new ApiError(413, "That request is too large (the limit is 50 MB).");
    }
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
    return v;
  } catch {
    throw new ApiError(400, "The request body isn't valid JSON.");
  }
}

function requireString(body: Record<string, any>, key: string): string {
  const v = body[key];
  if (typeof v !== "string" || v.trim() === "") throw new ApiError(400, `Please provide "${key}".`);
  return v;
}

function intParam(url: URL, key: string, fallback: number, max: number): number {
  const raw = url.searchParams.get(key);
  if (raw === null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > max) throw new ApiError(400, `${key} must be a whole number from 0 to ${max.toLocaleString("en-GB")}.`);
  return n;
}

interface SendResult {
  mapId: string; ok: boolean;
  created?: number; updated?: number; removed?: number;
  keptEdited?: unknown[]; resized?: boolean; warnings?: string[];
  error?: string; needsResizeChoice?: true; artboardMm?: { width: number; height: number };
}

const failed = (mapId: string, error: string): SendResult => ({
  mapId, ok: false, created: 0, updated: 0, removed: 0, keptEdited: [], resized: false, warnings: [], error,
});

const OTHER_PROJECT = "Another project was opened, so this map wasn't sent.";
const MAP_DELETED = "This map was deleted before it could be sent.";

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export function createApi(deps: ApiDeps) {
  const { session } = deps;
  const search = deps.searchPlaces ?? ((q: string) => realSearchPlaces(q));
  // One send at a time: each reads the documents, then draws.
  let sendLock: Promise<unknown> = Promise.resolve();

  /** An Affinity call whose failure is an API error (502), for routes that aren't per-map. A 503/504 from the wait passes through. */
  async function affinityResult(op: AffinityOp): Promise<unknown> {
    const o = await deps.affinity(op);
    if (o && o.ok === false) throw new ApiError(502, `Affinity reported a problem: ${o.error ?? "unknown error"}`);
    return o?.result;
  }

  async function listTargets(): Promise<Targets> {
    const r = (await affinityResult({ op: "listTargets" })) as Partial<Targets> | undefined;
    return { documents: Array.isArray(r?.documents) ? r!.documents : [] };
  }

  async function sendMaps(body: Record<string, any>): Promise<{ results: SendResult[] }> {
    const project = session.current;
    const reset = body.reset === true;
    let ids: string[] | null = null;
    if (body.mapIds !== undefined) {
      if (!Array.isArray(body.mapIds) || !body.mapIds.every((x: unknown) => typeof x === "string")) {
        throw new ApiError(400, "mapIds must be a list of map ids.");
      }
      ids = body.mapIds;
      for (const id of ids!) session.map(id); // 404 for an unknown map before anything is sent
    }
    if (!project.maps.length) return { results: [] };

    const targets = await listTargets();
    const queue = ids ?? project.maps.filter((m) => session.statusOf(targets, m.id) !== "Up to date").map((m) => m.id);
    const results: SendResult[] = [];
    let stopped: string | null = null; // Affinity stopped answering: don't wait a minute per map

    for (const mapId of queue) {
      if (session.project !== project) { results.push(failed(mapId, OTHER_PROJECT)); continue; }
      const map = project.maps.find((m) => m.id === mapId);
      if (!map) { results.push(failed(mapId, MAP_DELETED)); continue; }
      if (stopped) { results.push(failed(mapId, stopped)); continue; }

      // Review Focus 3: never draw into whichever document happens to be open.
      if (session.statusOf(targets, mapId) === "Target not open") {
        results.push(failed(mapId, `Open '${map.target!.docTitle}' in Affinity to update ${map.name}`));
        continue;
      }

      let resizeArtboard = map.resizeArtboard;
      if (resizeArtboard === null) {
        const ab = session.artboardFor(targets, mapId);
        if (ab) {
          if (Math.abs(ab.widthMm - map.sizeMm.width) > 0.5 || Math.abs(ab.heightMm - map.sizeMm.height) > 0.5) {
            results.push({ mapId, ok: false, needsResizeChoice: true, artboardMm: { width: ab.widthMm, height: ab.heightMm } });
            continue;
          }
        } else {
          // No artboard yet: Affinity makes one at the map's size, so the answer is settled.
          session.patchMap(mapId, { resizeArtboard: true });
          resizeArtboard = true;
        }
      }

      const job = buildMapJob(project, session.data, mapId);
      let outcome: AffinityOutcome;
      try {
        outcome = await deps.affinity({
          op: "sendMap", job, target: map.target, resizeArtboard, reset, sentIds: map.sent?.objectIds ?? [],
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        results.push(failed(mapId, msg));
        // Don't queue more behind a map Affinity is still drawing, or wait again for an absent Affinity.
        stopped = e instanceof ApiError && e.status === 504 ? "Not sent, because Affinity was still drawing an earlier map." : msg;
        continue;
      }
      if (!outcome || outcome.ok === false) {
        results.push(failed(mapId, outcome?.error ?? "Affinity reported a problem."));
        continue;
      }
      const r = (outcome.result ?? {}) as Record<string, unknown>;
      session.recordSent(project.id, mapId, job.hash, r);
      results.push({
        mapId, ok: true, created: num(r.created), updated: num(r.updated), removed: num(r.removed),
        keptEdited: Array.isArray(r.keptEdited) ? r.keptEdited : [], resized: r.resized === true,
        warnings: Array.isArray(r.warnings) ? r.warnings.filter((w): w is string => typeof w === "string") : [],
      });
    }
    return { results };
  }

  /** Returns the response body, or undefined when no route matches. */
  return async function handle(method: string, parts: string[], url: URL, req: IncomingMessage): Promise<unknown> {
    const [, area, a, b] = parts; // parts[0] === "api"
    const n = parts.length;
    const body = method === "POST" || method === "PATCH" ? await readJson(req) : {};

    if (area === "affinity" && n === 2 && method === "GET") {
      return deps.affinityState ? deps.affinityState() : { connected: false, busy: false };
    }

    if (area === "presets" && n === 2 && method === "GET") return PRESETS.map((p) => ({ name: p.presetName }));

    if (area === "places" && n === 2 && method === "GET") {
      try {
        return await search(url.searchParams.get("q") ?? "");
      } catch (e) {
        if (e instanceof DataError) throw new ApiError(503, e.message);
        throw e;
      }
    }

    if (area === "project") {
      if (n === 2 && method === "GET") return { project: session.current, dirty: session.dirty, counts: session.counts() };
      if (n === 3 && method === "POST") {
        if (a === "new") {
          const areaIn = (body.area ?? {}) as { placeName: string; bboxWgs84: unknown };
          const { project, warning } = session.create(body.name, areaIn, body.preset ?? "Light");
          return warning ? { ...project, warning } : project;
        }
        if (a === "open") return session.open(requireString(body, "path"));
        if (a === "area") return session.setProjection(body.projectionId, body.projectionParams);
        if (a === "save") {
          await session.save(body.path === undefined ? undefined : requireString(body, "path"));
          return { ok: true };
        }
      }
    }

    if (area === "data") {
      if (n === 3 && method === "POST") {
        if (a === "refresh") return session.refresh();
        if (a === "import") {
          const datasetName = typeof body.datasetName === "string" ? body.datasetName : undefined;
          return { counts: await session.importFile(requireString(body, "path"), requireString(body, "role"), datasetName) };
        }
        if (a === "source") return { counts: session.setSource(requireString(body, "role"), body.source) };
      }
      if (n === 4 && a && b === "features" && method === "GET") {
        const q = url.searchParams.get("q") ?? "";
        const sort = url.searchParams.get("sort") || undefined;
        return session.features(a, q, intParam(url, "offset", 0, Number.MAX_SAFE_INTEGER), intParam(url, "limit", 100, 1000), sort, url.searchParams.get("dir") || "asc");
      }
      if (n === 4 && a && b === "match" && method === "GET") {
        return { fids: session.matching(a, url.searchParams.get("filter") ?? "").fids };
      }
      if (n === 4 && a && b === "select" && method === "POST") {
        const mapId = requireString(body, "mapId");
        const map = session.map(mapId);
        const { role, fids } = session.matching(a, body.filter);
        const r = (await affinityResult({ op: "selectOnMap", projectId: session.current.id, mapId: map.id, role: role as RoleId, fids })) as { selected?: unknown } | undefined;
        return { matched: fids.length, selected: num(r?.selected) };
      }
    }

    if (area === "preview" && a === "area" && n === 3 && method === "GET") return session.areaPreview();

    if (area === "projections" && n === 2 && method === "GET") return session.projections();

    if (area === "scripts" && n === 2 && method === "GET") {
      let home: string;
      try { home = deps.home ?? resolveHome(); }
      catch (e) { if (e instanceof HomeError) throw new ApiError(400, e.message); throw e; }
      const sc = deps.scripts?.();
      return {
        loader: sc?.loaderPath ? loaderText(home, sc.loaderPath) : loaderText(home),
        home, installed: existsSync(path.join(home, "affinity", "connect.js")), scriptsNote: sc?.note ?? null,
      };
    }

    if (area === "style" && method === "POST") {
      if (n === 2) return session.updateStyle(body);
      if (n === 3 && a === "preset") return session.applyPreset(requireString(body, "name"));
    }

    if (area === "maps") {
      if (n === 2 && method === "POST") return session.addMap(body as any);
      if (n === 3 && a === "status" && method === "GET") {
        if (!session.current.maps.length) return [];
        return session.statuses(await listTargets());
      }
      if (n === 4 && a && b === "preview" && method === "GET") { session.map(a); return buildMapJob(session.current, session.data, a); }
      if (n === 4 && a && b === "link" && method === "POST") {
        const map = session.map(a);
        const docId = requireString(body, "docId");
        const artboardIndex = body.artboardIndex;
        if (!Number.isInteger(artboardIndex) || artboardIndex < 0) throw new ApiError(400, "Please provide \"artboardIndex\".");
        if (typeof body.artboardName !== "string") throw new ApiError(400, "Please provide \"artboardName\".");
        const project = session.current;
        // Where the map is now, to tell a re-link to the same artboard from a move to another one.
        const before = session.artboardFor(await listTargets(), map.id);
        const otherMapNames: Record<string, string> = {};
        for (const m of project.maps) if (m.id !== map.id) otherMapNames[m.id] = m.name;
        const r = (await affinityResult({
          op: "linkArtboard", projectId: project.id, mapId: map.id, docId, artboardIndex, artboardName: body.artboardName, otherMapNames,
        })) as { docId?: unknown; docTitle?: unknown } | undefined;
        if (session.project !== project || !project.maps.includes(map)) throw new ApiError(409, "The project changed while linking. Pick the artboard again.");
        const target = typeof r?.docId === "string" && typeof r?.docTitle === "string" ? { docId: r.docId, docTitle: r.docTitle } : null;
        if (!target) throw new ApiError(502, "Affinity reported a problem: no document came back.");
        const moved = !before || before.docId !== target.docId || before.index !== artboardIndex;
        return { map: session.linkMap(map.id, target, moved) };
      }
      if (n === 3 && a && method === "PATCH") return session.patchMap(a, body);
      if (n === 3 && a && method === "DELETE") { session.deleteMap(a); return { ok: true }; }
    }

    if (area === "targets" && n === 2 && method === "GET") return listTargets();

    if (area === "send" && n === 2 && method === "POST") {
      const run = sendLock.then(() => sendMaps(body));
      sendLock = run.catch(() => undefined);
      return run;
    }

    return undefined;
  };
}
