import type { GeometryKind } from "../types.js";
import type { RoleId } from "./types.js";

/** Draw order, bottom to top. */
export const ROLE_IDS: RoleId[] = ["landuse", "green", "water", "carParks", "buildings", "landmarks", "rail",
  "mainRoads", "minorRoads", "paths", "steps", "poi"];

export const ROLE_LABELS: Record<RoleId, string> = {
  landuse: "Land use", green: "Green space", water: "Water", carParks: "Car parks", buildings: "Buildings",
  landmarks: "Landmark buildings", rail: "Rail", mainRoads: "Main roads", minorRoads: "Minor roads",
  paths: "Paths and footways", steps: "Steps", poi: "Points of interest",
};

const MAIN = /^(motorway|trunk|primary|secondary|tertiary)(_link)?$/;
const MINOR = new Set(["residential", "unclassified", "service", "living_street"]);
const PATHS = new Set(["footway", "path", "pedestrian", "cycleway", "bridleway", "track"]);
const GREEN_LEISURE = new Set(["park", "garden", "pitch"]);
const GREEN_LANDUSE = new Set(["grass", "recreation_ground", "forest", "meadow"]);
const RAIL = new Set(["rail", "light_rail", "subway", "tram", "narrow_gauge"]);

/** Which map role an OpenStreetMap feature belongs to, or null when it isn't drawn. First matching rule wins. */
export function roleForOsmTags(tags: Record<string, string>, geometryKind: GeometryKind): RoleId | null {
  const hw = tags.highway;
  if (hw) {
    if (MAIN.test(hw)) return "mainRoads";
    if (MINOR.has(hw)) return "minorRoads";
    if (PATHS.has(hw)) return "paths";
    if (hw === "steps") return "steps";
  }
  if (tags.building || tags["building:part"]) {
    return tags.name && (tags.amenity || tags.tourism || tags.historic) ? "landmarks" : "buildings";
  }
  if (tags.amenity === "parking" && geometryKind === "polygon") return "carParks";
  if (tags.natural === "water" || tags.waterway === "riverbank" || tags.water) return "water";
  if ((tags.leisure && GREEN_LEISURE.has(tags.leisure)) || (tags.landuse && GREEN_LANDUSE.has(tags.landuse)) || tags.natural === "wood") return "green";
  if (tags.landuse) return "landuse";
  if (tags.railway && RAIL.has(tags.railway)) return "rail";
  if (geometryKind !== "line" && (tags.amenity || tags.tourism || tags.shop || tags.entrance || tags.public_transport || hw === "bus_stop")) return "poi";
  return null;
}
