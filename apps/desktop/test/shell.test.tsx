// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/ui/App.js";
import { platform } from "../src/ui/platform.js";
import { resetApp, type AppState } from "../src/ui/store.js";
import { Shell } from "../src/ui/shell/Shell.js";
import { StatusBar } from "../src/ui/shell/StatusBar.js";
import { TopBar } from "../src/ui/shell/TopBar.js";

const project = { id: "p1", name: "Hyde Park", maps: [] } as unknown as NonNullable<AppState["project"]>;

beforeEach(() => resetApp({ project }));
afterEach(cleanup);

describe("Shell", () => {
  it("Shell renders the rail in order Area, Maps, Style, Data / Guide, Settings and the mode pill follows the screen", () => {
    render(<Shell onGuide={() => {}} onSettings={() => {}} />);
    const rail = screen.getByRole("navigation", { name: "Screens" });
    const labels = within(rail).getAllByRole("button").map((b) => b.textContent);
    expect(labels).toEqual(["Area", "Maps", "Style", "Data", "Guide", "Settings"]);

    const pill = screen.getByTestId("mode-pill");
    expect(pill.textContent).toBe("Maps");
    fireEvent.click(within(rail).getByRole("button", { name: "Style" }));
    expect(pill.textContent).toBe("Style");
    expect(pill.dataset.screen).toBe("style");
    expect(within(rail).getByRole("button", { name: "Style" }).getAttribute("aria-current")).toBe("page");
  });

  it("StatusBar shows \"Affinity connected\" in green when connected, \"Affinity not connected\" in grey otherwise, and the version", () => {
    resetApp({ connection: { connected: true, busy: false } });
    render(<StatusBar />);
    const dot = screen.getByTestId("connection-dot");
    expect(screen.getByText("Affinity connected")).toBeTruthy();
    expect(dot.dataset.state).toBe("connected");
    expect(dot.className).toContain("is-green");
    expect(screen.getByText(`AffinityGeo ${platform.version}`)).toBeTruthy();

    act(() => resetApp({ connection: { connected: false, busy: false } }));
    expect(screen.getByText("Affinity not connected")).toBeTruthy();
    expect(dot.dataset.state).toBe("disconnected");
    expect(dot.className).toContain("is-grey");
  });

  it("StatusBar shows Update ready with Restart", () => {
    let ready: ((version: string) => void) | undefined;
    const onUpdateReady = vi.spyOn(platform, "onUpdateReady").mockImplementation((cb) => { ready = cb; });
    const restart = vi.spyOn(platform, "restartToUpdate").mockImplementation(() => {});
    render(<StatusBar />);
    expect(onUpdateReady).toHaveBeenCalled();
    expect(screen.queryByText("Update ready: restart to install")).toBeNull();
    act(() => ready!("0.2.0"));
    expect(screen.getByText("Update ready: restart to install")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    expect(restart).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });

  it("App renders the shell with the no-project empty state", async () => {
    resetApp();
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(
      JSON.stringify(url === "/api/affinity" ? { connected: false, busy: false } : { error: "No project is open." }),
      { status: url === "/api/affinity" ? 200 : 409 },
    )));
    render(<App />);
    expect(await screen.findByText("No project open")).toBeTruthy();
    expect(screen.getByText("Affinity not connected")).toBeTruthy();
    expect((screen.getByRole("button", { name: /Send to Affinity/ }) as HTMLButtonElement).disabled).toBe(true);
    vi.unstubAllGlobals();
  });

  it("TopBar shows the blue unsaved dot only when dirty", () => {
    render(<TopBar />);
    expect(screen.getByText("Hyde Park")).toBeTruthy();
    expect(screen.queryByLabelText("Unsaved changes")).toBeNull();
    act(() => resetApp({ project, dirty: true }));
    expect(screen.getByLabelText("Unsaved changes")).toBeTruthy();
  });

  it("TopBar shows the project's name, never the long place name", () => {
    const named = { ...project, name: "Parkland maps", area: { placeName: "Hyde Park, London, England" } } as unknown as NonNullable<AppState["project"]>;
    resetApp({ project: named });
    render(<TopBar />);
    expect(screen.getByText("Parkland maps")).toBeTruthy();
    expect(screen.queryByText(/Kensington/)).toBeNull();
  });
});
