import { describe, expect, it, vi } from "vitest";
import { listenWithRetry } from "../src/main/listenRetry.js";

const inUse = () => Object.assign(new Error("in use"), { code: "EADDRINUSE" });

describe("listenWithRetry", () => {
  it("returns at once when the port is free", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    expect(await listenWithRetry(async () => "ok", { tries: 10, delayMs: 500, sleep })).toBe("ok");
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries after EADDRINUSE until it works", async () => {
    const start = vi.fn<() => Promise<string>>()
      .mockRejectedValueOnce(inUse()).mockRejectedValueOnce(inUse()).mockResolvedValue("ok");
    const sleep = vi.fn(async (_ms: number) => {});
    expect(await listenWithRetry(start, { tries: 10, delayMs: 500, sleep })).toBe("ok");
    expect(start).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[500], [500]]);
  });

  it("gives up with the EADDRINUSE error after the retries", async () => {
    const start = vi.fn(async () => { throw inUse(); });
    const sleep = vi.fn(async (_ms: number) => {});
    await expect(listenWithRetry(start, { tries: 10, delayMs: 500, sleep })).rejects.toMatchObject({ code: "EADDRINUSE" });
    expect(start).toHaveBeenCalledTimes(11);
    expect(sleep).toHaveBeenCalledTimes(10); // 10 x 500 ms = 5 s
  });

  it("does not retry other errors", async () => {
    const start = vi.fn(async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); });
    const sleep = vi.fn(async (_ms: number) => {});
    await expect(listenWithRetry(start, { tries: 10, delayMs: 500, sleep })).rejects.toThrow("denied");
    expect(start).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
