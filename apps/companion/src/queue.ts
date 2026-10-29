import { randomBytes } from "node:crypto";
import type { MapJob, MapTarget, RoleId } from "@affinitygeo/geo-core";

/** Jobs connect.js runs in Affinity. Flat: the payload sits next to `op`. */
export type AffinityOp =
  | { op: "listTargets" }
  | { op: "sendMap"; job: MapJob; target: MapTarget | null; resizeArtboard: boolean | null; reset: boolean; sentIds: string[] }
  | { op: "selectOnMap"; projectId: string; mapId: string; role: RoleId; fids: string[] }
  | { op: "linkArtboard"; projectId: string; mapId: string; docId: string; artboardIndex: number; artboardName: string; otherMapNames: Record<string, string> };

/** A running job whose waiter gave up is kept this long for a late completion, then forgotten. */
const ABANDONED_MS = 10 * 60_000;
/** How often a waiter checks on its job. */
const CHECK_MS = 250;

export interface QueueLimits {
  /** Affinity counts as connected if it polled this recently (connect.js polls every 500 ms). */
  connectedMs: number;
  /** A job must be taken this soon after it is queued, unless Affinity is busy with another job. */
  pickupMs: number;
  /**
   * Once taken, a job may run this long. connect.js runs jobs synchronously, so it doesn't poll
   * while it draws: silence during a run is normal, and only this cap ends the wait.
   */
  runMs: number;
}

export const DEFAULT_LIMITS: QueueLimits = { connectedMs: 3_000, pickupMs: 5_000, runMs: 10 * 60_000 };

export const NOT_CONNECTED = "Affinity isn't connected. Run the Geo – Connect script in Affinity.";

/** Why a wait ended without a result: Affinity isn't there, or it is taking too long. */
export class AffinityWaitError extends Error {
  constructor(public kind: "notConnected" | "stillWorking", message: string) {
    super(message);
    this.name = "AffinityWaitError";
  }
}

function stillMessage(op: AffinityOp | null): string {
  if (op?.op === "sendMap") return `Affinity is still drawing ${op.job.mapName}…`;
  if (op?.op === "selectOnMap") return "Affinity is still selecting the features…";
  return "Affinity is still working…";
}

interface Entry {
  id: string;
  op: AffinityOp | null; // dropped once the job is done
  leasedAt: number | null;
  done: boolean;
  result?: unknown;
  waiters: Array<(r: unknown) => void>;
  abandoned: boolean; // a waiter timed out while Affinity was running the job
  abandonedAt: number | null;
}

export class JobQueue {
  private runId = randomBytes(3).toString("hex");
  private counter = 0;
  private jobs = new Map<string, Entry>();

  /** Called when Affinity finishes a job whose waiter already gave up (see waitFor). */
  onLateCompletion: ((op: AffinityOp, result: unknown) => void) | null = null;

  private lastPollAt: number | null = null;
  /** When Affinity last finished a job, i.e. became free to take the next one. */
  private freeSince = -Infinity;
  readonly limits: QueueLimits;

