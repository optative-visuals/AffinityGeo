// AffinityGeo – connect.js (GPL-3.0-or-later)
// Polls the AffinityGeo app for jobs and runs them in the open documents.
// Plain CommonJS, ES2020. SDK modules are required inside start() so the
// job-handling logic can be tested in Node with fakes.
//
// Rules: never show UI from a timer callback, never throw out of it.
'use strict';

const DEFAULT_SERVER = 'http://127.0.0.1:8790';
const DEFAULT_HOME = 'C:/AffinityGeo';
const NOT_RUNNING = "AffinityGeo isn't running. Open the AffinityGeo app, then run this script again.";
const NO_DOCUMENT = 'Open a document in Affinity first.';

function message(e) {
  return String((e && e.message) || e || 'Unknown error');
}

function withoutOp(op) {
  const out = {};
  for (const k of Object.keys(op)) if (k !== 'op') out[k] = op[k];
  return out;
}

/**
 * Runs one AffinityOp. Throws on failure.
 * env: { getDocuments() → Document[], drawMap, sendPlan, plan }
 *   listTargets                                      → drawMap.listTargets(docs)
 *   sendMap { job, target, resizeArtboard, reset, sentIds } → drawMap.sendMap(docs, payload, { sendPlan, plan })
 *   selectOnMap { projectId, mapId, role, fids }      → drawMap.selectOnMap(docs, payload)
 *   linkArtboard { projectId, mapId, docId, artboardIndex, artboardName, otherMapNames } → drawMap.linkArtboard(docs, payload)
 */
function runOp(op, env) {
  if (!op || typeof op.op !== 'string') throw new Error("The job from AffinityGeo wasn't understood.");
  const docs = (env.getDocuments && env.getDocuments()) || [];
  const payload = withoutOp(op);
  switch (op.op) {
    case 'listTargets':
      return env.drawMap.listTargets(docs);
    case 'sendMap':
      if (!docs.length) throw new Error(NO_DOCUMENT);
      return env.drawMap.sendMap(docs, payload, { sendPlan: env.sendPlan, plan: env.plan });
    case 'selectOnMap':
      if (!docs.length) throw new Error(NO_DOCUMENT);
      return env.drawMap.selectOnMap(docs, payload);
    case 'linkArtboard':
      if (!docs.length) throw new Error(NO_DOCUMENT);
      return env.drawMap.linkArtboard(docs, payload);
    default:
      throw new Error('Unknown job type: ' + op.op);
  }
}

/** Console logging only: never UI from a timer callback (it crashed Affinity). Repeats of the last line are dropped. */
function logLine(ctx, text) {
  try {
    if (ctx && ctx.__lastLogged === text) return;
    if (ctx) ctx.__lastLogged = text;
    if (ctx && typeof ctx.log === 'function') ctx.log(text);
    else console.log(text);
  } catch (e) { /* ignore */ }
}

function isOk(status) {
  return typeof status === 'number' && status >= 200 && status < 300;
}

/** "the app replied 403: <error>" — the {error} body if there is one. */
function statusText(reply) {
  let detail = '';
  try {
    const j = JSON.parse(reply.body);
    if (j && typeof j.error === 'string') detail = j.error;
  } catch (e) { /* not JSON */ }
  return 'the app replied with an error (' + reply.status + ')' + (detail ? ': ' + detail : '');
}

/**
 * One poll: fetch at most one job, run it, report the outcome. Never throws.
 * ctx: { get(path, timeoutSec, header) → { status, body }, getDocuments(), drawMap, sendPlan, plan, log?(line) }
 * Every reply's HTTP status is checked: a non-2xx reply is logged as an error, never taken as "idle".
 * Returns 'idle' | 'done' | 'error' (for tests and logging).
 */
function tick(ctx) {
  let reply;
  try {
    reply = ctx.get('/affinity/next', 5, null);
  } catch (e) {
    return 'error'; // server gone: try again next tick (quietly, it may just be closed)
  }
  if (!reply || !isOk(reply.status)) {
    logLine(ctx, 'AffinityGeo: ' + (reply ? statusText(reply) : 'the app sent no reply') + '.');
    return 'error';
  }
  let job;
  try {
    job = JSON.parse(reply.body);
  } catch (e) {
    logLine(ctx, "AffinityGeo: the app's reply wasn't understood.");
    return 'error';
  }
  if (!job || job.idle || job.id == null) {
    if (ctx) ctx.__lastLogged = null;
    return 'idle';
  }
  if (ctx) ctx.__lastLogged = null;
  let outcome;
  try {
    outcome = { ok: true, result: runOp(job.op, ctx) };
  } catch (e) {
    outcome = { ok: false, error: message(e) };
    logLine(ctx, 'AffinityGeo: a ' + ((job.op && job.op.op) || 'job') + ' job failed: ' + outcome.error);
  }
  try {
    let header;
    try { header = encodeURIComponent(JSON.stringify(outcome)); }
    catch (e) { header = encodeURIComponent(JSON.stringify({ ok: false, error: message(e) })); }
    const path = '/affinity/done?id=' + encodeURIComponent(String(job.id));
    const done = ctx.get(path, 10, header);
    if (!done || !isOk(done.status)) {
      logLine(ctx, "AffinityGeo: couldn't send the result back: " + (done ? statusText(done) : 'no reply') + '.');
      // Say so in a short reply, or the app waits for a result that never comes.
      const what = outcome.ok ? 'Affinity drew the map but' : 'Affinity';
      const short = encodeURIComponent(JSON.stringify({ ok: false,
        error: what + " couldn't report back to the app (" + Math.round(header.length / 1024) + ' KB). Send again to check it.' }));
      try { ctx.get(path, 10, short); } catch (e) { /* the app will time out instead */ }
      return 'error';
    }
  } catch (e) {
    logLine(ctx, "AffinityGeo: couldn't send the result back to the app: " + message(e));
    return 'error';
  }
  return outcome.ok ? 'done' : 'error';
}

