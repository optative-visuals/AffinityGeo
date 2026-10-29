import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { pickCreatedNodes, mapToFrameBox, frameBoxWarnings, drawablePaths } = require("../src/plan.js");

describe("pickCreatedNodes", () => {
  const n = (name) => ({ userDescription: name });
  const nameOf = (x) => x.userDescription;

  it("uses the children slice when its names match", () => {
    const slice = [n("A"), n("B")];
    const r = pickCreatedNodes(slice, [n("B"), n("A")], ["A", "B"], nameOf);
    expect(r.nodes).toBe(slice);
    expect(r.mismatch).toBe(false);
  });

  it("falls back to the reversed newNodes when only they match", () => {
    const fromCmd = [n("A"), n("B")];
    const r = pickCreatedNodes([n("X"), n("Y")], fromCmd, ["A", "B"], nameOf);
    expect(r.nodes).toBe(fromCmd);
    expect(r.mismatch).toBe(false);
  });

  it("still returns the children slice, flagged, when nothing matches, so every new object gets tagged", () => {
    const slice = [n("X"), n("Y")];
    const r = pickCreatedNodes(slice, [], ["A", "B"], nameOf);
    expect(r.nodes).toBe(slice);
    expect(r.mismatch).toBe(true);
  });

  it("never returns more nodes than features", () => {
    const r = pickCreatedNodes([n("A")], [], ["A", "B"], nameOf);
    expect(r.nodes).toHaveLength(1);
    expect(r.mismatch).toBe(true);
  });
});

describe("mapToFrameBox", () => {
  const rect = { x: 100, y: 100, width: 400, height: 200 };

  it("returns the paths unchanged when the frame hasn't moved", () => {
    const paths = [[100, 100, 500, 300]];
    expect(mapToFrameBox(paths, rect, { ...rect })).toEqual(paths);
  });

  it("follows a moved frame", () => {
    expect(mapToFrameBox([[100, 100, 500, 300, 300, 200]], rect, { x: 150, y: 130, width: 400, height: 200 }))
      .toEqual([[150, 130, 550, 330, 350, 230]]);
  });

  it("follows a moved and uniformly scaled frame", () => {
    const box = { x: 300, y: 260, width: 800, height: 400 };
    expect(mapToFrameBox([[100, 100, 500, 300], [300, 200]], rect, box)).toEqual([[300, 260, 1100, 660], [700, 460]]);
  });

  it("uses the uniform width scale when the height is within 1 %", () => {
    const box = { x: 100, y: 100, width: 800, height: 401 }; // 0.25 % taller than 2x
    expect(mapToFrameBox([[500, 300]], rect, box)).toEqual([[900, 500]]);
  });

  it("scales x and y separately when the frame was stretched", () => {
    const box = { x: 0, y: 0, width: 800, height: 200 };
    expect(mapToFrameBox([[500, 300]], rect, box)).toEqual([[800, 200]]);
  });

  it("rounds to 2 decimals", () => {
    const box = { x: 0, y: 0, width: 1200, height: 600 };
    expect(mapToFrameBox([[100.1, 100.0033]], rect, box)).toEqual([[0.3, 0.01]]);
  });
});

describe("frameBoxWarnings", () => {
  const rect = { x: 0, y: 0, width: 400, height: 200 };
  it("is quiet for a moved or uniformly scaled frame", () => {
    expect(frameBoxWarnings(rect, { x: 50, y: 50, width: 800, height: 400 }, 0)).toEqual([]);
  });
  it("warns about a stretched frame", () => {
    expect(frameBoxWarnings(rect, { x: 0, y: 0, width: 800, height: 200 }, 0)[0]).toMatch(/stretched/);
  });
  it("warns about a rotated frame", () => {
    expect(frameBoxWarnings(rect, rect, 0.17)).toEqual(["The map frame is rotated; AffinityGeo draws it unrotated."]);
    expect(frameBoxWarnings(rect, rect, 1e-9)).toEqual([]);
  });
});

describe("drawablePaths", () => {
  it("keeps only paths with enough positions for the kind", () => {
    expect(drawablePaths({ paths: [[1, 2], [3]], closed: false }, "point")).toEqual([[1, 2]]);
    expect(drawablePaths({ paths: [[1, 2], [1, 2, 3, 4]], closed: false }, "line")).toEqual([[1, 2, 3, 4]]);
    expect(drawablePaths({ paths: [[1, 2, 3, 4], [0, 0, 1, 0, 1, 1]], closed: true }, "polygon")).toEqual([[0, 0, 1, 0, 1, 1]]);
    expect(drawablePaths({ paths: [[1, 2, 3, 4]], closed: true }, "polygon")).toEqual([]);
    expect(drawablePaths({}, "line")).toEqual([]);
  });
});
