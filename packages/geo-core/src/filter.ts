import type { GeoFeature } from "./types.js";

type Attrs = GeoFeature["attrs"];
type AttrValue = Attrs[string];

/** A problem with the filter text, in plain English. `position` is a 0-based index into the input. */
export class FilterError extends Error {
  readonly position: number;
  constructor(message: string, position: number) {
    super(message);
    this.name = "FilterError";
    this.position = position;
  }
}

type Op = "=" | "!=" | ">" | ">=" | "<" | "<=" | "contains" | "starts with";

type Token =
  | { kind: "word"; text: string; pos: number }
  | { kind: "number"; text: string; value: number; pos: number }
  | { kind: "string"; text: string; pos: number }
  | { kind: "sym"; text: string; pos: number }
  | { kind: "lparen" | "rparen"; text: string; pos: number }
  | { kind: "end"; text: ""; pos: number };

type Node =
  | { t: "cmp"; field: string; op: Op; value: string | number; raw: string }
  | { t: "and" | "or"; a: Node; b: Node }
  | { t: "not"; a: Node };

const NUMBER_RE = /^[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d+)?(?:[eE][-+]?\d+)?/;
const SYMBOL_OPS = ["!=", ">=", "<=", "=", ">", "<"];

/** Parse a number in the filter's accepted forms ("1,234,567", "1e6", "-3.5"), or null. */
function parseNumber(text: string): number | null {
  const s = text.trim();
  const m = NUMBER_RE.exec(s);
  if (!m || m[0].length !== s.length || !/\d/.test(s)) return null;
  const n = Number(s.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (/\s/.test(c)) {
      i++;
    } else if (c === "(" || c === ")") {
      tokens.push({ kind: c === "(" ? "lparen" : "rparen", text: c, pos: i });
      i++;
    } else if (c === "'" || c === '"') {
      let j = i + 1;
      let out = "";
      let closed = false;
      while (j < text.length) {
        const d = text[j]!;
        if (d === "\\" && j + 1 < text.length) {
          out += text[j + 1];
          j += 2;
        } else if (d === c) {
          closed = true;
          j++;
          break;
        } else {
          out += d;
          j++;
        }
      }
      if (!closed) throw new FilterError("Missing a closing quote", i);
      tokens.push({ kind: "string", text: out, pos: i });
      i = j;
    } else {
      const rest = text.slice(i);
      const nm = /^[-+]?[\d.]/.test(rest) ? NUMBER_RE.exec(rest) : null;
      if (nm && parseNumber(nm[0]) !== null) {
        tokens.push({ kind: "number", text: nm[0], value: parseNumber(nm[0])!, pos: i });
        i += nm[0].length;
        continue;
      }
      const wm = /^[\p{L}_][\p{L}\p{N}_.-]*/u.exec(rest);
      if (wm) {
        tokens.push({ kind: "word", text: wm[0], pos: i });
        i += wm[0].length;
        continue;
      }
      const op = SYMBOL_OPS.find((o) => rest.startsWith(o));
      const sym = op ?? c;
      tokens.push({ kind: "sym", text: sym, pos: i });
      i += sym.length;
    }
  }
  tokens.push({ kind: "end", text: "", pos: text.length });
  return tokens;
}

class Parser {
  private i = 0;
  constructor(private readonly toks: Token[]) {}

  private get cur(): Token {
    return this.toks[this.i]!;
  }
  private isWord(t: Token, w: string): boolean {
    return t.kind === "word" && t.text.toLowerCase() === w;
  }
  private describe(t: Token): string {
    return t.kind === "string" ? `"${t.text}"` : t.text;
  }

  parse(): Node {
    const node = this.expr();
    const t = this.cur;
    if (t.kind !== "end") throw new FilterError(`Unexpected '${this.describe(t)}'`, t.pos);
    return node;
  }

  private expr(): Node {
    let left = this.andExpr("");
    while (this.isWord(this.cur, "or")) {
      this.i++;
      left = { t: "or", a: left, b: this.andExpr("or") };
    }
    return left;
  }

  private andExpr(after: string): Node {
    let left = this.term(after);
    while (this.isWord(this.cur, "and")) {
      this.i++;
      left = { t: "and", a: left, b: this.term("and") };
    }
    return left;
  }

  private term(after: string): Node {
    const t = this.cur;
    if (this.isWord(t, "not")) {
      this.i++;
      return { t: "not", a: this.term("not") };
    }
    if (t.kind === "lparen") {
      this.i++;
      const inner = this.expr();
      if (this.cur.kind !== "rparen") {
        if (this.cur.kind === "end") throw new FilterError("Missing a closing bracket", this.cur.pos);
        throw new FilterError(`Unexpected '${this.describe(this.cur)}'`, this.cur.pos);
      }
      this.i++;
      return inner;
    }
    return this.comparison(after);
  }

