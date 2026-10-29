import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const requireCjs = createRequire(import.meta.url);
const { tick, runOp } = requireCjs("../src/connect.js");
const sendPlan = requireCjs("../src/send-plan.js");
const plan = requireCjs("../src/plan.js");

const ok = (body) => ({ status: 200, body: JSON.stringify(body) });

function fakeServer(nextReply, doneReply = ok({ ok: true })) {
  const calls = [];
  return {
    calls,
    get(path, timeoutSec, header) {
      calls.push({ path, header });
      if (path === "/affinity/next") {
        if (nextReply instanceof Error) throw nextReply;
        return nextReply;
      }
      if (doneReply instanceof Error) throw doneReply;
      return doneReply;
    },
  };
}

function fakeDrawMap(overrides = {}) {
  const seen = [];
  return {
    seen,
    listTargets: (docs) => { seen.push(["listTargets", docs]); return { documents: [] }; },
    sendMap: (docs, payload, deps) => {
      seen.push(["sendMap", docs, payload, deps]);
      return { created: 1, updated: 0, removed: 0, keptEdited: [], resized: false, warnings: [] };
    },
    selectOnMap: (docs, payload) => { seen.push(["selectOnMap", docs, payload]); return { selected: payload.fids.length }; },
    linkArtboard: (docs, payload) => { seen.push(["linkArtboard", docs, payload]); return { ok: true, docId: payload.docId, docTitle: "Sign.af" }; },
    ...overrides,
  };
}

const DOCS = [{ title: "Sign.af" }];
function ctxFor(server, extra = {}) {
  const drawMap = extra.drawMap || fakeDrawMap();
  return { get: server.get, getDocuments: () => DOCS, drawMap, sendPlan, plan, log: () => {}, ...extra };
}

function decode(call) {
  return JSON.parse(decodeURIComponent(call.header));
}

describe("connect tick: HTTP status", () => {
  it("does nothing more when the server is idle", () => {
    const s = fakeServer(ok({ idle: true }));
    expect(tick(ctxFor(s))).toBe("idle");
    expect(s.calls).toHaveLength(1);
  });

  it("logs a 403 reply with an {error} body as an error, never as idle", () => {
    const lines = [];
    const s = fakeServer({ status: 403, body: JSON.stringify({ error: "That request came from somewhere unexpected." }) });
    expect(tick(ctxFor(s, { log: (l) => lines.push(l) }))).toBe("error");
    expect(s.calls).toHaveLength(1);
    expect(lines.join("\n")).toMatch(/AffinityGeo: .*403.*somewhere unexpected/);
  });

  it("logs a non-2xx reply without a JSON body too", () => {
    const lines = [];
    const s = fakeServer({ status: 500, body: "<html>oops</html>" });
    expect(tick(ctxFor(s, { log: (l) => lines.push(l) }))).toBe("error");
    expect(lines.join("\n")).toMatch(/AffinityGeo: .*500/);
  });

  it("doesn't repeat the same error line on every tick", () => {
    const lines = [];
    const s = fakeServer({ status: 403, body: JSON.stringify({ error: "Nope" }) });
    const ctx = ctxFor(s, { log: (l) => lines.push(l) });
    tick(ctx); tick(ctx); tick(ctx);
    expect(lines).toHaveLength(1);
  });

  it("logs a non-2xx reply to the result upload", () => {
    const lines = [];
    const s = fakeServer(ok({ id: "r-1", op: { op: "listTargets" } }), { status: 404, body: JSON.stringify({ error: "Unknown job" }) });
    expect(tick(ctxFor(s, { log: (l) => lines.push(l) }))).toBe("error");
    expect(lines.join("\n")).toMatch(/AffinityGeo: .*404.*Unknown job/);
  });

  it("swallows network failures", () => {
    const s = fakeServer(new Error("connection refused"));
    expect(tick(ctxFor(s))).toBe("error");
  });

  it("treats a garbled 200 reply as an error", () => {
    const s = fakeServer({ status: 200, body: "{nope" });
    expect(tick(ctxFor(s))).toBe("error");
  });
});

