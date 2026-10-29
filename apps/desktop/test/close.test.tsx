// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/ui/api.js";
import { handleCloseRequest } from "../src/ui/App.js";
import { platform } from "../src/ui/platform.js";
import { ConfirmHost } from "../src/ui/shell/Confirm.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("close guard", () => {
  it("repeated close attempts while asking show one dialog, not a stack", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {}))); // a write that never finishes
    void api.save();
    const confirmClose = vi.spyOn(platform, "confirmClose").mockImplementation(() => {});
    render(<ConfirmHost />);
    act(() => { handleCloseRequest(); handleCloseRequest(); handleCloseRequest(); });
    expect(screen.getAllByRole("alertdialog")).toHaveLength(1);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Cancel" })); });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(confirmClose).not.toHaveBeenCalled();

    // Once answered, a later close asks again.
    act(() => { handleCloseRequest(); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Close anyway" })); });
    expect(confirmClose).toHaveBeenCalledTimes(1);
  });

  it("tells main when the close was cancelled, and only then", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    void api.save();
    const confirmClose = vi.spyOn(platform, "confirmClose").mockImplementation(() => {});
    const cancelClose = vi.spyOn(platform, "cancelClose").mockImplementation(() => {});
    render(<ConfirmHost />);
    act(() => { handleCloseRequest(); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Cancel" })); });
    expect(cancelClose).toHaveBeenCalledTimes(1);

    act(() => { handleCloseRequest(); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Close anyway" })); });
    expect(confirmClose).toHaveBeenCalledTimes(1);
    expect(cancelClose).toHaveBeenCalledTimes(1);
  });
});