  private comparison(after: string): Node {
    const f = this.cur;
    if (f.kind === "end") {
      throw new FilterError(
        after ? `Expected a condition after '${after}'` : "Type a filter, for example: population > 1000000",
        f.pos,
      );
    }
    if (f.kind !== "word" && f.kind !== "string") {
      throw new FilterError(`Expected a field name but found '${this.describe(f)}'`, f.pos);
    }
    if (f.kind === "word" && ["and", "or", "contains", "starts"].includes(f.text.toLowerCase())) {
      throw new FilterError(`'${f.text}' is a keyword. Put the field name in quotes, for example "${f.text}"`, f.pos);
    }
    this.i++;
    const field = f.text;

    const o = this.cur;
    let op: Op;
    if (o.kind === "end") {
      throw new FilterError(`Expected an operator after '${field}', for example =, > or contains`, o.pos);
    }
    if (o.kind === "sym" && SYMBOL_OPS.includes(o.text)) {
      op = o.text as Op;
      this.i++;
    } else if (this.isWord(o, "contains")) {
      op = "contains";
      this.i++;
    } else if (this.isWord(o, "starts")) {
      this.i++;
      if (!this.isWord(this.cur, "with")) throw new FilterError("Expected 'with' after 'starts'", this.cur.pos);
      this.i++;
      op = "starts with";
    } else {
      throw new FilterError(`Unknown operator '${this.describe(o)}'`, o.pos);
    }

    const v = this.cur;
    if (v.kind === "end") throw new FilterError(`Expected a value after '${op}'`, v.pos);
    if (v.kind === "number") {
      this.i++;
      return { t: "cmp", field, op, value: v.value, raw: v.text };
    }
    if (v.kind === "string") {
      this.i++;
      return { t: "cmp", field, op, value: v.text, raw: v.text };
    }
    if (v.kind === "word") {
      throw new FilterError(`Put text values in quotes, for example '${v.text}'`, v.pos);
    }
    throw new FilterError(`Expected a value after '${op}' but found '${this.describe(v)}'`, v.pos);
  }
}

function lookup(attrs: Attrs, field: string): AttrValue | undefined {
  if (Object.prototype.hasOwnProperty.call(attrs, field)) return attrs[field];
  const want = field.toLowerCase();
  for (const k of Object.keys(attrs)) if (k.toLowerCase() === want) return attrs[k];
  return undefined;
}

function cmpNum(a: number, op: Op, b: number): boolean {
  switch (op) {
    case "=": return a === b;
    case "!=": return a !== b;
    case ">": return a > b;
    case ">=": return a >= b;
    case "<": return a < b;
    case "<=": return a <= b;
    default: return false;
  }
}

function cmpStr(a: string, op: Op, b: string): boolean {
  a = a.toLowerCase();
  b = b.toLowerCase();
  switch (op) {
    case "=": return a === b;
    case "!=": return a !== b;
    case "contains": return a.includes(b);
    case "starts with": return a.startsWith(b);
    case ">": return a > b;
    case ">=": return a >= b;
    case "<": return a < b;
    case "<=": return a <= b;
  }
}

function compare(attr: AttrValue | undefined, op: Op, value: string | number, raw: string): boolean {
  if (attr === null || attr === undefined) return false;
  const textOp = op === "contains" || op === "starts with";

  if (typeof attr === "boolean") {
    if (textOp) return cmpStr(String(attr), op, raw);
    const asNum = attr ? 1 : 0;
    if (typeof value === "number") return cmpNum(asNum, op, value);
    const v = value.trim().toLowerCase();
    if (v === "true" || v === "false") return cmpNum(asNum, op, v === "true" ? 1 : 0);
    return op === "!=";
  }

  if (typeof value === "number") {
    if (textOp) return cmpStr(String(attr), op, raw);
    const n = typeof attr === "number" ? attr : parseNumber(attr);
    if (n === null) return op === "!=";
    return cmpNum(n, op, value);
  }

  // The filter value is a string.
  if (typeof attr === "number") {
    if (op === "=" || op === "!=" || textOp) return cmpStr(String(attr), op, value);
    const vn = parseNumber(value);
    return vn === null ? false : cmpNum(attr, op, vn);
  }
  if (op === ">" || op === ">=" || op === "<" || op === "<=") {
    const an = parseNumber(attr);
    const vn = parseNumber(value);
    if (an !== null && vn !== null) return cmpNum(an, op, vn);
  }
  return cmpStr(attr, op, value);
}

function evaluate(node: Node, attrs: Attrs): boolean {
  switch (node.t) {
    case "cmp": return compare(lookup(attrs, node.field), node.op, node.value, node.raw);
    case "and": return evaluate(node.a, attrs) && evaluate(node.b, attrs);
    case "or": return evaluate(node.a, attrs) || evaluate(node.b, attrs);
    case "not": return !evaluate(node.a, attrs);
  }
}

/**
 * Compile a select-by-attribute filter such as `population > 1,000,000 and continent = 'Europe'`
 * into a predicate. Throws FilterError (plain-English message, 0-based position) on bad input.
 */
export function parseFilter(text: string): (attrs: GeoFeature["attrs"]) => boolean {
  if (text.trim() === "") throw new FilterError("Type a filter, for example: population > 1000000", 0);
  const ast = new Parser(tokenize(text)).parse();
  return (attrs) => evaluate(ast, attrs);
}
