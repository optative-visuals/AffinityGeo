import { describe, expect, it } from "vitest";
import { FilterError, parseFilter } from "../src/filter.js";

const f = (text: string, attrs: Record<string, string | number | boolean | null>) => parseFilter(text)(attrs);
const err = (text: string): FilterError => {
  try {
    parseFilter(text);
  } catch (e) {
    expect(e).toBeInstanceOf(FilterError);
    return e as FilterError;
  }
  throw new Error("expected FilterError");
};

describe("parseFilter", () => {
  it("compares numbers, case-insensitive field names, thousands separators", () => {
    expect(f("population > 1,000,000", { POPULATION: 1500000 })).toBe(true);
    expect(f("population > 1,000,000", { POPULATION: 500 })).toBe(false);
    expect(f("pop >= 1e7", { pop: 1e7 })).toBe(true);
  });
  it("handles and/or/not with precedence and brackets", () => {
    const a = { continent: "Europe", pop_est: 2e7 };
    expect(f("continent = 'europe' and pop_est >= 1e7", a)).toBe(true);
    expect(f("continent = 'asia' and pop_est >= 1e7 or pop_est > 1", a)).toBe(true);
    expect(f("CONTINENT = 'asia' AND (pop_est > 1 OR pop_est < 0)", a)).toBe(false);
    expect(f("not (name contains \"land\")", { name: "Iceland" })).toBe(false);
    expect(f("not name = 'x'", { name: "y" })).toBe(true);
  });
  it("supports contains / starts with, quoted field names", () => {
    expect(f("\"Name EN\" starts with 'S'", { "name en": "Spain" })).toBe(true);
    expect(f("name STARTS WITH 'p'", { name: "Spain" })).toBe(false);
    expect(f("name contains 'AIN'", { name: "Spain" })).toBe(true);
    expect(f("code contains '12'", { code: 4123 })).toBe(true);
    expect(f("code = '4123'", { code: 4123 })).toBe(true);
  });
  it("missing or null field is false", () => {
    expect(f("nope = 1", { a: 1 })).toBe(false);
    expect(f("nope != 1", { a: 1 })).toBe(false);
    expect(f("a > 1", { a: null })).toBe(false);
  });
  it("coerces numeric strings (KML)", () => {
    expect(f("n > 5", { n: "12" })).toBe(true);
    expect(f("n = 1234567", { n: " 1,234,567 " })).toBe(true);
    expect(f("n > 5", { n: "abc" })).toBe(false);
    expect(f("n = 5", { n: "abc" })).toBe(false);
    expect(f("n != 5", { n: "abc" })).toBe(true);
  });
  it("compares booleans", () => {
    expect(f("ok = 'TRUE'", { ok: true })).toBe(true);
    expect(f("ok = 1", { ok: true })).toBe(true);
    expect(f("ok = 0", { ok: true })).toBe(false);
    expect(f("ok = 'false'", { ok: false })).toBe(true);
    expect(f("ok != 'true'", { ok: false })).toBe(true);
  });
  it("string = and != are case-insensitive", () => {
    expect(f("name != 'SPAIN'", { name: "spain" })).toBe(false);
  });
  it("reports plain-English errors with positions", () => {
    expect(err("pop >").message).toBe("Expected a value after '>'");
    expect(err("population ~ 3").message).toBe("Unknown operator '~'");
    const empty = err("   ");
    expect(empty.message).toBe("Type a filter, for example: population > 1000000");
    expect(empty.position).toBe(0);
    const trail = err("a = 1 b");
    expect(trail.message).toBe("Unexpected 'b'");
    expect(trail.position).toBe(6);
    const paren = err("(a = 1");
    expect(paren.message).toBe("Missing a closing bracket");
    expect(paren.position).toBe(6);
    expect(err("a = 'x").message).toBe("Missing a closing quote");
    expect(err("and = 1").position).toBe(0);
  });
});
