declare module "d3-geo-projection" {
  import type { GeoProjection, GeoStream } from "d3-geo";
  export function geoProject(object: unknown, projection: GeoProjection | { stream: GeoStream["stream"] | ((s: unknown) => unknown) }): any;
}
