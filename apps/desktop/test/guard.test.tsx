// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiFail, api } from "../src/ui/api.js";
import { App, handleCloseRequest } from "../src/ui/App.js";
import { platform } from "../src/ui/platform.js";
import { ConfirmHost } from "../src/ui/shell/Confirm.js";
import { ToastHost } from "../src/ui/shell/Toast.js";
import { TopBar } from "../src/ui/shell/TopBar.js";
import { GUARD_READ_MS, getApp, guardUnsaved, registerPendingEdit, resetApp, saveProject, type AppState } from "../src/ui/store.js";
import { projectActions } from "../src/ui/App.js";

type Project = NonNullable<AppState["project"]>;
const project = { id: "p1", name: "Hyde Park", maps: [] } as unknown as Project;

const flush = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); });
const needsPath = () => new ApiFail(400, "Choose where to save the project first.", undefined, "NEEDS_PATH");
const question = () => screen.queryByRole("alertdialog");
const click = async (name: string) => {
  await act(async () => { fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name })); });
  await flush();
};

beforeEach(() => {
  resetApp({ project, dirty: true });
  vi.spyOn(api, "project").mockImplementation(async () => ({ project: getApp().project, dirty: getApp().dirty, counts: null }));
  vi.spyOn(platform, "addRecent").mockResolvedValue([]);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("guardUnsaved asks before New/Open", () => {
  it("asks 'Save changes to …' when dirty; Cancel aborts", async () => {
    render(<ConfirmHost />);
    const action = vi.fn(async () => {});
    let done = false;
    act(() => { void guardUnsaved(action).then(() => { done = true; }); });
    await flush();
    expect(within(question()!).getByText("Save changes to 'Hyde Park' first?")).toBeTruthy();
    const labels = within(question()!).getAllByRole("button").map((b) => b.textContent);
    expect(labels).toEqual(["Save", "Don't save", "Cancel"]);
    await click("Cancel");
    expect(done).toBe(true);
    expect(action).not.toHaveBeenCalled();
  });

  it("Don't save goes ahead without saving", async () => {
    const save = vi.spyOn(api, "save");
    render(<ConfirmHost />);
    const action = vi.fn(async () => {});
    act(() => { void guardUnsaved(action); });
    await flush();
    await click("Don't save");
    expect(action).toHaveBeenCalledTimes(1);
    expect(save).not.toHaveBeenCalled();
  });

  it("Save saves first, then goes ahead", async () => {
    const save = vi.spyOn(api, "save").mockResolvedValue({ ok: true });
    render(<ConfirmHost />);
    const action = vi.fn(async () => { expect(save).toHaveBeenCalled(); });
    act(() => { void guardUnsaved(action); });
    await flush();
    await click("Save");
    expect(save).toHaveBeenCalledWith();
    expect(action).toHaveBeenCalledTimes(1);
  });

  it("asks nothing when the project is clean (or there is none)", async () => {
    render(<ConfirmHost />);
    const action = vi.fn(async () => {});
    resetApp({ project, dirty: false });
    await act(async () => { await guardUnsaved(action); });
    resetApp({ project: null, dirty: true });
    await act(async () => { await guardUnsaved(action); });
    expect(question()).toBeNull();
    expect(action).toHaveBeenCalledTimes(2);
  });
});

describe("Save on an unsaved new project goes through Save As", () => {
  it("asks where with '<name>.afgeo', saves there and remembers it", async () => {
    const save = vi.spyOn(api, "save").mockImplementation(async (path?: string) => {
      if (!path) throw needsPath();
      return { ok: true };
    });
    const saveAs = vi.spyOn(platform, "saveProjectAs").mockResolvedValue("C:/maps/Hyde Park.afgeo");
    let ok = false;
    await act(async () => { ok = await saveProject(); });
    expect(ok).toBe(true);
    expect(saveAs).toHaveBeenCalledWith("Hyde Park.afgeo");
    expect(save).toHaveBeenLastCalledWith("C:/maps/Hyde Park.afgeo");
    expect(platform.addRecent).toHaveBeenCalledWith("C:/maps/Hyde Park.afgeo");
  });

  it("cancelling the Save As dialog cancels the guarded action", async () => {
    vi.spyOn(api, "save").mockRejectedValue(needsPath());
    vi.spyOn(platform, "saveProjectAs").mockResolvedValue(null);
    render(<ConfirmHost />);
    const action = vi.fn(async () => {});
    act(() => { void guardUnsaved(action); });
    await flush();
    await click("Save");
    expect(action).not.toHaveBeenCalled();
  });
});

describe("final review: the guard decides on fresh facts", () => {
  it("asks when the server says unsaved although the app still thinks it is saved", async () => {
    resetApp({ project, dirty: false });
    vi.spyOn(api, "project").mockResolvedValue({ project, dirty: true, counts: null });
    const confirmClose = vi.spyOn(platform, "confirmClose").mockImplementation(() => {});
    render(<ConfirmHost />);
    act(() => { void handleCloseRequest(); });
    await flush();
    expect(within(question()!).getByText("Save changes to 'Hyde Park' first?")).toBeTruthy();
    await click("Cancel");
    expect(confirmClose).not.toHaveBeenCalled();
  });

  it("an edit still waiting for its debounce is sent first and counts as unsaved", async () => {
    resetApp({ project, dirty: false });
    let serverDirty = false;
    vi.spyOn(api, "project").mockImplementation(async () => ({ project, dirty: serverDirty, counts: null }));
    const flushEdit = vi.fn(async () => { serverDirty = true; });
    const unregister = registerPendingEdit(flushEdit);
    const confirmClose = vi.spyOn(platform, "confirmClose").mockImplementation(() => {});
    render(<ConfirmHost />);
    act(() => { void handleCloseRequest(); });
    await flush();
    expect(flushEdit).toHaveBeenCalledTimes(1);
    expect(within(question()!).getByText("Save changes to 'Hyde Park' first?")).toBeTruthy();
    await click("Cancel");
    expect(confirmClose).not.toHaveBeenCalled();
    unregister();
  });

  it("a save failure other than 'no file yet' shows its message, skips Save As and doesn't close", async () => {
    vi.spyOn(api, "save").mockRejectedValue(new ApiFail(400, "The project couldn't be saved: EACCES"));
    const saveAs = vi.spyOn(platform, "saveProjectAs").mockResolvedValue("C:/maps/x.afgeo");
    const confirmClose = vi.spyOn(platform, "confirmClose").mockImplementation(() => {});
    render(<><ConfirmHost /><ToastHost /></>);
    act(() => { void handleCloseRequest(); });
    await flush();
    await click("Save");
    expect(saveAs).not.toHaveBeenCalled();
    expect(confirmClose).not.toHaveBeenCalled();
    expect(screen.getByText("The project couldn't be saved: EACCES")).toBeTruthy();
  });

  it("a server that doesn't answer doesn't hold the guard: it goes on the last known flag", async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(api, "project").mockImplementation(() => new Promise(() => {}));
      render(<ConfirmHost />);
      act(() => { void guardUnsaved(async () => {}); });
      await act(async () => { await vi.advanceTimersByTimeAsync(GUARD_READ_MS); });
      expect(within(question()!).getByText("Save changes to 'Hyde Park' first?")).toBeTruthy();
      await act(async () => { fireEvent.click(within(question()!).getByRole("button", { name: "Cancel" })); });
    } finally {
      vi.useRealTimers();
    }
  });

  it("Open re-reads the statuses at once", async () => {
    resetApp({ project, dirty: false });
    vi.spyOn(api, "open").mockResolvedValue(project);
    const targets = vi.spyOn(api, "targets").mockResolvedValue({ documents: [] } as never);
    await act(async () => { await projectActions.openRecent("C:/maps/Parkland.afgeo"); });
    expect(targets).toHaveBeenCalled();
  });
});

