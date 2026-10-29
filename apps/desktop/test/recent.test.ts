import { describe, expect, it } from "vitest";
import { MAX_RECENT, pushRecent } from "../src/shared/recent.js";

describe("pushRecent", () => {
  it("recent keeps 8, newest first, no duplicates (case-insensitive on Windows paths)", () => {
    let list: string[] = [];
    for (let i = 1; i <= 10; i++) list = pushRecent(list, `C:\\Maps\\p${i}.afgeo`);
    expect(MAX_RECENT).toBe(8);
    expect(list).toHaveLength(8);
    expect(list[0]).toBe("C:\\Maps\\p10.afgeo");
    expect(list[7]).toBe("C:\\Maps\\p3.afgeo");

    // Same file with different case and slashes: moved to the front, not added twice.
    list = pushRecent(list, "c:/maps/P5.AFGEO");
    expect(list).toHaveLength(8);
    expect(list[0]).toBe("c:/maps/P5.AFGEO");
    expect(list.filter((p) => p.toLowerCase().endsWith("p5.afgeo"))).toHaveLength(1);
    expect(list[1]).toBe("C:\\Maps\\p10.afgeo");

    // POSIX paths are case-sensitive: both stay.
    let posix = pushRecent([], "/Users/me/A.afgeo");
    posix = pushRecent(posix, "/Users/me/a.afgeo");
    expect(posix).toEqual(["/Users/me/a.afgeo", "/Users/me/A.afgeo"]);
  });

  it("ignores blanks and non-strings in a stored list", () => {
    expect(pushRecent(["", 3 as unknown as string, "C:\\a.afgeo"], "  ")).toEqual(["C:\\a.afgeo"]);
  });
});
