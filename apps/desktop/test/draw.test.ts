// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AreaPreview } from "../src/ui/api.js";
import { FRAME_CASING, FRAME_INK, HIGHLIGHT, PIN_COLOUR, drawArea, drawHighlight, drawMaps, paperColour } from "../src/ui/map/draw.js";
import type { View } from "../src/ui/map/viewport.js";
import type { ProjectStyle } from "@affinitygeo/geo-core/view";
type RoleStyle = ProjectStyle["roles"][keyof ProjectStyle["roles"]];

let made = 0;
class FakePath2D {
  ops: unknown[][] = [];
  constructor() { made++; }
  moveTo(...a: number[]) { this.ops.push(["M", ...a]); }
  lineTo(...a: number[]) { this.ops.push(["L", ...a]); }
  closePath() { this.ops.push(["Z"]); }
  arc(...a: number[]) { this.ops.push(["A", ...a]); }
}

interface Call { op: string; fillStyle: unknown; strokeStyle: unknown; lineWidth: number; arg?: unknown }
function fakeCtx() {
  const calls: Call[] = [];
  const ctx: Record<string, unknown> = {
    fillStyle: "", strokeStyle: "", lineWidth: 1, lineJoin: "miter", lineCap: "butt", font: "", textAlign: "", textBaseline: "",
  };
  const rec = (op: string) => (arg?: unknown) => {
    calls.push({ op, fillStyle: ctx.fillStyle, strokeStyle: ctx.strokeStyle, lineWidth: ctx.lineWidth as number, arg });
  };
  for (const op of ["fill", "stroke", "fillText", "transform", "setTransform"]) ctx[op] = rec(op);
  for (const op of ["setLineDash", "save", "restore", "beginPath", "moveTo", "lineTo", "closePath", "arc", "rect", "fillRect"]) ctx[op] = () => {};
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

function role(order: number, fill: string | null, stroke: string | null, extra: Partial<RoleStyle> = {}): RoleStyle {
  return { fill, stroke, strokePt: 1, visible: true, order, pointRadiusPt: 0, ...extra };
}
function styleWith(roles: Record<string, RoleStyle>): ProjectStyle {
  return { presetName: "Test", roles, marker: { dot: "#000", ring: "#fff", text: "#000", textPt: 10, label: "x" } } as unknown as ProjectStyle;
}

const W = 400, H = 400;
const view: View = { cx: 0, cy: 0, mPerPx: 1 };
const square = (x: number, y: number, s: number) => [[[x, y], [x + s, y], [x + s, y + s], [x, y + s], [x, y]]];

beforeEach(() => { made = 0; vi.stubGlobal("Path2D", FakePath2D); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("drawArea", () => {
  const preview: AreaPreview = {
    bounds: [-100, -100, 100, 100],
    layers: [
      { role: "buildings", kind: "polygon", features: [
        { fid: "b1", name: "", paths: square(0, 0, 20) },
        { fid: "b2", name: "", paths: square(50, 50, 0.2) }, // 0.2 px across: skipped
      ] },
      { role: "water", kind: "polygon", features: [{ fid: "w1", name: "", paths: square(-80, -80, 60) }] },
      { role: "paths", kind: "line", features: [{ fid: "p1", name: "", paths: [[[-50, 10], [50, 10]]] }] },
      { role: "landuse", kind: "polygon", features: [{ fid: "l1", name: "", paths: square(-100, -100, 200) }] },
    ],
  } as AreaPreview;
  const style = styleWith({
    water: role(0, "#0000ff", null, { strokePt: 0 }),
    landuse: role(1, "#00ff00", null, { visible: false }),
    buildings: role(2, "#999999", "#333333", { strokePt: 0.25 }),
    paths: role(3, "#ff0000", "#aa5500", { strokePt: 2 }),
  });

  it("skips sub-pixel features and reuses cached paths", () => {
    const cache = new Map<string, Path2D>();
    const a = fakeCtx();
    drawArea(a.ctx, preview, style, view, W, H, cache);
    const fills = a.calls.filter((c) => c.op === "fill").length;
    const strokes = a.calls.filter((c) => c.op === "stroke").length;
    expect(fills).toBe(2);   // water, building b1 (the line isn't filled; b2 is sub-pixel; landuse hidden)
    expect(strokes).toBe(2); // building b1, path p1 (water has no stroke)
    expect(a.calls.filter((c) => c.op === "transform").length).toBe(1); // one world transform per frame
    const firstMade = made;
    expect(firstMade).toBeGreaterThan(0);

    const b = fakeCtx();
    drawArea(b.ctx, preview, style, view, W, H, cache);
    expect(made).toBe(firstMade); // no new Path2D on the second draw
    expect(b.calls.filter((c) => c.op === "fill").length).toBe(2);

    // Zoomed in, b2 becomes big enough to draw.
    const c = fakeCtx();
    drawArea(c.ctx, preview, style, { cx: 25, cy: 25, mPerPx: 0.2 }, W, H, cache);
    expect(c.calls.filter((x) => x.op === "fill" && x.fillStyle === "#999999").length).toBe(2);
  });

  it("leaves hidden roles out and follows role order", () => {
    const { ctx, calls } = fakeCtx();
    drawArea(ctx, preview, style, view, W, H, new Map());
    const seq = calls.filter((c) => c.op === "fill" || c.op === "stroke").map((c) => (c.op === "fill" ? c.fillStyle : c.strokeStyle));
    expect(seq).toEqual(["#0000ff", "#999999", "#333333", "#aa5500"]);
    expect(seq).not.toContain("#00ff00");

    // Swap the order: paths under water.
    const swapped = styleWith({ ...style.roles, paths: role(-1, null, "#aa5500", { strokePt: 2 }) });
    const s = fakeCtx();
    drawArea(s.ctx, preview, swapped, view, W, H, new Map());
    const seq2 = s.calls.filter((c) => c.op === "fill" || c.op === "stroke").map((c) => (c.op === "fill" ? c.fillStyle : c.strokeStyle));
    expect(seq2[0]).toBe("#aa5500");
  });

  it("draws strokes at max(0.75, strokePt × 0.75) screen px, in world units", () => {
    const { ctx, calls } = fakeCtx();
    drawArea(ctx, preview, style, { cx: 0, cy: 0, mPerPx: 2 }, W, H, new Map());
    const widths = calls.filter((c) => c.op === "stroke").map((c) => c.lineWidth);
    expect(widths[0]).toBeCloseTo(0.75 * 2, 9);     // buildings 0.25 pt → 0.75 px
    expect(widths[1]).toBeCloseTo(2 * 0.75 * 2, 9); // paths 2 pt → 1.5 px
  });

  it("draws points as circles of pointRadiusPt px (at least 1.5)", () => {
    const pts: AreaPreview = { bounds: [0, 0, 10, 10], layers: [
      { role: "poi", kind: "point", features: [{ fid: "q1", name: "", paths: [[[1, 1]]] }, { fid: "q2", name: "", paths: [[[5, 5]]] }] },
    ] } as AreaPreview;
    const st = styleWith({ poi: role(0, "#e4572e", "#ffffff", { pointRadiusPt: 0.5, strokePt: 0.5 }) });
    const { ctx, calls } = fakeCtx();
    const arcs: number[][] = [];
    (ctx as unknown as { arc: (...a: number[]) => void }).arc = (...a: number[]) => { arcs.push(a); };
    drawArea(ctx, pts, st, { cx: 0, cy: 0, mPerPx: 2 }, W, H, new Map());
    expect(arcs).toHaveLength(2);
    expect(arcs[0]![2]).toBeCloseTo(1.5 * 2, 9); // radius in world units
    expect(calls.filter((c) => c.op === "fill")).toHaveLength(1);
  });
});

describe("drawHighlight", () => {
  it("draws only the highlighted fids, in the highlight blue", () => {
    const preview: AreaPreview = { bounds: [0, 0, 100, 100], layers: [
      { role: "buildings", kind: "polygon", features: [
        { fid: "b1", name: "", paths: square(0, 0, 20) }, { fid: "b2", name: "", paths: square(40, 40, 20) },
      ] },
    ] } as AreaPreview;
    const { ctx, calls } = fakeCtx();
    drawHighlight(ctx, preview, { role: "buildings", fids: ["b2"] }, view, W, H, new Map());
    const drawn = calls.filter((c) => c.op === "fill" || c.op === "stroke");
    expect(drawn.length).toBeGreaterThan(0);
    expect(drawn.every((c) => c.fillStyle === HIGHLIGHT || c.strokeStyle === HIGHLIGHT)).toBe(true);
    expect(calls.filter((c) => c.op === "fill")).toHaveLength(1);
    expect(HIGHLIGHT).toBe("#4AA3FF");
  });
});

describe("drawMaps", () => {
  it("numbers the pins from 1, thickens selected frames and adds a rotate handle", () => {
    const maps = [{ id: "a" }, { id: "b" }];
    const corners = {
      a: [[-10, 10], [10, 10], [10, -10], [-10, -10]] as [number, number][],
      b: [[20, 10], [40, 10], [40, -10], [20, -10]] as [number, number][],
    };
    const { ctx, calls } = fakeCtx();
    const arcs: number[][] = [];
    (ctx as unknown as { arc: (...a: number[]) => void }).arc = (...a: number[]) => { arcs.push(a); };
    drawMaps(ctx, maps, corners, ["b"], view, W, H);
    const texts = calls.filter((c) => c.op === "fillText");
    expect(texts.map((t) => t.arg)).toEqual(["1", "2"]);
    expect(texts.every((t) => t.fillStyle === "#FFFFFF")).toBe(true);
    expect(calls.some((c) => c.op === "fill" && c.fillStyle === PIN_COLOUR)).toBe(true);
    expect(PIN_COLOUR).toBe("#E4572E");
    const frameStrokes = calls.filter((c) => c.op === "stroke" && c.strokeStyle === HIGHLIGHT);
    expect(frameStrokes.some((c) => c.lineWidth === 2)).toBe(true);
    // Two pins plus one rotate handle (on b only).
    expect(arcs).toHaveLength(3);
  });
});

describe("paperColour", () => {
  it("is the style's own paper colour when it has one", () => {
    const light = styleWith({ landuse: role(0, "#ebe7dc", null), water: role(1, "#aed0e0", null) });
    expect(paperColour({ ...light, paper: "#1d2a33" })).toBe("#1d2a33");
    expect(paperColour({ ...light, paper: "#f4f1ea" })).toBe("#f4f1ea");
  });

  it("keys the map frames' ink off the paper's luminance", () => {
    const light = styleWith({ landuse: role(0, "#ebe7dc", null) });
    const inkOn = (paper: string) => {
      const { ctx, calls } = fakeCtx();
      drawMaps(ctx, [{ id: "a" }], { a: [[0, 0], [10, 0], [10, 10], [0, 10]] }, [], view, W, H, paperColour({ ...light, paper }));
      return calls.filter((c) => c.op === "stroke").map((c) => c.strokeStyle);
    };
    // the halo (casing) colour only ever comes from the tone
    expect(inkOn("#1d2a33")).toContain(FRAME_CASING.dark);
    expect(inkOn("#1d2a33")).not.toContain(FRAME_CASING.light);
    expect(inkOn("#f4f1ea")).toContain(FRAME_CASING.light);
    expect(inkOn("#f4f1ea")).toContain(FRAME_INK.light);
  });

  it("falls back to a guess from the fills for a style without paper: white for a light style, dark for a dark one", () => {
    expect(paperColour(styleWith({ landuse: role(0, "#ebe7dc", null), water: role(1, "#aed0e0", null) }))).toBe("#FFFFFF");
    expect(paperColour(styleWith({ landuse: role(0, "#25343d", null), water: role(1, "#3d6178", null) }))).not.toBe("#FFFFFF");
  });
});