describe("the window close guard", () => {
  it("asks about unsaved changes before closing", async () => {
    vi.spyOn(api, "save");
    const confirmClose = vi.spyOn(platform, "confirmClose").mockImplementation(() => {});
    render(<ConfirmHost />);
    act(() => { handleCloseRequest(); });
    await flush();
    await click("Cancel");
    expect(confirmClose).not.toHaveBeenCalled();

    act(() => { handleCloseRequest(); });
    await flush();
    await click("Don't save");
    expect(confirmClose).toHaveBeenCalledTimes(1);
  });

  it("a failed save doesn't close, and the next close asks again", async () => {
    vi.spyOn(api, "save").mockRejectedValue(new ApiFail(500, "Disk full."));
    const confirmClose = vi.spyOn(platform, "confirmClose").mockImplementation(() => {});
    render(<ConfirmHost />);
    act(() => { handleCloseRequest(); });
    await flush();
    await click("Save");
    expect(confirmClose).not.toHaveBeenCalled();
    act(() => { handleCloseRequest(); });
    await flush();
    expect(question()).not.toBeNull();
    await click("Cancel");
  });

  it("Save, then cancelling the Save As dialog, doesn't close", async () => {
    vi.spyOn(api, "save").mockRejectedValue(needsPath());
    const saveAs = vi.spyOn(platform, "saveProjectAs").mockResolvedValue(null);
    const confirmClose = vi.spyOn(platform, "confirmClose").mockImplementation(() => {});
    render(<ConfirmHost />);
    act(() => { void handleCloseRequest(); });
    await flush();
    await click("Save");
    expect(saveAs).toHaveBeenCalledWith("Hyde Park.afgeo");
    expect(confirmClose).not.toHaveBeenCalled();
  });

  it("closes without asking when everything is saved", async () => {
    resetApp({ project, dirty: false });
    const confirmClose = vi.spyOn(platform, "confirmClose").mockImplementation(() => {});
    render(<ConfirmHost />);
    act(() => { handleCloseRequest(); });
    await flush();
    expect(question()).toBeNull();
    expect(confirmClose).toHaveBeenCalledTimes(1);
  });
});

