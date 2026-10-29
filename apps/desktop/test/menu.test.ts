import { describe, expect, it } from "vitest";
import { appMenuTemplate } from "../src/main/menu.js";

describe("the application menu", () => {
  it("has no menu bar on Windows and Linux (Chromium handles Ctrl+C/V/X/A/Z in text fields itself)", () => {
    expect(appMenuTemplate("win32")).toBeNull();
    expect(appMenuTemplate("linux")).toBeNull();
  });

  it("keeps a minimal menu with the edit roles on macOS, where the edit shortcuts need one", () => {
    const t = appMenuTemplate("darwin");
    expect(t).not.toBeNull();
    expect(t!.map((i) => i.role)).toEqual(["appMenu", "editMenu"]);
  });
});
