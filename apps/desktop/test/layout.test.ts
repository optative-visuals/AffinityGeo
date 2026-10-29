// Layout rules from the live test that jsdom can't measure: checked in the stylesheet.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../src/ui/tokens.css", import.meta.url), "utf8");
/** The declarations of the first rule whose selector list is exactly `selector`. */
function rule(selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return css.match(new RegExp(`(?:^|\\n)${esc}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
}

describe("live-test layout fixes", () => {
  it("Gallery cards: the thumbnail can't push the captions out (canvas out of flow, text doesn't shrink)", () => {
    expect(rule(".thumb canvas")).toMatch(/position:\s*absolute/);
    expect(rule(".gallery-card-text")).toMatch(/flex:\s*none/);
    expect(rule(".gallery-card-target")).toMatch(/text-overflow:\s*ellipsis/);
  });

  it("Data screen: the layer dropdown keeps its own width and the search box gets at least 200 px", () => {
    expect(rule(".data-bar select")).toMatch(/width:\s*auto/);
    expect(rule('.data-bar input[type="search"]')).toMatch(/min-width:\s*200px/);
  });

  it("Data screen: the match count stays on one line", () => {
    expect(rule(".match-count")).toMatch(/white-space:\s*nowrap/);
  });

  it("the top bar's project name ellipsises rather than pushing the buttons", () => {
    expect(rule(".doc-name strong")).toMatch(/text-overflow:\s*ellipsis/);
  });

  it("the send progress bar has a shimmer for the map being drawn", () => {
    expect(css).toMatch(/@keyframes send-shimmer/);
  });
});
