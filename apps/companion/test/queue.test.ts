import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { AffinityWaitError, JobQueue, NOT_CONNECTED, type AffinityOp } from "../src/queue.js";

const op = (n: number): AffinityOp => ({ op: "selectOnMap", projectId: "p", mapId: "m", role: "paths", fids: [String(n)] });
const sendOp = (name: string): AffinityOp => ({
  op: "sendMap", job: { mapId: "m", mapName: name, projectId: "p", sizeMm: { width: 1, height: 1 }, background: { fill: "#ffffff" }, layers: [], marker: null, hash: "h" },
  target: null, resizeArtboard: true, reset: false, sentIds: [],
});
const queue = () => new JobQueue(() => Date.now());

describe("JobQueue", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("is FIFO and unique", () => {
    const q = queue();
    const a = q.push(op(1)), b = q.push(op(2));
    expect(a).not.toBe(b);
    expect(q.next()?.id).toBe(a);
    expect(q.next()?.id).toBe(b);
    expect(q.next()).toBeNull();
  });
  it("waitFor resolves on complete; unknown complete is a no-op", async () => {
    const q = queue();
    q.next(); // polling
    const id = q.push(op(1));
    const p = q.waitFor(id);
    expect(q.complete("nope", 1)).toBe(false);
    expect(q.complete(id, { ok: true })).toBe(true);
    await expect(p).resolves.toEqual({ ok: true });
    expect(q.next()).toBeNull();
  });
  it("waitFor resolves if already completed", async () => {
    const q = queue();
    const id = q.push(op(1));
    q.complete(id, 5);
    await expect(q.waitFor(id)).resolves.toBe(5);
  });

  it("knows whether Affinity is polling or busy", async () => {
    const q = queue();
    expect([q.connected(), q.busy()]).toEqual([false, false]);
    q.next();
    expect([q.connected(), q.busy()]).toEqual([true, false]);
    await vi.advanceTimersByTimeAsync(3_001);
    expect(q.connected()).toBe(false);
    q.push(op(1));
    q.next(); // takes it, then goes quiet while it runs
    await vi.advanceTimersByTimeAsync(60_000);
    expect([q.polling(), q.busy(), q.connected()]).toEqual([false, true, true]);
  });

  it("a job nobody takes is refused as not connected once polls stop", async () => {
    const q = queue();
    const id = q.push(op(1));
    const p = q.waitFor(id);
    const assertion = expect(p).rejects.toThrow(NOT_CONNECTED);
    await vi.advanceTimersByTimeAsync(300);
    await assertion;
    expect(q.cancel(id)).toBe(true);
  });

  it("a job still not taken after the pickup time is refused, even while polls come in", async () => {
    const q = new JobQueue(() => Date.now(), { pickupMs: 1_000 });
    q.next();
    const id = q.push(op(1));
    const p = q.waitFor(id);
    let settled = false;
    p.catch(() => { settled = true; });
    // polls keep coming, but (say) a stale connect.js never takes the job
    (q as any).lastPollAt = Date.now();
    await vi.advanceTimersByTimeAsync(500);
    (q as any).lastPollAt = Date.now();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(600);
    await expect(p).rejects.toBeInstanceOf(AffinityWaitError);
  });

  it("a long draw beyond 60 s still succeeds: a running job has no pickup limit", async () => {
    const q = queue();
    q.next();
    const id = q.push(sendOp("Entrance map"));
    const p = q.waitFor(id);
    expect(q.next()?.id).toBe(id);
    await vi.advanceTimersByTimeAsync(90_000); // no polls while Affinity draws
    expect(q.next()).toBeNull(); // never handed out again
    q.complete(id, { ok: true, result: 1 });
    await expect(p).resolves.toEqual({ ok: true, result: 1 });
  });

  it("a job behind a running one waits for it instead of failing", async () => {
    const q = queue();
    q.next();
    const first = q.push(sendOp("A"));
    const pa = q.waitFor(first);
    q.next();
    const second = q.push(op(2));
    const pb = q.waitFor(second);
    await vi.advanceTimersByTimeAsync(30_000);
    q.complete(first, { ok: true });
    await expect(pa).resolves.toEqual({ ok: true });
    expect(q.next()?.id).toBe(second);
    q.complete(second, { ok: true });
    await expect(pb).resolves.toEqual({ ok: true });
  });

  it("a job queued behind a long draw is taken after it, not refused as not connected", async () => {
    const q = queue();
    q.next();
    const first = q.push(sendOp("A"));
    const pa = q.waitFor(first);
    expect(q.next()?.id).toBe(first); // t=0: Affinity starts an 8 s draw and stops polling
    await vi.advanceTimersByTimeAsync(1_000);
    const second = q.push(op(2)); // t=1 s
    const pb = q.waitFor(second);
    let refused: unknown = null;
    pb.catch((e) => { refused = e; });
    await vi.advanceTimersByTimeAsync(8_000);
    q.complete(first, { ok: true }); // t=9 s
    await expect(pa).resolves.toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(600); // connect.js's next tick
    expect(refused).toBeNull();
    expect(q.next()?.id).toBe(second); // t=9.6 s
    q.complete(second, { ok: true });
    await expect(pb).resolves.toEqual({ ok: true });
  });

  it("a running job past the cap ends the wait with 'still drawing'", async () => {
    const q = new JobQueue(() => Date.now(), { runMs: 5_000 });
    q.next();
    const id = q.push(sendOp("Entrance map"));
    const p = q.waitFor(id);
    q.next();
    const assertion = expect(p).rejects.toThrow("Affinity is still drawing Entrance map…");
    await vi.advanceTimersByTimeAsync(5_300);
    await assertion;
    expect(q.cancel(id)).toBe(false); // running: kept for a late completion, never offered again
    expect(q.next()).toBeNull();
    expect(q.busy()).toBe(false);
  });

  it("ids from different runs never collide", () => {
    expect(queue().push(op(1))).not.toBe(queue().push(op(1)));
  });
  it("cancel drops a job Affinity hasn't taken yet, so next() is idle", () => {
    const q = queue();
    const id = q.push(op(1));
    expect(q.cancel(id)).toBe(true);
    expect(q.next()).toBeNull();
    expect(q.cancel(id)).toBe(false);
  });
  it("forgets an abandoned running job ten minutes after its waiter gave up", async () => {
    const q = new JobQueue(() => Date.now(), { runMs: 1_000 });
    q.next();
    const id = q.push(op(1));
    const p = q.waitFor(id).catch(() => undefined);
    q.next();
    await vi.advanceTimersByTimeAsync(1_300);
    await p;
    q.cancel(id);
    expect(q.size()).toBe(1);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    q.next();
    expect(q.size()).toBe(0);
  });
  it("forgets a job once its result has been collected", async () => {
    const q = queue();
    q.next();
    const id = q.push(op(1));
    q.complete(id, { ok: true });
    expect(q.size()).toBe(1);
    await expect(q.waitFor(id)).resolves.toEqual({ ok: true });
    expect(q.size()).toBe(0);
    const id2 = q.push(op(2));
    const p = q.waitFor(id2);
    q.complete(id2, 7);
    await expect(p).resolves.toBe(7);
    expect(q.size()).toBe(0);
    expect(q.complete(id2, 8)).toBe(false);
  });
  it("hands a completion that arrives after the waiter gave up to onLateCompletion", async () => {
    const late: Array<[AffinityOp, unknown]> = [];
    const q = new JobQueue(() => Date.now(), { runMs: 1_000 });
    q.onLateCompletion = (o, r) => { late.push([o, r]); };
    q.next();
    const id = q.push(op(1));
    q.next(); // taken: Affinity is running it
    const p = q.waitFor(id);
    const assertion = expect(p).rejects.toThrow(/still selecting/);
    await vi.advanceTimersByTimeAsync(1_300);
    await assertion;
    expect(q.complete(id, { ok: true, result: 1 })).toBe(true);
    expect(late).toEqual([[op(1), { ok: true, result: 1 }]]);
    expect(q.size()).toBe(0);
  });
});
