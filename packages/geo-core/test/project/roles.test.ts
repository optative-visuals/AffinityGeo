import { describe, expect, it } from "vitest";
import { ROLE_IDS, ROLE_LABELS, roleForOsmTags } from "../../src/project/roles.js";
import type { GeometryKind } from "../../src/types.js";
import type { RoleId } from "../../src/project/types.js";

describe("roles", () => {
  it("lists the 12 roles bottom to top with labels", () => {
    expect(ROLE_IDS).toEqual(["landuse", "green", "water", "carParks", "buildings", "landmarks", "rail",
      "mainRoads", "minorRoads", "paths", "steps", "poi"]);
    expect(ROLE_IDS.map((r) => ROLE_LABELS[r])).toEqual(["Land use", "Green space", "Water", "Car parks", "Buildings",
      "Landmark buildings", "Rail", "Main roads", "Minor roads", "Paths and footways", "Steps", "Points of interest"]);
  });
});

const cases: Array<[Record<string, string>, GeometryKind, RoleId | null]> = [
  [{ highway: "motorway" }, "line", "mainRoads"],
  [{ highway: "trunk_link" }, "line", "mainRoads"],
  [{ highway: "primary" }, "line", "mainRoads"],
  [{ highway: "secondary" }, "line", "mainRoads"],
  [{ highway: "tertiary_link" }, "line", "mainRoads"],
  [{ highway: "residential" }, "line", "minorRoads"],
  [{ highway: "unclassified" }, "line", "minorRoads"],
  [{ highway: "service" }, "line", "minorRoads"],
  [{ highway: "living_street" }, "line", "minorRoads"],
  [{ highway: "footway" }, "line", "paths"],
  [{ highway: "path" }, "line", "paths"],
  [{ highway: "pedestrian" }, "line", "paths"],
  [{ highway: "cycleway" }, "line", "paths"],
  [{ highway: "bridleway" }, "line", "paths"],
  [{ highway: "track" }, "line", "paths"],
  [{ highway: "steps" }, "line", "steps"],
  [{ building: "yes" }, "polygon", "buildings"],
  [{ "building:part": "yes" }, "polygon", "buildings"],
  [{ building: "yes", name: "Library", amenity: "library" }, "polygon", "landmarks"],
  [{ building: "yes", name: "Hall", tourism: "attraction" }, "polygon", "landmarks"],
  [{ building: "church", name: "St Mary", historic: "church" }, "polygon", "landmarks"],
  [{ building: "yes", amenity: "library" }, "polygon", "buildings"],
  [{ amenity: "parking" }, "polygon", "carParks"],
  [{ natural: "water" }, "polygon", "water"],
  [{ waterway: "riverbank" }, "polygon", "water"],
  [{ water: "pond" }, "polygon", "water"],
  [{ leisure: "park" }, "polygon", "green"],
  [{ leisure: "garden" }, "polygon", "green"],
  [{ leisure: "pitch" }, "polygon", "green"],
  [{ landuse: "grass" }, "polygon", "green"],
  [{ landuse: "forest" }, "polygon", "green"],
  [{ landuse: "meadow" }, "polygon", "green"],
  [{ landuse: "recreation_ground" }, "polygon", "green"],
  [{ natural: "wood" }, "polygon", "green"],
  [{ landuse: "residential" }, "polygon", "landuse"],
  [{ railway: "rail" }, "line", "rail"],
  [{ railway: "tram" }, "line", "rail"],
  [{ railway: "narrow_gauge" }, "line", "rail"],
  [{ amenity: "cafe" }, "point", "poi"],
  [{ tourism: "hotel" }, "point", "poi"],
  [{ shop: "bakery" }, "point", "poi"],
  [{ entrance: "main" }, "point", "poi"],
  [{ public_transport: "platform" }, "point", "poi"],
  [{ highway: "bus_stop" }, "point", "poi"],
  [{ amenity: "parking" }, "point", "poi"],
  [{ barrier: "fence" }, "line", null],
  [{ highway: "street_lamp" }, "point", null],
  [{}, "point", null],
];

describe("roleForOsmTags", () => {
  it.each(cases)("%j (%s) -> %s", (tags, kind, role) => {
    expect(roleForOsmTags(tags, kind)).toBe(role);
  });
});
