// Paper sizes, size labels and small number formats for the Maps screen.

export type PaperId = "A5" | "A4" | "A3" | "A2" | "A1" | "A0";

/** ISO 216 A sizes, portrait, in millimetres. */
export const PAPER: Array<{ id: PaperId; w: number; h: number }> = [
  { id: "A5", w: 148, h: 210 },
  { id: "A4", w: 210, h: 297 },
  { id: "A3", w: 297, h: 420 },
  { id: "A2", w: 420, h: 594 },
  { id: "A1", w: 594, h: 841 },
  { id: "A0", w: 841, h: 1189 },
];

/** Sizes within half a millimetre count as the same paper. */
const TOLERANCE_MM = 0.5;

export interface SizeMm { width: number; height: number }

/** The preset a size matches (either way round), or null for a custom size. */
export function paperFor(size: SizeMm): PaperId | null {
  const near = (a: number, b: number) => Math.abs(a - b) <= TOLERANCE_MM;
  for (const p of PAPER) {
    if ((near(size.width, p.w) && near(size.height, p.h)) || (near(size.width, p.h) && near(size.height, p.w))) return p.id;
  }
  return null;
}

export const isLandscape = (size: SizeMm) => size.width > size.height;

/** A millimetre value for people: at most one decimal, no trailing zeros. */
export function fmtMm(v: number): string {
  return String(Math.round(v * 10) / 10);
}

/** "A3 landscape", "A4 portrait", or "300 × 200 mm" for a custom size. */
export function sizeLabel(size: SizeMm): string {
  const id = paperFor(size);
  if (id) return `${id} ${isLandscape(size) ? "landscape" : "portrait"}`;
  return `${fmtMm(size.width)} × ${fmtMm(size.height)} mm`;
}

/** A preset's size in the given orientation. */
export function paperSize(id: PaperId, landscape: boolean): SizeMm {
  const p = PAPER.find((x) => x.id === id)!;
  return landscape ? { width: p.h, height: p.w } : { width: p.w, height: p.h };
}

/** "Map N" with the lowest positive N no other "Map N" uses. */
export function nextMapName(names: readonly string[]): string {
  const used = new Set<number>();
  for (const n of names) {
    const m = /^Map (\d+)$/.exec(n.trim());
    if (m) used.add(Number(m[1]));
  }
  let n = 1;
  while (used.has(n)) n += 1;
  return `Map ${n}`;
}

/** "1:2,500". */
export function scaleLabel(scale: number): string {
  return `1:${scale.toLocaleString("en-GB")}`;
}

/**
 * Parses a number typed by a person: "2500", "2,500", " -12.5 ". Commas are thousands separators.
 * Returns null when it isn't a plain number.
 */
export function parseNumber(text: string): number | null {
  const t = text.trim().replace(/,/g, "");
  if (!/^[-+]?(\d+\.?\d*|\.\d+)$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

const COMPASS = ["north", "north-north-east", "north-east", "east-north-east", "east", "east-south-east", "south-east",
  "south-south-east", "south", "south-south-west", "south-west", "west-south-west", "west", "west-north-west", "north-west",
  "north-north-west"];

/**
 * The rotation helper: rotationDeg is the compass bearing that points up on the map (1b-A ruling),
 * so 90 reads "Up is 90° — east". The word is the nearest of the 16 compass points.
 */
export function upLabel(rotationDeg: number): string {
  const bearing = ((Math.round(rotationDeg * 10) / 10) % 360 + 360) % 360;
  const word = COMPASS[Math.round(bearing / 22.5) % 16];
  return `Up is ${fmtMm(bearing)}° — ${word}`;
}