/**
 * get(path, timeoutSec, resultHeader) → { status, body }. Every request carries X-Geo-Connect: 1:
 * the app refuses /affinity/* without it, so a web page can't take or answer jobs. X-Geo-Scripts carries the scripts version.
 */
function makeGet(HttpRequest, RequestMethod, server, version) {
  return function get(path, timeoutSec, resultHeader) {
    const r = HttpRequest.create(server + path, RequestMethod.Get);
    r.setTimeoutInSec(timeoutSec);
    r.setHeaderValue('X-Geo-Connect', '1');
    if (version != null) r.setHeaderValue('X-Geo-Scripts', String(version));
    if (resultHeader != null) r.setHeaderValue('X-Geo-Result', resultHeader);
    const res = r.do();
    return { status: Number(res.response.statusCode), body: String(res.response.content) };
  };
}

/** The scripts version the app wrote to <home>/affinity/version.js, or "unknown". Cached by require, so an old poller keeps its old one. */
function readVersion(home) {
  try {
    const v = require(home + '/affinity/version.js');
    return typeof v === 'string' && v ? v : 'unknown';
  } catch (e) {
    return 'unknown';
  }
}

/** start({ server, intervalMs, home }) — begins polling. Call from the loader script. */
function start(opts) {
  const o = opts || {};
  const server = o.server || DEFAULT_SERVER;
  const intervalMs = o.intervalMs || 500;
  const home = String(o.home || DEFAULT_HOME).replace(/\\/g, '/').replace(/\/+$/, '');

  const { app } = require('/application.js');
  const { Document } = require('/document.js');
  const { HttpRequest, RequestMethod } = require('/network.js');
  const Timers = require('/timers.js');
  const drawMap = require(home + '/affinity/draw-map.js');
  const sendPlan = require(home + '/affinity/send-plan.js');
  const plan = require(home + '/affinity/plan.js');

  // Stop an earlier poller (the loader may be run more than once).
  const g = globalThis;
  if (g.__affinityGeo && typeof g.__affinityGeo.stop === 'function') {
    try { g.__affinityGeo.stop(); } catch (e) { /* ignore */ }
  }
  g.__affinityGeo = null;

  const get = makeGet(HttpRequest, RequestMethod, server, readVersion(home));

  // First ping, synchronously, before any timer: the only place UI is allowed (one alert at most).
  let first;
  try {
    first = get('/affinity/next', 2, null);
  } catch (e) {
    app.alert(NOT_RUNNING);
    return null;
  }
  let firstJob = null;
  if (isOk(first.status)) {
    try { firstJob = JSON.parse(first.body); } catch (e) { firstJob = null; }
  } else {
    console.log('AffinityGeo: ' + statusText(first) + '.');
  }

  const ctx = {
    get: get,
    getDocuments: function () { try { return Document.all || []; } catch (e) { return []; } },
    drawMap: drawMap,
    sendPlan: sendPlan,
    plan: plan,
  };

  // The ping may have leased a real job: hand it to the first tick.
  let pending = firstJob && !firstJob.idle && firstJob.id != null ? firstJob : null;
  let busy = false;
  const timer = Timers.setInterval(intervalMs, function () {
    if (busy) return;
    busy = true;
    try {
      if (pending) {
        const job = pending;
        pending = null;
        const once = Object.create(ctx);
        once.get = function (path, t, h) {
          return path === '/affinity/next' ? { status: 200, body: JSON.stringify(job) } : get(path, t, h);
        };
        tick(once);
      } else {
        tick(ctx);
      }
    } catch (e) {
      /* never throw out of the timer */
    } finally {
      busy = false;
    }
  });

  const handle = {
    server: server,
    stop: function () { try { timer.cancel(); } catch (e) { /* ignore */ } },
  };
  g.__affinityGeo = handle;
  console.log('AffinityGeo: connected to ' + server);
  return handle;
}

module.exports = { start: start, makeGet: makeGet, readVersion: readVersion, tick: tick, runOp: runOp, NOT_RUNNING: NOT_RUNNING, NO_DOCUMENT: NO_DOCUMENT };
