import { describe, expect, it } from "vitest";
import { ROLE_IDS } from "../../src/project/roles.js";
import { PRESETS, PRESET_PAPER, paperFor, roleStyleHash, styleFromPreset, styleHash } from "../../src/project/styles.js";

const HEX = /^#[0-9a-f]{6}$/;
const lum = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const contrastRatio = (a: string, b: string) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

describe("PRESETS", () => {
  it("has the four named presets", () => {
    expect(PRESETS.map((p) => p.presetName)).toEqual(["Light", "Dark", "Print (muted)", "High contrast"]);
  });

  for (const preset of PRESETS) {
    describe(preset.presetName, () => {
      it("covers all 12 roles with valid colours, in draw order", () => {
        expect(Object.keys(preset.roles).sort()).toEqual([...ROLE_IDS].sort());
        ROLE_IDS.forEach((id, i) => {
          const r = preset.roles[id];
          for (const c of [r.fill, r.stroke]) expect(c === null || HEX.test(c)).toBe(true);
          expect(r.order).toBe(i);
          expect(r.strokePt).toBeGreaterThanOrEqual(0);
          expect(r.visible).toBe(id !== "landuse");
          expect(r.pointRadiusPt > 0).toBe(id === "poi");
        });
        for (const c of [preset.marker.dot, preset.marker.ring, preset.marker.text]) expect(c).toMatch(HEX);
        expect(preset.marker.label).toBe("You are here");
        expect(preset.marker.textPt).toBeGreaterThanOrEqual(9);
        expect(preset.marker.textPt).toBeLessThanOrEqual(11);
        expect(PRESET_PAPER[preset.presetName]).toMatch(HEX);
      });

      it("legibility guard: roads sit >= 1.5:1 off building fill, main roads >= 2.5:1 off the paper", () => {
        const b = preset.roles.buildings.fill!;
        expect(contrastRatio(preset.roles.mainRoads.stroke!, b)).toBeGreaterThanOrEqual(1.5);
        expect(contrastRatio(preset.roles.minorRoads.stroke!, b)).toBeGreaterThanOrEqual(1.5);
        expect(contrastRatio(preset.roles.mainRoads.stroke!, PRESET_PAPER[preset.presetName]!)).toBeGreaterThanOrEqual(2.5);
      });

      it("keeps paths clearly distinct from minor roads", () => {
        expect(preset.roles.paths.stroke).not.toBe(preset.roles.minorRoads.stroke);
        expect(preset.roles.paths.strokePt).toBeLessThan(preset.roles.minorRoads.strokePt);
      });
    });
  }

  it("High contrast lines, marker dot and marker text reach 4.5:1 against the paper", () => {
    const hc = PRESETS.find((p) => p.presetName === "High contrast")!;
    const paper = PRESET_PAPER["High contrast"]!;
    for (const id of ROLE_IDS) {
      const s = hc.roles[id].stroke;
      if (s) expect(contrastRatio(s, paper), id).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrastRatio(hc.marker.dot, paper)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(hc.marker.text, paper)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("styleFromPreset", () => {
  it("returns a deep copy", () => {
    const s = styleFromPreset("Light");
    s.roles.water.fill = "#000000";
    s.marker.dot = "#000000";
    const original = PRESETS.find((p) => p.presetName === "Light")!;
    expect(original.roles.water.fill).not.toBe("#000000");
    expect(original.marker.dot).not.toBe("#000000");
  });
  it("throws a plain message for an unknown name", () => {
    expect(() => styleFromPreset("Neon")).toThrow("There's no preset called 'Neon'.");
  });
  it("sets the paper (map background) colour each preset is designed to sit on", () => {
    for (const p of PRESETS) {
      expect(p.paper).toBe(PRESET_PAPER[p.presetName]);
      expect(styleFromPreset(p.presetName).paper).toBe(PRESET_PAPER[p.presetName]);
    }
    expect(styleFromPreset("Dark").paper).toBe("#1d2a33");
  });
});

describe("paperFor", () => {
  it("is the preset's paper, or white for a name it doesn't know", () => {
    expect(paperFor("Light")).toBe("#f4f1ea");
    expect(paperFor("Custom")).toBe("#ffffff");
  });
});

describe("hashes", () => {
  it("styleHash ignores key order and changes with a colour", () => {
    const a = styleFromPreset("Dark");
    const reordered = { paper: a.paper, marker: a.marker, roles: Object.fromEntries(Object.entries(a.roles).reverse()), presetName: a.presetName } as typeof a;
    expect(styleHash(reordered)).toBe(styleHash(a));
    const b = styleFromPreset("Dark");
    b.roles.water.fill = "#010203";
    expect(styleHash(b)).not.toBe(styleHash(a));
    expect(styleHash(a)).toMatch(/^[0-9a-f]{8}$/);
    const c = styleFromPreset("Dark");
    c.paper = "#000000";
    expect(styleHash(c)).not.toBe(styleHash(a));
  });
  it("roleStyleHash is stable and sensitive", () => {
    const r = styleFromPreset("Light").roles.paths;
    expect(roleStyleHash({ ...r })).toBe(roleStyleHash({ order: r.order, visible: r.visible, strokePt: r.strokePt, stroke: r.stroke, fill: r.fill, pointRadiusPt: r.pointRadiusPt }));
    expect(roleStyleHash({ ...r, strokePt: r.strokePt + 0.25 })).not.toBe(roleStyleHash(r));
  });
});
