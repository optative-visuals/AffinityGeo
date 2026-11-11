import { describe, expect, it } from "vitest";
import { affinityCheck, checkNames, checkScript } from "../src/tools/affinity.js";
import type { ToolContext } from "../src/tool.js";

const ctx = {} as ToolContext;
const NAMES = ["document-summary", "fid-audit", "map-structure"];

/** Runs a check with a stand-in for Affinity's module system, and returns what it printed. */
function runWith(src: string, current: unknown): unknown {
  const printed: string[] = [];
  const fakeRequire = (id: string) => {
    if (id === "/document.js") return { Document: { current } };
    if (id === "/nodes.js") return { NodeChildren: class { *[Symbol.iterator]() { /* no masks */ } } };
    if (id === "/commands.js") return { NodeChildType: { Enclosure: 1 } };
    throw new Error(`unexpected module ${id}`);
  };
  new Function("require", "console", src)(fakeRequire, { log: (s: string) => printed.push(s) });
  expect(printed).toHaveLength(1);
  return JSON.parse(printed[0]!);
}

function node(name: string, tags: Record<string, string> = {}, children: unknown[] = []) {
  return {
    userDescription: name, children, handle: {},
    hasKey: (k: string) => k in tags,
    getValueForKey: (k: string) => { if (!(k in tags)) throw new Error("INVALID_ARGS"); return tags[k]; },
    isSameNode(other: unknown) { return other === this; },
  };
}

describe("affinity_check", () => {
  it("lists the three checks with their descriptions", async () => {
    const r = (await affinityCheck.run(ctx, {})).json as { checks: Array<{ name: string; description: string }> };
    expect(r.checks.map((c) => c.name)).toEqual(NAMES);
    expect(checkNames()).toEqual(NAMES);
    for (const c of r.checks) expect(c.description.length).toBeGreaterThan(20);
    expect(r.checks[0]!.description).toMatch(/^A first look at the current Affinity document/);
  });
  it("returns the helpers followed by the named check, as one self-contained script", async () => {
    const text = (await affinityCheck.run(ctx, { name: "fid-audit" })).text!;
    expect(text.indexOf("function tagOf")).toBeGreaterThan(-1);
    expect(text.indexOf("function tagOf")).toBeLessThan(text.indexOf("// Counts the objects AffinityGeo drew"));
    expect(text).toBe(checkScript("fid-audit"));
  });
  it("rejects unknown and path-like names", async () => {
    await expect(affinityCheck.run(ctx, { name: "nope" })).rejects.toThrow("There's no check called 'nope'. Available: document-summary, fid-audit, map-structure.");
    for (const name of ["../x", "a/b", "_prelude", "document-summary.js"]) {
      await expect(affinityCheck.run(ctx, { name })).rejects.toThrow(/^There's no check called/);
    }
  });
  it("no check opens a dialog, sets a timer, changes the document or loads anything but Affinity's own modules", () => {
    for (const name of NAMES) {
      const src = checkScript(name);
      expect(src).not.toMatch(/app\.alert|setTimeout|setInterval|HttpRequest|createSet|createMove|createDelete|executeCommand|AddChildNodes/);
      for (const m of src.matchAll(/require\(([^)]*)\)/g)) expect(m[1]).toMatch(/^'(\/[a-z]+\.js|affinity:[a-z]+)'$/);
    }
  });
  it("every check says so when no document is open", () => {
    for (const name of NAMES) expect(runWith(checkScript(name), null)).toEqual({ error: "No document is open in Affinity." });
  });
  it("fid-audit counts objects per layer and finds duplicates and missing records", () => {
    const buildings = node("Buildings", { "geo:role": "buildings" }, [
      node("b1", { "geo:fid": "buildings:1", "geo:sent": "{}" }),
      node("b1 copy", { "geo:fid": "buildings:1", "geo:sent": "{}" }),
      node("b2", { "geo:fid": "buildings:2" }),
      node("hand drawn"),
    ]);
    const board = node("Overview", { "geo:map": '{"projectId":"p","mapId":"m"}' }, [node("Map — Overview", { "geo:mapframe": "{}" }, [buildings])]);
    const doc = { title: "Test", dpi: 300, spreads: [{ artboards: [{ node: board }] }], layers: [board] };
    expect(runWith(checkScript("fid-audit"), doc)).toEqual({
      title: "Test", total: 3, withoutSent: 1,
      byLayer: { "Overview / buildings": 3 },
      duplicates: [{ artboard: "Overview", fid: "buildings:1", count: 2 }],
    });
  });
  it("map-structure reports the frame, its layers and an unmasked Location", () => {
    const location = node("Location", { "geo:role": "location" }, [node("Water", { "geo:role": "water" }, [node("w", { "geo:fid": "water:1" })])]);
    const frame = node("Map — Overview", { "geo:mapframe": '{"mapId":"m"}' }, [node("Background", { "geo:role": "background" }), location]);
    const board = node("Overview", { "geo:map": '{"projectId":"p","mapId":"m"}' }, [frame]);
    const doc = { title: "Test", dpi: 300, spreads: [{ artboards: [{ node: board }] }], layers: [] };
    const r = runWith(checkScript("map-structure"), doc) as { maps: Array<{ artboard: string; frames: Array<Record<string, unknown>> }> };
    expect(r.maps).toHaveLength(1);
    expect(r.maps[0]!.artboard).toBe("Overview");
    expect(r.maps[0]!.frames).toEqual([{
      name: "Map — Overview", tag: { mapId: "m" },
      layers: [{ name: "Background", role: "background", children: 0, objects: 0 }, { name: "Location", role: "location", children: 1, objects: 0 }],
      location: { masked: false, maskName: null, maskFill: null, enclosureCount: 0, layers: [{ name: "Water", role: "water", children: 1, objects: 1 }] },
      context: null, strayMasks: 0,
    }]);
  });
  it("document-summary lists artboards with sizes in mm", () => {
    const board = node("Overview", { "geo:map": "{}" }, [node("o", { "geo:fid": "x:1" })]);
    const doc = { title: "Test", dpi: 254, spreads: [{ artboards: [{ node: board, spreadBaseBox: { width: 2100, height: 2970 } }] }], layers: [board, node("Loose layer")] };
    expect(runWith(checkScript("document-summary"), doc)).toEqual({
      title: "Test", dpi: 254,
      artboards: [{ name: "Overview", widthMm: 210, heightMm: 297, isMap: true }],
      topLevel: [{ name: "Overview", children: 1, map: {} }, { name: "Loose layer", children: 0, map: null }],
      taggedObjects: 1, masks: 0,
    });
  });
});
