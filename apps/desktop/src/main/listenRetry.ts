// Starting the server on a port that a just-closed AffinityGeo is still releasing. Kept free of Electron imports.

export interface RetryOptions {
  /** How many more attempts after the first one. */
  tries: number;
  delayMs: number;
  sleep: (ms: number) => Promise<void>;
}

/** Runs `start`; while it fails with EADDRINUSE, waits `delayMs` and tries again, up to `tries` more times. Other errors throw at once. */
export async function listenWithRetry<T>(start: () => Promise<T>, { tries, delayMs, sleep }: RetryOptions): Promise<T> {
  for (let left = tries; ; left--) {
    try {
      return await start();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE" || left <= 0) throw e;
      await sleep(delayMs);
    }
  }
}
