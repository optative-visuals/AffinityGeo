// Minimal declarations for the parts of "shapefile" 0.6.x that geo-core uses.
declare module "shapefile" {
  export interface ShapefileFeature {
    type: "Feature";
    properties: Record<string, unknown> | null;
    geometry: { type: string; coordinates?: unknown } | null;
  }
  export interface ShapefileSource {
    read(): Promise<{ done: boolean; value: ShapefileFeature }>;
    cancel(): Promise<void>;
  }
  export interface OpenOptions { encoding?: string }
  export function open(
    shp: string | Uint8Array | ArrayBuffer,
    dbf?: string | Uint8Array | ArrayBuffer | null,
    options?: OpenOptions,
  ): Promise<ShapefileSource>;
}