describe("the top bar's project buttons", () => {
  it("Open…'s arrow lists the recent projects, and Save As… is there", async () => {
    vi.spyOn(platform, "recent").mockResolvedValue(["C:/maps/Parkland.afgeo", "D:\\work\\Town centre.afgeo"]);
    const onOpenRecent = vi.fn();
    const onSaveAs = vi.fn();
    render(<TopBar onNew={() => {}} onOpen={() => {}} onSave={() => {}} onSaveAs={onSaveAs} onOpenRecent={onOpenRecent} />);
    const labels = screen.getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent);
    expect(labels[0]).toBe("Guide to the Maps screen");
    expect(labels.slice(1, 6)).toEqual(["New", "Open…", "Open Recent", "Save project", "Save As…"]);
    fireEvent.click(screen.getByRole("button", { name: "Save As…" }));
    expect(onSaveAs).toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Open Recent" })); });
    const menu = screen.getByRole("menu", { name: "Open Recent" });
    const items = within(menu).getAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual(["Parkland.afgeo", "Town centre.afgeo"]);
    expect(items[1]!.getAttribute("title")).toBe("D:\\work\\Town centre.afgeo");
    fireEvent.click(items[1]!);
    expect(onOpenRecent).toHaveBeenCalledWith("D:\\work\\Town centre.afgeo");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("an empty recent list says so", async () => {
    vi.spyOn(platform, "recent").mockResolvedValue([]);
    render(<TopBar onOpen={() => {}} onOpenRecent={() => {}} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Open Recent" })); });
    expect(within(screen.getByRole("menu")).getByText("No recent projects")).toBeTruthy();
  });

  it("New and Open… in the app ask first when there are unsaved changes", async () => {
    const full = { ...project, area: { placeName: "Hyde Park", bboxWgs84: [-0.17, 51.50, -0.14, 51.52], projectionId: "bng" } } as unknown as Project;
    resetApp({ project: full, dirty: true });
    vi.spyOn(api, "project").mockResolvedValue({ project: full, dirty: true, counts: null });
    vi.spyOn(api, "affinity").mockResolvedValue({ connected: true, busy: false });
    vi.spyOn(api, "statuses").mockResolvedValue([]);
    vi.spyOn(api, "targets").mockResolvedValue({ documents: [] } as never);
    vi.spyOn(api, "areaPreview").mockImplementation(() => new Promise(() => {}));
    vi.spyOn(platform, "settings").mockResolvedValue({ appearance: "system", firstRunDone: true });
    const openDialog = vi.spyOn(platform, "openProject").mockResolvedValue(null);
    render(<App />);
    await flush();

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Open…" })); });
    await flush();
    expect(within(question()!).getByText("Save changes to 'Hyde Park' first?")).toBeTruthy();
    await click("Cancel");
    expect(openDialog).not.toHaveBeenCalled();

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Open…" })); });
    await flush();
    await click("Don't save");
    expect(openDialog).toHaveBeenCalledTimes(1);

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "New" })); });
    await flush();
    await click("Cancel");
    expect(screen.queryByRole("dialog")).toBeNull(); // the new-project dialog didn't open
  });
});
