// Minimal declarations for lineclip 2.0.0 (ships no types).
declare module "lineclip" {
  export type ClipPoint = [number, number];
  export type ClipBox = [number, number, number, number]; // minX, minY, maxX, maxY
  export function clipPolyline(points: ClipPoint[], bbox: ClipBox, result?: ClipPoint[][]): ClipPoint[][];
  export function clipPolygon(points: ClipPoint[], bbox: ClipBox): ClipPoint[];
}
