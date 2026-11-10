// Tools that read and use the AffinityGeo window the way a person does.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { describeTarget, FIND_TIMEOUT_MS, oneElement, pointOf, targetSchema, toLocator } from "../target.js";
import { defineTool, ToolError } from "../tool.js";

/** Playwright's errors are long call logs; the first line says what happened. */
function because(e: unknown): string {
  if (e instanceof Error) return e.message.split("\n")[0]!.replace(/^\w+(\.\w+)*: /, "");
  return String(e);
}

/** Runs a window action, turning Playwright failures into one plain sentence. */
async function act<T>(what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ToolError) throw e;
    throw new ToolError(`Couldn't ${what}: ${because(e)}`);
  }
}

export const uiSnapshot = defineTool({
  name: "ui_snapshot",
  description:
    "What is on screen, as an accessibility tree (roles, names, states). Cheaper and more exact than a screenshot for finding " +
    "buttons and fields: use the roles and names it shows as targets for the other ui_ tools. `within` limits it to one region.",
  input: { within: targetSchema.optional() },
  run: async (ctx, a) => {
    const page = ctx.driver.page();
    const root = a.within ? await oneElement(page, a.within) : page.locator("body");
    return { text: await act("read the window", () => root.ariaSnapshot({ timeout: FIND_TIMEOUT_MS })) };
  },
});

export const uiScreenshot = defineTool({
  name: "ui_screenshot",
  description:
    "A picture of the window, or of one element with `within`. Use it for things the snapshot can't describe: the map canvas, " +
    "layout, colours. `saveTo` (an absolute path ending .png) also keeps the file.",
  input: { within: targetSchema.optional(), saveTo: z.string().optional() },
  run: async (ctx, a) => {
    const page = ctx.driver.page();
    if (a.saveTo !== undefined && (!path.isAbsolute(a.saveTo) || !a.saveTo.toLowerCase().endsWith(".png"))) {
      throw new ToolError("saveTo must be an absolute path ending in .png.");
    }
    const image = await act("take the screenshot", async () =>
      a.within ? (await oneElement(page, a.within)).screenshot({ timeout: FIND_TIMEOUT_MS }) : page.screenshot());
    if (a.saveTo !== undefined) {
      try { writeFileSync(a.saveTo, image); }
      catch (e) { throw new ToolError(`Couldn't save the screenshot: ${because(e)}`); }
    }
    const size = page.viewportSize();
    return { text: a.saveTo ? `Saved to ${a.saveTo}.` : a.within ? `Screenshot of ${describeTarget(a.within)}.` : `Screenshot of the window${size ? ` (${size.width} × ${size.height} px)` : ""}.`, image };
  },
});

export const uiClick = defineTool({
  name: "ui_click",
  description:
    "Click an element or a point. An element is clicked the way a person would (it must be visible and enabled). " +
    "Give `at` to click a particular spot inside it, such as a place on the map canvas.",
  input: {
    target: targetSchema,
    double: z.boolean().default(false),
    button: z.enum(["left", "right"]).default("left"),
  },
  run: async (ctx, a) => {
    const page = ctx.driver.page();
    const t = a.target;
    const clickCount = a.double ? 2 : 1;
    if (t.x !== undefined || t.at !== undefined) {
      const p = await pointOf(page, t);
      await act(`click ${describeTarget(t)}`, () => page.mouse.click(p.x, p.y, { button: a.button, clickCount }));
      return { text: `Clicked at ${p.x}, ${p.y}.` };
    }
    const el = await oneElement(page, t);
    await act(`click ${describeTarget(t)}`, () => el.click({ button: a.button, clickCount, timeout: FIND_TIMEOUT_MS }));
    return { text: `Clicked ${describeTarget(t)}.` };
  },
});

export const uiType = defineTool({
  name: "ui_type",
  description: "Type into a field. By default the field is cleared first; `enter: true` presses Enter afterwards.",
  input: {
    target: targetSchema,
    text: z.string(),
    clear: z.boolean().default(true),
    enter: z.boolean().default(false),
  },
  run: async (ctx, a) => {
    const page = ctx.driver.page();
    if (a.target.x !== undefined) throw new ToolError("ui_type needs an element, not a point.");
    const el = await oneElement(page, a.target);
    await act(`type into ${describeTarget(a.target)}`, async () => {
      if (a.clear) await el.fill(a.text, { timeout: FIND_TIMEOUT_MS });
      else await el.pressSequentially(a.text, { timeout: FIND_TIMEOUT_MS });
      if (a.enter) await el.press("Enter", { timeout: FIND_TIMEOUT_MS });
    });
    return { text: `Typed into ${describeTarget(a.target)}.` };
  },
});

export const uiPress = defineTool({
  name: "ui_press",
  description: "Press a key or a chord in the window, e.g. Enter, Escape, Delete, Control+S, Control+Shift+Z.",
  input: { keys: z.string().min(1) },
  run: async (ctx, a) => {
    await act(`press ${a.keys}`, () => ctx.driver.page().keyboard.press(a.keys));
    return { text: `Pressed ${a.keys}.` };
  },
});

export const uiDrag = defineTool({
  name: "ui_drag",
  description:
    "Drag with the mouse held down, from one element or point to another: for map frames, shape corners and sliders. " +
    "The movement is made in `steps` small moves so the app sees a real drag.",
  input: {
    from: targetSchema,
    to: targetSchema,
    steps: z.number().int().min(1).max(100).default(12),
  },
  run: async (ctx, a) => {
    const page = ctx.driver.page();
    const from = await pointOf(page, a.from);
    const to = await pointOf(page, a.to);
    await act("drag", async () => {
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      try { await page.mouse.move(to.x, to.y, { steps: a.steps }); }
      finally { await page.mouse.up(); }
    });
    return { text: `Dragged from ${from.x}, ${from.y} to ${to.x}, ${to.y}.` };
  },
});

export const uiWaitFor = defineTool({
  name: "ui_wait_for",
  description:
    "Wait for something to finish: until `text` is visible, until the text in `gone` has disappeared, or until `target` is visible. " +
    "Give exactly one. Use it after actions that take time (fetching data, sending to Affinity).",
  input: {
    text: z.string().optional(),
    gone: z.string().optional(),
    target: targetSchema.optional(),
    timeoutMs: z.number().int().min(100).max(300_000).default(15_000),
  },
  run: async (ctx, a) => {
    const page = ctx.driver.page();
    if ([a.text, a.gone, a.target].filter((v) => v !== undefined).length !== 1) {
      throw new ToolError("Give exactly one of text, gone or target.");
    }
    const [what, wait] = a.text !== undefined
      ? [`"${a.text}" to appear`, () => page.getByText(a.text!).first().waitFor({ state: "visible", timeout: a.timeoutMs })] as const
      : a.gone !== undefined
        ? [`"${a.gone}" to disappear`, () => page.getByText(a.gone!).first().waitFor({ state: "hidden", timeout: a.timeoutMs })] as const
        : [`${describeTarget(a.target!)} to appear`, () => toLocator(page, a.target!).nth(a.target!.nth ?? 0).waitFor({ state: "visible", timeout: a.timeoutMs })] as const;
    const started = Date.now();
    try {
      await wait();
    } catch {
      if (!ctx.driver.running()) throw new ToolError("AffinityGeo closed while waiting.");
      throw new ToolError(`Still waiting after ${a.timeoutMs} ms for ${what}.`);
    }
    return { text: `Waited ${Date.now() - started} ms for ${what}.` };
  },
});
