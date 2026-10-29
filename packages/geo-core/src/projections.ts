import { geoAzimuthalEqualArea, geoEqualEarth, geoMercator } from "d3-geo";
import type { GeoProjection } from "d3-geo";
import { crsFromEpsg } from "./crs.js";
import type { Bbox, CrsInfo } from "./types.js";

export interface ProjectionDef {
  id: string;
  name: string;
  description: string;
  kind: "proj4" | "d3";
  crs?: CrsInfo;
  params?: string[];
}

export interface ResolvedProjection {
  def: ProjectionDef;
  params: Record<string, number>;
  crs: CrsInfo | null;
  d3: GeoProjection | null;
}

export const PROJECTIONS: ProjectionDef[] = [
  {
    id: "web-mercator",
    name: "Web Mercator",
    description:
      "The projection used by online maps. Keeps shapes true locally but makes areas near the poles look far too big.",
    kind: "d3",
  },
  {
    id: "equal-earth",
    name: "Equal Earth",
    description: "A world map where every country keeps its true size. A good default for world maps.",
    kind: "d3",
  },
  {
    id: "bng",
    name: "British National Grid",
    description: "The Ordnance Survey grid for Great Britain. Use it for UK maps and OS data.",
    kind: "proj4",
    crs: crsFromEpsg(27700),
  },
  {
    id: "laea",
    name: "Lambert Azimuthal Equal Area",
    description: "Keeps areas true around a centre point you choose. Good for continents and large regions.",
    kind: "d3",
    params: ["lon0", "lat0"],
  },
  {
    id: "utm",
    name: "UTM zone",
    description:
      "A grid of narrow zones with very little distortion. Good for detailed maps of a city or region.",
    kind: "proj4",
    params: ["zone", "south"],
  },
];

export function getProjection(id: string, params: Record<string, number> = {}): ResolvedProjection {
  const def = PROJECTIONS.find((p) => p.id === id);
  if (!def) throw new Error(`"${id}" isn't one of the projections AffinityGeo offers.`);
  switch (id) {
    case "web-mercator":
      return { def, params: {}, crs: null, d3: geoMercator().scale(1).translate([0, 0]) };
    case "equal-earth":
      return { def, params: {}, crs: null, d3: geoEqualEarth().scale(1).translate([0, 0]) };
    case "bng":
      return { def, params: {}, crs: def.crs!, d3: null };
    case "laea": {
      const lon0 = params.lon0 ?? 0;
      const lat0 = params.lat0 ?? 0;
      return {
        def,
        params: { lon0, lat0 },
        crs: null,
        d3: geoAzimuthalEqualArea().rotate([-lon0, -lat0]).scale(1).translate([0, 0]),
      };
    }
    default: {
      const zone = params.zone;
      if (zone === undefined || !Number.isInteger(zone) || zone < 1 || zone > 60) {
        throw new Error("UTM needs a zone number between 1 and 60. Pick the zone your map sits in.");
      }
      const south = params.south ? 1 : 0;
      return {
        def,
        params: south ? { zone, south: 1 } : { zone },
        crs: crsFromEpsg((south ? 32700 : 32600) + zone),
        d3: null,
      };
    }
  }
}

/** The UTM zone (and hemisphere, when south) that the middle of an area falls in. */
export function utmParams(bboxWgs84: Bbox): { zone: number; south?: 1 } {
  const lon0 = (bboxWgs84[0] + bboxWgs84[2]) / 2;
  const lat0 = (bboxWgs84[1] + bboxWgs84[3]) / 2;
  const zone = Math.min(60, Math.max(1, Math.floor((lon0 + 180) / 6) + 1));
  return lat0 < 0 ? { zone, south: 1 } : { zone };
}

export function suggestProjection(bboxWgs84: Bbox): { id: string; params?: Record<string, number> } {
  const [minX, minY, maxX, maxY] = bboxWgs84;
  const width = maxX - minX;
  if (width > 90) return { id: "equal-earth" };
  if (minX >= -9 && maxX <= 2.5 && minY >= 49 && maxY <= 61) return { id: "bng" };
  const lon0 = (minX + maxX) / 2;
  const lat0 = (minY + maxY) / 2;
  if (width < 6) {
    return { id: "utm", params: utmParams(bboxWgs84) };
  }
  return { id: "laea", params: { lon0, lat0 } };
}