  constructor(private now: () => number = Date.now, limits: Partial<QueueLimits> = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  push(op: AffinityOp): string {
    const id = `${this.runId}-${++this.counter}`;
    this.jobs.set(id, { id, op, leasedAt: null, done: false, waiters: [], abandoned: false, abandonedAt: null });
    return id;
  }

  /** Affinity polled recently. */
  polling(): boolean {
    return this.lastPollAt !== null && this.now() - this.lastPollAt <= this.limits.connectedMs;
  }

  /** Affinity is running a job (taken, not finished, within the run cap). */
  busy(): boolean {
    const t = this.now();
    for (const e of this.jobs.values()) {
      if (!e.done && e.leasedAt !== null && t - e.leasedAt < this.limits.runMs) return true;
    }
    return false;
  }

  /** Connected: polling, or quiet because it is running a job. */
  connected(): boolean {
    return this.polling() || this.busy();
  }

  /** Number of jobs the queue still holds (pending, running or waiting to be collected). */
  size(): number {
    return this.jobs.size;
  }

  /**
   * The oldest job Affinity hasn't taken yet. A taken job is never offered again: running a
   * sendMap twice would draw twice. If Affinity drops a job, its waiter times out instead.
   */
  next(): { id: string; op: AffinityOp } | null {
    const t = this.now();
    this.lastPollAt = t;
    let found: Entry | null = null;
    for (const e of [...this.jobs.values()]) {
      if (e.abandoned && e.leasedAt !== null && t - (e.abandonedAt ?? t) >= ABANDONED_MS) { this.jobs.delete(e.id); continue; }
      if (!found && !e.done && e.op && e.leasedAt === null) found = e;
    }
    if (!found) return null;
    found.leasedAt = t;
    return { id: found.id, op: found.op! };
  }

  /**
   * Remove a job Affinity hasn't taken yet. Returns false if it is unknown, done or already
   * taken; a taken job stays only to receive a late completion (see onLateCompletion).
   */
  cancel(id: string): boolean {
    const e = this.jobs.get(id);
    if (!e || e.done || e.leasedAt !== null) return false;
    this.jobs.delete(id);
    return true;
  }

  complete(id: string, result: unknown): boolean {
    const e = this.jobs.get(id);
    if (!e || e.done) return false;
    // A result is a sign of life too: connect.js only polls again on its next tick, so restart
    // the connected and pickup clocks now, or a job queued behind a long draw would be refused.
    const t = this.now();
    this.lastPollAt = t;
    if (e.leasedAt !== null) this.freeSince = t;
    const op = e.op;
    if (e.waiters.length) {
      for (const w of e.waiters) w(result);
      this.jobs.delete(id);
    } else if (e.abandoned) {
      this.jobs.delete(id);
      if (op && this.onLateCompletion) {
        try { this.onLateCompletion(op, result); } catch { /* never break the Affinity poll */ }
      }
    } else {
      // Nobody is waiting yet: keep only the id and result until waitFor collects it.
      e.done = true;
      e.result = result;
      e.op = null;
    }
    return true;
  }

  /**
   * Waits for Affinity's result. Rejects with AffinityWaitError:
   * - notConnected: not taken, and Affinity neither polls nor runs another job, or the pickup
   *   time passed while it was idle;
   * - stillWorking: taken, but still running when the run cap is reached.
   */
  waitFor(id: string): Promise<unknown> {
    const e = this.jobs.get(id);
    if (!e) return Promise.reject(new Error(`Unknown job: ${id}`));
    if (e.done) {
      this.jobs.delete(id);
      return Promise.resolve(e.result);
    }
    const queuedAt = this.now();
    return new Promise((resolve, reject) => {
      const giveUp = (err: AffinityWaitError) => {
        clearInterval(timer);
        e.waiters = e.waiters.filter((w) => w !== onDone);
        if (e.waiters.length === 0 && e.leasedAt !== null) { e.abandoned = true; e.abandonedAt = this.now(); }
        reject(err);
      };
      const timer = setInterval(() => {
        const t = this.now();
        const { pickupMs, runMs } = this.limits;
        if (e.leasedAt === null) {
          const busy = this.busy();
          // Pickup time counts from when Affinity was last free, not from when the job was queued.
          const since = Math.max(queuedAt, this.freeSince);
          if (!busy && (!this.polling() || t - since >= pickupMs)) giveUp(new AffinityWaitError("notConnected", NOT_CONNECTED));
          else if (t - since >= pickupMs + runMs) giveUp(new AffinityWaitError("stillWorking", "Affinity is still busy with another job. Try again in a moment."));
        } else if (t - e.leasedAt >= runMs) {
          giveUp(new AffinityWaitError("stillWorking", stillMessage(e.op)));
        }
      }, CHECK_MS);
      const onDone = (r: unknown) => { clearInterval(timer); resolve(r); };
      e.waiters.push(onDone);
    });
  }
}
