// @vitest-environment jsdom
// The Data screen: attribute table, sorting, paging, columns and Select by attribute.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PRESETS, type AreaSpec, type MapSpec } from "@affinitygeo/geo-core/view";
import { ApiFail, api, type FeatureRow } from "../src/ui/api.js";
import { DataScreen } from "../src/ui/data/DataScreen.js";
import { getApp, resetApp, setApp, type AppState } from "../src/ui/store.js";

vi.mock("../src/ui/map/MapCanvas.js", () => ({
  MapCanvas: (p: { highlight?: { role: string; fids: string[] } }) => (
    <div data-testid="canvas" data-role={p.highlight?.role ?? ""} data-fids={p.highlight ? p.highlight.fids.join(",") : "none"} />
  ),
}));

const area: AreaSpec = { placeName: "W", bboxWgs84: [-0.17, 51.50, -0.14, 51.52], projectionId: "bng" };
type Project = NonNullable<AppState["project"]>;
const map = (id: string, name: string): MapSpec => ({ id, name }) as unknown as MapSpec;
const project = (maps: MapSpec[]): Project =>
  ({ id: "p1", name: "W", area, style: structuredClone(PRESETS[0]!), maps, dataVersion: 1, sources: {}, fetchedAt: null, version: 1 }) as unknown as Project;

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ fid: `f${i}`, name: `Building ${i}`, attrs: { area: i * 10, levels: 2, a3: 1, a4: 1, a5: 1, a6: 1, a7: "x" } }));

function start(connected = true) {
  resetApp({
    project: project([map("m1", "Parkland"), map("m2", "Town")]), selectedMapIds: ["m2"], screen: "data",
    connection: { connected, busy: false }, preview: { status: "none" },
    counts: { buildings: 2400 } as unknown as AppState["counts"],
  });
  const fake = {
    features: vi.spyOn(api, "features").mockResolvedValue({ total: 2400, rows: rows(3) }),
    match: vi.spyOn(api, "match").mockResolvedValue({ fids: ["f1", "f2"] }),
    selectOnMap: vi.spyOn(api, "selectOnMap").mockResolvedValue({ matched: 2, selected: 2 }),
    areaPreview: vi.spyOn(api, "areaPreview").mockImplementation(() => new Promise(() => {})),
  };
  render(<DataScreen />);
  return fake;
}

