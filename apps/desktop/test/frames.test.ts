// Map frames must not be mistaken for map content: neutral ink with a halo, never a style colour.
import { describe, expect, it } from "vitest";
import { PRESETS } from "@affinitygeo/geo-core";
import { HIGHLIGHT, drawMaps } from "../src/ui/map/draw.js";
import type { View } from "../src/ui/map/viewport.js";

interface Stroke { strokeStyle: string; lineWidth: number; dash: number[] }
function fakeCtx() {
  const strokes: Stroke[] = [];
  let dash: number[] = [];
  const ctx: Record<string, unknown> = { fillStyle: "", strokeStyle: "", lineWidth: 1 };
  ctx.setLineDash = (d: number[]) => { dash = [...d]; };
  ctx.stroke = () => { strokes.push({ strokeStyle: String(ctx.strokeStyle), lineWidth: ctx.lineWidth as number, dash }); };
  for (const op of ["save", "restore", "beginPath", "moveTo", "lineTo", "closePath", "arc", "fill", "fillText"]) ctx[op] = () => {};
  return { ctx: ctx as unknown as CanvasRenderingContext2D, strokes };
}

const view: View = { cx: 0, cy: 0, mPerPx: 1 };
const sq = (x: number): [number, number][] => [[x - 10, 10], [x + 10, 10], [x + 10, -10], [x - 10, -10]];
const maps = [{ id: "a" }, { id: "b" }];
const corners = { a: sq(-30), b: sq(30) };

describe("map frames", () => {
  it("draws unselected frames dashed [5,3] in neutral ink over a 3 px white casing on light paper", () => {
    const { ctx, strokes } = fakeCtx();
    drawMaps(ctx, maps, corners, ["b"], view, 400, 400, "#FFFFFF");
    const casing = strokes.filter((s) => s.strokeStyle === "rgba(255,255,255,0.85)" && s.lineWidth === 3);
    expect(casing.length).toBeGreaterThanOrEqual(2); // both frames are cased
    const line = strokes.find((s) => s.strokeStyle === "#1B252C");
    expect(line?.dash).toEqual([5, 3]);
    const selected = strokes.find((s) => s.strokeStyle === HIGHLIGHT && s.lineWidth === 2);
    expect(selected?.dash).toEqual([]);
  });

  it("uses white ink over a dark casing on dark paper", () => {
    const { ctx, strokes } = fakeCtx();
    drawMaps(ctx, maps, corners, [], view, 400, 400, "#1B252C");
    expect(strokes.some((s) => s.strokeStyle === "rgba(0,0,0,0.6)" && s.lineWidth === 3)).toBe(true);
    expect(strokes.some((s) => s.strokeStyle === "#FFFFFF" && s.dash.join() === "5,3")).toBe(true);
  });

  it("the unselected frame colour on light paper differs from every role colour of every preset", () => {
    const { ctx, strokes } = fakeCtx();
    drawMaps(ctx, [{ id: "a" }], { a: sq(0) }, [], view, 400, 400, "#FFFFFF");
    const ink = strokes.find((s) => s.dash.join() === "5,3")!.strokeStyle.toLowerCase();
    const colours = new Set<string>();
    for (const p of PRESETS) for (const r of Object.values(p.roles)) {
      if (r.fill) colours.add(r.fill.toLowerCase());
      if (r.stroke) colours.add(r.stroke.toLowerCase());
    }
    expect(colours.size).toBeGreaterThan(10);
    expect(colours.has(ink)).toBe(false);
  });
});
