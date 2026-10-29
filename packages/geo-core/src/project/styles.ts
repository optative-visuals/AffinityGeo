// Built-in looks for a street-level map. Colours are adapted from CavalryGeo's styles.js
// (GPL-3.0, same author) and retuned for print at street scale. Widths are in points.
import { ROLE_IDS } from "./roles.js";
import type { MarkerStyle, ProjectStyle, RoleId, RoleStyle } from "./types.js";

type Row = [fill: string | null, stroke: string | null, strokePt: number];

/** The page / land colour each preset is designed to sit on: the map background it draws. */
export const PRESET_PAPER: Record<string, string> = {
  "Light": "#f4f1ea", "Dark": "#1d2a33", "Print (muted)": "#fbfaf7", "High contrast": "#ffffff",
};

/** The paper for a preset name; white for a name that isn't a preset. */
export function paperFor(presetName: string): string {
  return Object.prototype.hasOwnProperty.call(PRESET_PAPER, presetName) ? PRESET_PAPER[presetName]! : "#ffffff";
}

function preset(presetName: string, rows: Record<RoleId, Row>, marker: MarkerStyle, poiRadiusPt = 2.5): ProjectStyle {
  const roles = {} as Record<RoleId, RoleStyle>;
  ROLE_IDS.forEach((id, order) => {
    const [fill, stroke, strokePt] = rows[id];
    roles[id] = { fill, stroke, strokePt, visible: id !== "landuse", order, pointRadiusPt: id === "poi" ? poiRadiusPt : 0 };
  });
  return { presetName, paper: paperFor(presetName), roles, marker };
}

const YAH = "You are here";

export const PRESETS: ProjectStyle[] = [
  preset("Light", {
    landuse: ["#ebe7dc", null, 0], green: ["#d5e6c8", null, 0], water: ["#aed0e0", null, 0],
    carParks: ["#e3dfd4", "#c9c2b2", 0.25], buildings: ["#d6d1c4", "#b0a999", 0.25], landmarks: ["#c4b8a0", "#8f8470", 0.5],
    rail: [null, "#8a8a8a", 1], mainRoads: [null, "#cf7a1f", 4], minorRoads: [null, "#a79f8c", 2.5],
    paths: [null, "#b5532f", 0.75], steps: [null, "#7a5c3e", 1], poi: ["#e4572e", "#ffffff", 0.5],
  }, { dot: "#e4572e", ring: "#ffffff", text: "#333333", textPt: 10, label: YAH }),
  preset("Dark", {
    landuse: ["#25343d", null, 0], green: ["#2f4a3a", null, 0], water: ["#3d6178", null, 0],
    carParks: ["#2a3a44", "#3a4a54", 0.25], buildings: ["#4a5a62", "#5f7078", 0.25], landmarks: ["#6b7f88", "#8fa0a8", 0.5],
    rail: [null, "#8a948e", 1], mainRoads: [null, "#c9b27a", 4], minorRoads: [null, "#8a948e", 2.5],
    paths: [null, "#f2a65a", 0.75], steps: [null, "#e6e6e6", 1], poi: ["#e4572e", "#1d2a33", 0.5],
  }, { dot: "#e4572e", ring: "#ffffff", text: "#e6e6e6", textPt: 10, label: YAH }),
  preset("Print (muted)", {
    landuse: ["#efefef", null, 0], green: ["#e2e8dc", null, 0], water: ["#d3dde2", null, 0],
    carParks: ["#ececec", "#cfcfcf", 0.25], buildings: ["#dcdcdc", "#bdbdbd", 0.25], landmarks: ["#c4c4c4", "#8c8c8c", 0.5],
    rail: [null, "#8c8c8c", 0.75], mainRoads: [null, "#6f6f6f", 4], minorRoads: [null, "#a0a0a0", 2.5],
    paths: [null, "#5a5a5a", 0.75], steps: [null, "#3c3c3c", 1], poi: ["#4a4a4a", "#ffffff", 0.5],
  }, { dot: "#333333", ring: "#ffffff", text: "#333333", textPt: 10, label: YAH }),
  preset("High contrast", {
    landuse: ["#f0f0f0", null, 0], green: ["#cfe8c0", "#2e6b2e", 0.5], water: ["#9fd0ee", "#004a80", 0.5],
    carParks: ["#e0e0e0", "#404040", 0.5], buildings: ["#cfcfcf", "#000000", 0.5], landmarks: ["#ffd24d", "#000000", 0.75],
    rail: [null, "#333333", 1.25], mainRoads: [null, "#000000", 5], minorRoads: [null, "#404040", 3],
    paths: [null, "#b00020", 1], steps: [null, "#5b2c83", 1.25], poi: ["#b00020", "#000000", 0.5],
  }, { dot: "#b00020", ring: "#ffffff", text: "#000000", textPt: 11, label: YAH }, 3),
];

export function styleFromPreset(name: string): ProjectStyle {
  const p = PRESETS.find((x) => x.presetName === name);
  if (!p) throw new Error(`There's no preset called '${name}'.`);
  return structuredClone(p);
}

export function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/** FNV-1a (32-bit) of the key-sorted JSON, as 8 hex digits. */
export function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, "0");
}

export const styleHash = (style: ProjectStyle): string => fnv(stable(style));
export const roleStyleHash = (s: RoleStyle): string => fnv(stable(s));