describe("connect tick: jobs", () => {
  it("dispatches a sendMap op to draw-map.sendMap with the parsed payload", () => {
    const job = { mapId: "m1", mapName: "Map 1", projectId: "p1", sizeMm: { width: 420, height: 297 }, layers: [], marker: null, hash: "h" };
    const op = { op: "sendMap", job, target: { docId: "d1", docTitle: "Sign.af" }, resizeArtboard: true, reset: false, sentIds: ["paths:a"] };
    const drawMap = fakeDrawMap();
    const s = fakeServer(ok({ id: "r-2", op }));
    expect(tick(ctxFor(s, { drawMap }))).toBe("done");
    const [name, docs, payload, deps] = drawMap.seen[0];
    expect(name).toBe("sendMap");
    expect(docs).toBe(DOCS);
    expect(payload).toEqual({ job, target: op.target, resizeArtboard: true, reset: false, sentIds: ["paths:a"] });
    expect(deps.sendPlan).toBe(sendPlan);
    expect(deps.plan).toBe(plan);
    expect(s.calls[1].path).toBe("/affinity/done?id=r-2");
    expect(s.calls[1].header).toMatch(/^[\x20-\x7e]+$/);
    expect(decode(s.calls[1])).toEqual({ ok: true, result: { created: 1, updated: 0, removed: 0, keptEdited: [], resized: false, warnings: [] } });
  });

  it("when the full result can't be sent, sends a short failure so the app doesn't wait for nothing", () => {
    const drawMap = fakeDrawMap({ sendMap: () => ({ created: 976, objectIds: ["buildings:a"] }) });
    const lines = [];
    const calls = [];
    const s = {
      calls,
      get(path, t, header) {
        calls.push({ path, header });
        if (path === "/affinity/next") return ok({ id: "r-9", op: { op: "sendMap", job: {} } });
        return calls.length === 2 ? { status: 431, body: "" } : ok({ ok: true });
      },
    };
    expect(tick(ctxFor(s, { drawMap, log: (l) => lines.push(l) }))).toBe("error");
    expect(calls.length).toBe(3);
    expect(calls[2].path).toBe("/affinity/done?id=r-9");
    const fallback = decode(calls[2]);
    expect(fallback.ok).toBe(false);
    expect(fallback.error).toMatch(/drew|couldn't report/i);
    expect(lines.join("\n")).toMatch(/431/);
  });

  it("reports an exception as ok:false with its message and doesn't throw", () => {
    const drawMap = fakeDrawMap({ sendMap: () => { throw new Error("Open 'Sign.af' in Affinity to update Map 1"); } });
    const lines = [];
    const s = fakeServer(ok({ id: "r-3", op: { op: "sendMap", job: {} } }));
    expect(tick(ctxFor(s, { drawMap, log: (l) => lines.push(l) }))).toBe("error");
    expect(decode(s.calls[1])).toEqual({ ok: false, error: "Open 'Sign.af' in Affinity to update Map 1" });
    expect(lines.join("\n")).toMatch(/AffinityGeo: .*Open 'Sign.af'/);
  });

  it("logs when the result can't be sent back", () => {
    const lines = [];
    const s = fakeServer(ok({ id: "r-4", op: { op: "listTargets" } }), new Error("gone"));
    expect(tick(ctxFor(s, { log: (l) => lines.push(l) }))).toBe("error");
    expect(lines.join("\n")).toMatch(/AffinityGeo: .*gone/);
  });

  it("falls back to console.log when no logger is given", () => {
    const orig = console.log;
    const lines = [];
    console.log = (l) => lines.push(String(l));
    try {
      const drawMap = fakeDrawMap({ selectOnMap: () => { throw new Error("Nope"); } });
      const s = fakeServer(ok({ id: "r-5", op: { op: "selectOnMap", projectId: "p", mapId: "m", role: "paths", fids: [] } }));
      const ctx = ctxFor(s, { drawMap });
      delete ctx.log;
      tick(ctx);
    } finally { console.log = orig; }
    expect(lines.join("\n")).toMatch(/Nope/);
  });
});

describe("runOp", () => {
  const env = (drawMap) => ({ getDocuments: () => DOCS, drawMap, sendPlan, plan });

  it("routes listTargets and selectOnMap", () => {
    const d = fakeDrawMap();
    expect(runOp({ op: "listTargets" }, env(d))).toEqual({ documents: [] });
    expect(runOp({ op: "selectOnMap", projectId: "p", mapId: "m", role: "paths", fids: ["a", "b"] }, env(d))).toEqual({ selected: 2 });
    expect(d.seen[1][2]).toEqual({ projectId: "p", mapId: "m", role: "paths", fids: ["a", "b"] });
  });

  it("dispatches linkArtboard", () => {
    const d = fakeDrawMap();
    const op = { op: "linkArtboard", projectId: "p", mapId: "m", docId: "doc-1", artboardIndex: 2, artboardName: "A", otherMapNames: {} };
    expect(runOp(op, env(d))).toEqual({ ok: true, docId: "doc-1", docTitle: "Sign.af" });
    const { op: _o, ...payload } = op;
    expect(d.seen[0][2]).toEqual(payload);
    expect(() => runOp(op, { ...env(d), getDocuments: () => [] })).toThrow(/Open a document in Affinity first/);
  });

  it("refuses unknown and retired job types", () => {
    const d = fakeDrawMap();
    expect(() => runOp({ op: "explode" }, env(d))).toThrow(/Unknown job type/);
    expect(() => runOp({ op: "drawLayer" }, env(d))).toThrow(/Unknown job type/);
    expect(() => runOp(null, env(d))).toThrow(/wasn't understood/);
  });

  it("says to open a document when none is open", () => {
    const d = fakeDrawMap();
    expect(() => runOp({ op: "sendMap", job: {} }, { ...env(d), getDocuments: () => [] })).toThrow(/Open a document in Affinity first/);
    // listing targets with nothing open is fine: an empty list
    expect(runOp({ op: "listTargets" }, { ...env(d), getDocuments: () => [] })).toEqual({ documents: [] });
  });
});

describe("readVersion", () => {
  const { readVersion } = requireCjs("../src/connect.js");
  const fs = requireCjs("node:fs");
  const os = requireCjs("node:os");
  const path = requireCjs("node:path");
  it("reads <home>/affinity/version.js, and falls back to unknown", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "geo-ver-"));
    try {
      expect(readVersion(dir.replace(/\\/g, "/"))).toBe("unknown");
      fs.mkdirSync(path.join(dir, "affinity"));
      fs.writeFileSync(path.join(dir, "affinity", "version.js"), 'module.exports = "3.2.1";');
      expect(readVersion(dir.replace(/\\/g, "/"))).toBe("3.2.1");
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("makeGet", () => {
  const { makeGet } = requireCjs("../src/connect.js");
  function fakeHttp() {
    const made = [];
    const HttpRequest = {
      create(url, method) {
        const r = { url, method, headers: {}, timeout: null };
        made.push(r);
        return {
          setTimeoutInSec: (s) => { r.timeout = s; },
          setHeaderValue: (k, v) => { r.headers[k] = v; },
          do: () => ({ response: { statusCode: 200, content: '{"idle":true}' } }),
        };
      },
    };
    return { made, HttpRequest, RequestMethod: { Get: "GET" } };
  }

  it("sends X-Geo-Scripts with the script version on every request", () => {
    const h = fakeHttp();
    const get = makeGet(h.HttpRequest, h.RequestMethod, "http://127.0.0.1:8790", "4.5.6");
    get("/affinity/next", 2, null);
    get("/affinity/done?id=1", 10, "%7B%7D");
    expect(h.made[0].headers["X-Geo-Scripts"]).toBe("4.5.6");
    expect(h.made[1].headers["X-Geo-Scripts"]).toBe("4.5.6");
  });

  it("sends X-Geo-Connect: 1 on every request, and the result header when given", () => {
    const h = fakeHttp();
    const get = makeGet(h.HttpRequest, h.RequestMethod, "http://127.0.0.1:8790");
    expect(get("/affinity/next", 10, null)).toEqual({ status: 200, body: '{"idle":true}' });
    get("/affinity/done?id=1", 10, "%7B%7D");
    expect(h.made[0]).toEqual({ url: "http://127.0.0.1:8790/affinity/next", method: "GET", headers: { "X-Geo-Connect": "1" }, timeout: 10 });
    expect(h.made[1].headers).toEqual({ "X-Geo-Connect": "1", "X-Geo-Result": "%7B%7D" });
  });
});
