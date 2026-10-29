// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/ui/api.js";
import { platform } from "../src/ui/platform.js";
import { Shell } from "../src/ui/shell/Shell.js";
import { resetApp, setApp, type AppState, type Screen } from "../src/ui/store.js";
import { FirstRunHost, resetFirstRun } from "../src/ui/settings/FirstRun.js";
import { closeAbout } from "../src/ui/settings/About.js";
import { closeGuide } from "../src/ui/settings/Guide.js";
import { closeSettings } from "../src/ui/settings/Settings.js";
import { GUIDE } from "../src/ui/settings/guide-text.js";
import { GITHUB_URL } from "../src/shared/geo-app.js";
import { cleanSettings, mergeSettings } from "../src/shared/settings.js";
import { PRESETS, type AreaSpec } from "@affinitygeo/geo-core/view";
import { AreaScreen } from "../src/ui/area/AreaScreen.js";
import { DataScreen } from "../src/ui/data/DataScreen.js";
import { MapsScreen } from "../src/ui/maps/MapsScreen.js";
import { StyleScreen } from "../src/ui/style/StyleScreen.js";
import { windowOpenAction } from "../src/main/links.js";

type Project = NonNullable<AppState["project"]>;
const project = { id: "p1", name: "Hyde Park", maps: [] } as unknown as Project;
const LOADER = "// Geo – Connect\nrequire('C:/AffinityGeo/affinity/connect.js').start();";

const flush = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });

beforeEach(() => {
  resetApp({ project });
  vi.spyOn(api, "scripts").mockResolvedValue({ loader: LOADER, home: "C:\\AffinityGeo", installed: true });
  vi.spyOn(platform, "settings").mockResolvedValue({ appearance: "system", firstRunDone: false });
  vi.spyOn(platform, "saveSettings").mockImplementation(async (patch) => ({ appearance: "system", firstRunDone: false, ...patch }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); closeSettings(); closeGuide(); closeAbout(); });

async function openSettings() {
  render(<Shell />);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Settings" })); });
  await flush();
  return screen.getByRole("dialog", { name: "Settings" });
}

describe("settings file", () => {
  it("cleans what it reads: System and not done by default", () => {
    expect(cleanSettings(null)).toEqual({ appearance: "system", firstRunDone: false });
    expect(cleanSettings({ appearance: "purple", firstRunDone: "yes" })).toEqual({ appearance: "system", firstRunDone: false });
    expect(cleanSettings({ appearance: "dark", firstRunDone: true })).toEqual({ appearance: "dark", firstRunDone: true });
    expect(mergeSettings({ appearance: "dark", firstRunDone: false }, { firstRunDone: true, extra: 1 })).toEqual({ appearance: "dark", firstRunDone: true });
  });
});

describe("Settings popover", () => {
  it("Copy Geo – Connect copies the loader text and shows the next steps", async () => {
    const copy = vi.spyOn(platform, "copyText").mockResolvedValue();
    const pop = await openSettings();
    expect(within(pop).queryByText(/Then in Affinity/)).toBeNull();
    await act(async () => { fireEvent.click(within(pop).getByRole("button", { name: "Copy Geo – Connect" })); });
    expect(copy).toHaveBeenCalledWith(LOADER);
    expect(within(pop).getByText("Then in Affinity: Window ▸ Scripting ▸ Script Editor, New script, paste, Run. Save it so you can run it from the Scripts panel next time.")).toBeTruthy();
  });

  it("shows the scriptsNote under the scripts status", async () => {
    vi.spyOn(api, "scripts").mockResolvedValue({ loader: LOADER, home: "C:\\AffinityGeo", installed: true, scriptsNote: "Scripts updated. In Affinity, run Geo – Connect again." });
    const pop = await openSettings();
    expect(within(pop).getByText("Scripts updated. In Affinity, run Geo – Connect again.")).toBeTruthy();
  });

  it("says where the scripts are installed, or in red that they are missing", async () => {
    let pop = await openSettings();
    expect(within(pop).getByText("Scripts installed in C:\\AffinityGeo\\affinity")).toBeTruthy();
    cleanup();
    closeSettings();
    vi.spyOn(api, "scripts").mockResolvedValue({ loader: LOADER, home: "C:\\AffinityGeo", installed: false });
    pop = await openSettings();
    const missing = within(pop).getByText("Scripts not found. Reinstall AffinityGeo.");
    expect(missing.className).toContain("help-bad");
  });

  it("Appearance is a three-way switch that sets the theme and remembers it", async () => {
    const setTheme = vi.spyOn(platform, "setTheme").mockResolvedValue();
    const pop = await openSettings();
    const group = within(pop).getByRole("radiogroup", { name: "Appearance" });
    const options = within(group).getAllByRole("radio");
    expect(options.map((o) => o.textContent)).toEqual(["Light", "Dark", "System"]);
    expect(within(group).getByRole("radio", { name: "System" }).getAttribute("aria-checked")).toBe("true");
    await act(async () => { fireEvent.click(within(group).getByRole("radio", { name: "Dark" })); });
    expect(setTheme).toHaveBeenCalledWith("dark");
    expect(platform.saveSettings).toHaveBeenCalledWith({ appearance: "dark" });
    expect(within(group).getByRole("radio", { name: "Dark" }).getAttribute("aria-checked")).toBe("true");
  });

  it("closes with Escape", async () => {
    await openSettings();
    act(() => { fireEvent.keyDown(window, { key: "Escape" }); });
    expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
  });

  it("About opens the About dialog with the maker, version, licence and GitHub", async () => {
    const open = vi.spyOn(platform, "openExternal").mockResolvedValue();
    const pop = await openSettings();
    await act(async () => { fireEvent.click(within(pop).getByRole("button", { name: /About AffinityGeo/ })); });
    const about = screen.getByRole("dialog", { name: "AffinityGeo" });
    for (const t of ["Wayfinding maps for Affinity", "Optative", "Licence: GPL-3.0-or-later"]) expect(within(about).getByText(t)).toBeTruthy();
    expect(within(about).getByText(`Version ${platform.version}`)).toBeTruthy();
    expect(within(about).getByText("Map data © OpenStreetMap contributors (ODbL)")).toBeTruthy();
    fireEvent.click(within(about).getByRole("button", { name: "Open source on GitHub" }));
    expect(open).toHaveBeenCalledWith(GITHUB_URL);
    const close = within(about).getByRole("button", { name: "Close" });
    expect(close.className).toContain("btn-primary");
    fireEvent.click(close);
    expect(screen.queryByRole("dialog", { name: "AffinityGeo" })).toBeNull();
  });
});

describe("FirstRun", () => {
  beforeEach(() => { resetFirstRun(); setApp({ connectionChecked: true }); });

  it("waits for the first connection check before deciding", async () => {
    resetApp({ project, connectionChecked: false });
    render(<FirstRunHost />);
    await flush();
    expect(screen.queryByRole("region", { name: "Getting started" })).toBeNull();
    act(() => { setApp({ connection: { connected: true, busy: false }, connectionChecked: true }); });
    await flush();
    expect(screen.queryByRole("region", { name: "Getting started" })).toBeNull(); // already connected: not needed

    cleanup();
    resetFirstRun();
    resetApp({ project, connectionChecked: false });
    render(<FirstRunHost />);
    await flush();
    act(() => { setApp({ connectionChecked: true }); });
    await flush();
    expect(screen.getByRole("region", { name: "Getting started" })).toBeTruthy();
  });

  it("shows the scriptsNote", async () => {
    vi.spyOn(api, "scripts").mockResolvedValue({ loader: LOADER, home: "C:\\AffinityGeo", installed: true, scriptsNote: "Scripts updated. In Affinity, run Geo – Connect again." });
    render(<FirstRunHost />);
    await flush();
    expect(within(screen.getByRole("region", { name: "Getting started" })).getByText("Scripts updated. In Affinity, run Geo – Connect again.")).toBeTruthy();
  });

  it("Done is an outlined button, not lime", async () => {
    render(<FirstRunHost />);
    await flush();
    expect(screen.getByRole("button", { name: "Done" }).className).not.toContain("btn-primary");
  });

  it("ticks step 3 when connected and Done hides it for good", async () => {
    vi.spyOn(platform, "copyText").mockResolvedValue();
    render(<FirstRunHost />);
    await flush();
    const card = screen.getByRole("region", { name: "Getting started" });
    const steps = within(card).getAllByRole("listitem");
    expect(steps).toHaveLength(3);
    expect(steps[0]!.textContent).toContain("In Affinity, open Settings ▸ Scripting and allow C:\\AffinityGeo under File System Access.");
    expect(steps[1]!.textContent).toContain("Copy Geo – Connect, paste it into a new script in the Script Editor and run it");
    expect(steps[2]!.textContent).toContain("The light at the bottom turns green.");
    expect(steps.map((s) => s.getAttribute("data-done"))).toEqual(["false", "false", "false"]);

    await act(async () => { fireEvent.click(within(steps[1]!).getByRole("button", { name: "Copy Geo – Connect" })); });
    expect(platform.copyText).toHaveBeenCalledWith(LOADER);
    expect(steps[1]!.getAttribute("data-done")).toBe("true");

    act(() => { setApp({ connection: { connected: true, busy: false } }); });
    expect(steps.map((s) => s.getAttribute("data-done"))).toEqual(["true", "true", "true"]);

    await act(async () => { fireEvent.click(within(card).getByRole("button", { name: "Done" })); });
    expect(platform.saveSettings).toHaveBeenCalledWith({ firstRunDone: true });
    expect(screen.queryByRole("region", { name: "Getting started" })).toBeNull();

    // The next launch reads the stored flag and stays quiet.
    cleanup();
    resetFirstRun();
    resetApp({ project, connectionChecked: true });
    vi.spyOn(platform, "settings").mockResolvedValue({ appearance: "system", firstRunDone: true });
    render(<FirstRunHost />);
    await flush();
    expect(screen.queryByRole("region", { name: "Getting started" })).toBeNull();
  });

  it("Skip for now hides it until the next launch without setting the flag", async () => {
    render(<FirstRunHost />);
    await flush();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Skip for now" })); });
    expect(screen.queryByRole("region", { name: "Getting started" })).toBeNull();
    expect(platform.saveSettings).not.toHaveBeenCalled();
    cleanup();
    render(<FirstRunHost />); // same launch: stays hidden
    await flush();
    expect(screen.queryByRole("region", { name: "Getting started" })).toBeNull();
  });

  it("isn't shown when Affinity is already connected at start", async () => {
    resetApp({ project, connection: { connected: true, busy: false }, connectionChecked: true });
    render(<FirstRunHost />);
    await flush();
    expect(screen.queryByRole("region", { name: "Getting started" })).toBeNull();
  });
});

describe("Guide", () => {
  const screens: Array<[Screen, string]> = [["area", "Area"], ["maps", "Maps"], ["style", "Style"], ["data", "Data"]];

  const area: AreaSpec = { placeName: "Hyde Park", bboxWgs84: [-0.17, 51.50, -0.14, 51.52], projectionId: "bng" };
  const full = { id: "p1", name: "W", area, style: structuredClone(PRESETS[0]!), maps: [], dataVersion: 1, sources: {}, fetchedAt: null, version: 1 } as unknown as Project;
  const SCREENS = { area: AreaScreen, maps: MapsScreen, style: StyleScreen, data: DataScreen };

  it.each(screens)("the %s screen's ? (next to the mode pill) opens its Guide page", async (id, label) => {
    vi.stubGlobal("Path2D", class { moveTo() {} lineTo() {} closePath() {} arc() {} rect() {} });
    const ctx = new Proxy({}, { get: (t: Record<string, unknown>, k: string) => (k in t ? t[k] : () => undefined), set: (t, k, v) => { t[k as string] = v; return true; } });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
    vi.spyOn(api, "projections").mockResolvedValue([]);
    vi.spyOn(api, "presets").mockResolvedValue([]);
    vi.spyOn(api, "features").mockResolvedValue({ total: 0, rows: [] });
    vi.spyOn(api, "areaPreview").mockImplementation(() => new Promise(() => {}));
    resetApp({ project: full, screen: id, preview: { status: "none" } });
    const Screen = SCREENS[id];
    const { container } = render(<Screen topBar={{}} />);
    await flush();
    const help = screen.getByRole("button", { name: `Guide to the ${label} screen` });
    expect(help.previousElementSibling?.getAttribute("data-testid")).toBe("mode-pill");
    if (id !== "maps") expect(container.querySelector(".toolbar")).toBeNull();
    fireEvent.click(help);
    const page = screen.getByRole("dialog", { name: GUIDE[id].title });
    expect(within(page).getByText(GUIDE[id].intro)).toBeTruthy();
    expect(within(page).getByText("Good to know")).toBeTruthy();
    fireEvent.click(within(page).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    vi.unstubAllGlobals();
  });

  it("the rail's Guide opens the current screen's page", () => {
    resetApp({ project, screen: "style" });
    render(<Shell />);
    fireEvent.click(within(screen.getByRole("navigation", { name: "Screens" })).getByRole("button", { name: "Guide" }));
    expect(screen.getByRole("dialog", { name: GUIDE.style.title })).toBeTruthy();
  });

  it("each page: what it's for, three actions, one good-to-know, at most 120 words", () => {
    for (const [id] of screens) {
      const g = GUIDE[id];
      expect(g.actions).toHaveLength(3);
      const words = [g.title, g.intro, ...g.actions, g.goodToKnow].join(" ").split(/\s+/).filter(Boolean).length;
      expect(words, id).toBeLessThanOrEqual(120);
    }
    expect(GUIDE.maps.actions).toContain("Send draws the selected maps in Affinity. With none selected, it sends every map that has changed.");
    expect(GUIDE.data.actions.join(" ")).toContain("finds the matching roads, buildings or places");
    expect(GUIDE.maps.goodToKnow).toContain("Change something in Affinity and AffinityGeo leaves it alone; 'Reset hand edits' puts it back.");
  });
});

describe("links from the window", () => {
  it("only the GitHub page opens, in the browser; everything else is denied", () => {
    const open = vi.fn();
    expect(windowOpenAction(GITHUB_URL, open)).toEqual({ action: "deny" });
    expect(open).toHaveBeenCalledWith(GITHUB_URL);
    for (const url of ["https://evil.example/", `${GITHUB_URL}/../x`, "https://github.com/optative-visuals", "http://github.com/optative-visuals/AffinityGeo"]) {
      expect(windowOpenAction(url, open)).toEqual({ action: "deny" });
    }
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("the browser fallback opens only the GitHub page too", async () => {
    const win = vi.spyOn(window, "open").mockReturnValue(null);
    await expect(platform.openExternal("https://evil.example/")).rejects.toThrow();
    await platform.openExternal(GITHUB_URL);
    expect(win).toHaveBeenCalledTimes(1);
    expect(win).toHaveBeenCalledWith(GITHUB_URL, "_blank", "noopener");
  });
});
