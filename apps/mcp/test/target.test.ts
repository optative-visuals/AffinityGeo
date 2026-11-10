import { describe, expect, it } from "vitest";
import { describeTarget, targetSchema } from "../src/target.js";

describe("targets", () => {
  it("accepts each target form", () => {
    expect(targetSchema.safeParse({ x: 10, y: 20 }).success).toBe(true);
    expect(targetSchema.safeParse({ role: "button", name: "Send to Affinity", nth: 1 }).success).toBe(true);
    expect(targetSchema.safeParse({ text: "Maps", at: { x: 0.5, y: 0.1 } }).success).toBe(true);
    expect(targetSchema.safeParse({ label: "Name" }).success).toBe(true);
    expect(targetSchema.safeParse({ testId: "frame" }).success).toBe(true);
    expect(targetSchema.safeParse({ selector: "canvas", exact: true }).success).toBe(true);
  });
  it("rejects an empty target, a mix, and half a point", () => {
    expect(targetSchema.safeParse({}).success).toBe(false);
    expect(targetSchema.safeParse({ text: "a", x: 1, y: 2 }).success).toBe(false);
    expect(targetSchema.safeParse({ text: "a", label: "b" }).success).toBe(false);
    expect(targetSchema.safeParse({ x: 1 }).success).toBe(false);
    expect(targetSchema.safeParse({ name: "Send" }).success).toBe(false);
    expect(targetSchema.safeParse({ x: 1, y: 2, nth: 0 }).success).toBe(false);
  });
  it("keeps `at` inside the element", () => {
    expect(targetSchema.safeParse({ text: "a", at: { x: 1.5, y: 0 } }).success).toBe(false);
    expect(targetSchema.safeParse({ text: "a", at: { x: 0, y: 1 } }).success).toBe(true);
  });
  it("explains what is wrong", () => {
    const r = targetSchema.safeParse({});
    expect(r.success ? "" : r.error.issues[0]!.message).toBe("Give one of role, text, label, testId or selector, or a point with x and y.");
  });
  it("describes targets for error messages", () => {
    expect(describeTarget({ role: "button", name: "Send to Affinity" })).toBe('button "Send to Affinity"');
    expect(describeTarget({ role: "slider" })).toBe("slider");
    expect(describeTarget({ text: "Maps" })).toBe('the text "Maps"');
    expect(describeTarget({ label: "Name" })).toBe('the field labelled "Name"');
    expect(describeTarget({ testId: "frame" })).toBe('the element with test id "frame"');
    expect(describeTarget({ selector: "canvas" })).toBe("the selector canvas");
    expect(describeTarget({ x: 3, y: 4 })).toBe("the point 3, 4");
  });
});
