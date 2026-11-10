// How a tool call names a place in the window: an element (by role, text, label, test id or CSS selector)
// or a point in window pixels.
import type { Locator, Page } from "playwright-core";
import { z } from "zod";
import { ToolError } from "./tool.js";

const KINDS = ["role", "text", "label", "testId", "selector"] as const;
const BAD_TARGET = "Give one of role, text, label, testId or selector, or a point with x and y.";
/** How long to wait for a target to appear before saying it isn't there. */
export const FIND_TIMEOUT_MS = 5000;

export const targetSchema = z
  .object({
    role: z.string().optional().describe("ARIA role as shown by ui_snapshot, e.g. button, textbox, slider."),
    name: z.string().optional().describe("With role: the accessible name, e.g. the button's label."),
    text: z.string().optional().describe("Visible text."),
    label: z.string().optional().describe("A form field's label."),
    testId: z.string().optional().describe("A data-testid value."),
    selector: z.string().optional().describe("A CSS selector, for things with no role or text (e.g. canvas)."),
    nth: z.number().int().min(0).optional().describe("Which match to use when several match (0 is the first)."),
    exact: z.boolean().optional().describe("Match the name or text exactly instead of as a substring."),
    at: z
      .object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) })
      .optional()
      .describe("A spot inside the element, as fractions of its width and height (0.5, 0.5 is the centre)."),
    x: z.number().optional().describe("A point in window pixels (with y), instead of an element."),
    y: z.number().optional(),
  })
  .strict()
  .superRefine((t, ctx) => {
    const kinds = KINDS.filter((k) => t[k] !== undefined).length;
    const point = t.x !== undefined || t.y !== undefined;
    const ok = point
      ? t.x !== undefined && t.y !== undefined && kinds === 0 && t.name === undefined && t.nth === undefined && t.exact === undefined && t.at === undefined
      : kinds === 1 && (t.name === undefined || t.role !== undefined);
    if (!ok) ctx.addIssue({ code: "custom", message: BAD_TARGET });
  })
  .describe("An element (one of role / text / label / testId / selector) or a point { x, y } in window pixels.");

export type Target = z.infer<typeof targetSchema>;
export interface Point { x: number; y: number }

const isPoint = (t: Target): boolean => t.x !== undefined && t.y !== undefined;

/** A short name for the target, for error messages. */
export function describeTarget(t: Target): string {
  if (isPoint(t)) return `the point ${t.x}, ${t.y}`;
  if (t.role !== undefined) return t.name !== undefined ? `${t.role} "${t.name}"` : t.role;
  if (t.text !== undefined) return `the text "${t.text}"`;
  if (t.label !== undefined) return `the field labelled "${t.label}"`;
  if (t.testId !== undefined) return `the element with test id "${t.testId}"`;
  return `the selector ${t.selector}`;
}

/** Every element the target matches (`nth` not applied). Not for point targets. */
export function toLocator(page: Page, t: Target): Locator {
  const exact = t.exact ?? false;
  if (t.role !== undefined) {
    return page.getByRole(t.role as Parameters<Page["getByRole"]>[0], t.name !== undefined ? { name: t.name, exact } : {});
  }
  if (t.text !== undefined) return page.getByText(t.text, { exact });
  if (t.label !== undefined) return page.getByLabel(t.label, { exact });
  if (t.testId !== undefined) return page.getByTestId(t.testId);
  if (t.selector !== undefined) return page.locator(t.selector);
  throw new ToolError(BAD_TARGET);
}

/** The one element the target names. Waits a few seconds for it to appear; several matches need `nth`. */
export async function oneElement(page: Page, t: Target): Promise<Locator> {
  if (isPoint(t)) throw new ToolError("This needs an element, not a point.");
  const all = toLocator(page, t);
  try {
    await all.first().waitFor({ state: "attached", timeout: FIND_TIMEOUT_MS });
  } catch {
    throw new ToolError(`Nothing matches ${describeTarget(t)}. Use ui_snapshot to see what is on screen.`);
  }
  const count = await all.count();
  if (t.nth !== undefined) {
    if (t.nth >= count) throw new ToolError(`Only ${count} element${count === 1 ? "" : "s"} match ${describeTarget(t)}, so there is no nth ${t.nth}.`);
    return all.nth(t.nth);
  }
  if (count > 1) throw new ToolError(`${count} elements match ${describeTarget(t)}. Add nth (0 is the first), or be more specific.`);
  return all;
}

/** The window-pixel point a target stands for: the point itself, or the element's centre (or its `at` spot). */
export async function pointOf(page: Page, t: Target): Promise<Point> {
  if (isPoint(t)) return { x: t.x!, y: t.y! };
  const el = await oneElement(page, t);
  await el.scrollIntoViewIfNeeded({ timeout: FIND_TIMEOUT_MS }).catch(() => {});
  const box = await el.boundingBox();
  if (!box) throw new ToolError(`${describeTarget(t)} is not visible, so it has no position.`);
  const at = t.at ?? { x: 0.5, y: 0.5 };
  return { x: Math.round(box.x + box.width * at.x), y: Math.round(box.y + box.height * at.y) };
}