beforeEach(() => { vi.stubGlobal("Path2D", class {}); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

async function runFilter(text: string) {
  fireEvent.change(screen.getByLabelText("Filter"), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Find" }));
  await flush();
}

describe("Data screen", () => {
  it("shows the page range and a compact table", async () => {
    start();
    await flush();
    expect(screen.getByText("1–3 of 2,400")).toBeTruthy();
    expect(screen.getByText("Building 1")).toBeTruthy();
  });

  it("sort header click requests sort=area dir=asc then desc", async () => {
    const fake = start();
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /^area/ }));
    await flush();
    expect(fake.features).toHaveBeenLastCalledWith("buildings", expect.objectContaining({ sort: "area", dir: "asc", offset: 0, limit: 100 }));
    fireEvent.click(screen.getByRole("button", { name: /^area/ }));
    await flush();
    expect(fake.features).toHaveBeenLastCalledWith("buildings", expect.objectContaining({ sort: "area", dir: "desc" }));
  });

  it("shows six columns by default and the picker adds more", async () => {
    start();
    await flush();
    expect(screen.queryByRole("button", { name: /^a7/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Columns" }));
    fireEvent.click(screen.getByLabelText("a7"));
    expect(screen.getByRole("button", { name: /^a7/ })).toBeTruthy();
  });

  it("debounces the search by 300 ms and goes back to the first page", async () => {
    const fake = start();
    await flush();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.change(screen.getByLabelText("Search"), { target: { value: "oak" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(299); });
    expect(fake.features).not.toHaveBeenCalledWith("buildings", expect.objectContaining({ q: "oak" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(2); });
    expect(fake.features).toHaveBeenLastCalledWith("buildings", expect.objectContaining({ q: "oak", offset: 0 }));
  });

  it("Next asks for the next 100", async () => {
    const fake = start();
    fake.features.mockResolvedValue({ total: 250, rows: rows(100) });
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await flush();
    expect(fake.features).toHaveBeenLastCalledWith("buildings", expect.objectContaining({ offset: 100 }));
  });

  it("bad filter shows the caret under position 9", async () => {
    const fake = start();
    fake.match.mockRejectedValue(new ApiFail(400, "Unknown field 'wat'", 9));
    await flush();
    await runFilter("area > 5 wat 3");
    expect(screen.getByRole("alert").textContent).toContain("Unknown field 'wat'");
    const echo = screen.getByTestId("filter-echo");
    expect(echo.textContent).toBe("area > 5 wat 3\n         ^");
    expect(screen.getByTestId("canvas").getAttribute("data-fids")).toBe("none");
  });

  it("good filter shows 37 match and passes highlight fids to the canvas", async () => {
    const fake = start();
    fake.match.mockResolvedValue({ fids: Array.from({ length: 37 }, (_, i) => `f${i}`) });
    await flush();
    await runFilter("area > 100");
    expect(screen.getByText("37 match")).toBeTruthy();
    const c = screen.getByTestId("canvas");
    expect(c.getAttribute("data-role")).toBe("buildings");
    expect(c.getAttribute("data-fids")?.split(",")).toHaveLength(37);
    await runFilter("");
    expect(screen.getByTestId("canvas").getAttribute("data-fids")).toBe("none");
  });

  it("Select in Affinity is disabled when not connected", async () => {
    start(false);
    await flush();
    await runFilter("area > 100");
    expect((screen.getByRole("button", { name: "Select in Affinity" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("Select in Affinity is disabled while Affinity is busy", async () => {
    start();
    act(() => { setApp({ connection: { connected: true, busy: true } }); });
    await flush();
    await runFilter("area > 100");
    expect((screen.getByRole("button", { name: "Select in Affinity" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("Select in Affinity calls select with the chosen map", async () => {
    const fake = start();
    await flush();
    await runFilter("area > 100");
    const sel = screen.getByLabelText("Map") as HTMLSelectElement;
    expect(sel.value).toBe("m2");
    fireEvent.change(sel, { target: { value: "m1" } });
    fireEvent.click(screen.getByRole("button", { name: "Select in Affinity" }));
    await flush();
    expect(fake.selectOnMap).toHaveBeenCalledWith("buildings", "m1", "area > 100");
  });

  it("Select in Affinity is lime, like every button that sends to Affinity", async () => {
    start();
    await flush();
    await runFilter("area > 100");
    expect(screen.getByRole("button", { name: "Select in Affinity" }).className).toContain("btn-primary");
  });

  it("the match count is one unbreakable label", async () => {
    const fake = start();
    fake.match.mockResolvedValue({ fids: Array.from({ length: 61 }, (_, i) => `f${i}`) });
    await flush();
    await runFilter("building = 'university'");
    expect(screen.getByText("61 match").className).toContain("match-count");
  });
});

describe("Data screen filter caret", () => {
  it("puts the caret under the right character when the filter has leading spaces", async () => {
    const fake = start();
    fake.match.mockRejectedValue(new ApiFail(400, "bad", 9));
    await flush();
    await runFilter("  area > 5 wat");
    expect(fake.match).toHaveBeenCalledWith("buildings", "area > 5 wat");
    expect(screen.getByTestId("filter-echo").textContent).toBe("area > 5 wat\n         ^");
  });

  it("copies tabs and counts an emoji as one cell", async () => {
    const fake = start();
    fake.match.mockRejectedValue(new ApiFail(400, "bad", 4));
    await flush();
    await runFilter("a\t\u{1F600}x y");
    expect(screen.getByTestId("filter-echo").textContent).toBe("a\t\u{1F600}x y\n \t ^");
  });

  it("the newer features reply wins when the older one lands last", async () => {
    const fake = start();
    await flush();
    let first!: (v: { total: number; rows: FeatureRow[] }) => void;
    fake.features.mockImplementationOnce(() => new Promise((r) => { first = r; }));
    fake.features.mockResolvedValueOnce({ total: 1, rows: [{ fid: "n", name: "Newer", attrs: {} }] });
    fireEvent.click(screen.getByRole("button", { name: /^name/ }));
    fireEvent.click(screen.getByRole("button", { name: /^name/ }));
    await flush();
    await act(async () => { first({ total: 1, rows: [{ fid: "o", name: "Older", attrs: {} }] }); });
    expect(screen.getByText("Newer")).toBeTruthy();
    expect(screen.queryByText("Older")).toBeNull();
  });

  it("a search from page 3 goes back to offset 0", async () => {
    const fake = start();
    fake.features.mockResolvedValue({ total: 900, rows: rows(100) });
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Next" })); await flush();
    fireEvent.click(screen.getByRole("button", { name: "Next" })); await flush();
    expect(fake.features).toHaveBeenLastCalledWith("buildings", expect.objectContaining({ offset: 200 }));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.change(screen.getByLabelText("Search"), { target: { value: "oak" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(310); });
    expect(fake.features).toHaveBeenLastCalledWith("buildings", expect.objectContaining({ q: "oak", offset: 0 }));
  });

  it("clears the old rows when the role switches", async () => {
    const fake = start();
    await flush();
    expect(screen.getByText("Building 1")).toBeTruthy();
    fake.features.mockImplementation(() => new Promise(() => {}));
    fireEvent.change(screen.getByLabelText("Layer"), { target: { value: "water" } });
    await flush();
    expect(screen.queryByText("Building 1")).toBeNull();
  });

  it("refetches the page and re-runs the match when dataVersion changes", async () => {
    const fake = start();
    await flush();
    await runFilter("area > 100");
    fake.features.mockClear(); fake.match.mockClear();
    act(() => { setApp({ project: { ...getApp().project!, dataVersion: 2 } }); });
    await flush();
    expect(fake.features).toHaveBeenCalledTimes(1);
    expect(fake.match).toHaveBeenCalledWith("buildings", "area > 100");
  });
});
