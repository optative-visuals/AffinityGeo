import { describe, expect, it } from "vitest";
import { PAPER, nextMapName, sizeLabel, upLabel } from "../src/ui/maps/sizes.js";

describe("paper sizes", () => {
  it("sizes: A3 landscape is 420 × 297; sizeLabel names presets and customs", () => {
    const a3 = PAPER.find((p) => p.id === "A3")!;
    expect([a3.w, a3.h]).toEqual([297, 420]);
    expect(PAPER.map((p) => p.id)).toEqual(["A5", "A4", "A3", "A2", "A1", "A0"]);
    expect(sizeLabel({ width: 420, height: 297 })).toBe("A3 landscape");
    expect(sizeLabel({ width: 210, height: 297 })).toBe("A4 portrait");
    expect(sizeLabel({ width: 297.2, height: 420 })).toBe("A3 portrait");
    expect(sizeLabel({ width: 300, height: 200 })).toBe("300 × 200 mm");
    expect(sizeLabel({ width: 150.5, height: 100 })).toBe("150.5 × 100 mm");
  });

  it("new maps take the lowest unused Map N", () => {
    expect(nextMapName([])).toBe("Map 1");
    expect(nextMapName(["Map 1", "Map 3", "Library"])).toBe("Map 2");
    expect(nextMapName(["Map 2", "Map 1"])).toBe("Map 3");
    expect(nextMapName(["Map 0", "Map one"])).toBe("Map 1");
  });
});

describe("rotation helper", () => {
  it("names the bearing on a 16-point compass", () => {
    expect(upLabel(330)).toBe("Up is 330° — north-north-west");
    expect(upLabel(0)).toBe("Up is 0° — north");
    expect(upLabel(360)).toBe("Up is 0° — north");
    expect(upLabel(-90)).toBe("Up is 270° — west");
    expect(upLabel(90)).toBe("Up is 90° — east");
    expect(upLabel(22.5)).toBe("Up is 22.5° — north-north-east");
    expect(upLabel(67)).toBe("Up is 67° — east-north-east");
  });
});
