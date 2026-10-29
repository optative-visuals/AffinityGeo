export function layerNameFromPath(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  const stem = base.replace(/\.[^.]*$/, "");
  const words = stem
    .replace(/^ne_\d+m_/i, "")
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1));
  return words.length ? words.join(" ") : "Layer";
}

const NAME_KEYS = ["name", "name_en", "admin", "title", "label"];

const NAME_LIKE = /(^|_)name$|nm$|nm\d{2}$|^name_/i;

/** dBASE text fields are often NUL-padded (Natural Earth): drop NULs and surrounding whitespace. */
export function cleanText(s: string): string {
  // eslint-disable-next-line no-control-regex -- stripping NUL characters is the point
  return s.replace(/\u0000/g, "").trim();
}

function textOf(v: unknown): string | null {
  if (typeof v === "string") {
    const t = cleanText(v);
    return t === "" ? null : t;
  }
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

export function featureName(attrs: Record<string, unknown>, fallback: string): string {
  const lower = new Map<string, unknown>();
  for (const [k, v] of Object.entries(attrs)) {
    const key = k.toLowerCase();
    if (!lower.has(key) || textOf(lower.get(key)) === null) lower.set(key, v);
  }
  for (const key of NAME_KEYS) {
    const t = textOf(lower.get(key));
    if (t !== null) return t;
  }
  // Heuristic for names like CTRY23NM, LAD23NM, RGN21NM, NAME_1: first matching string attribute, in attribute order.
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === "string" && NAME_LIKE.test(k)) {
      const t = textOf(v);
      if (t !== null) return t;
    }
  }
  return fallback;
}

const ID_KEYS = ["id", "fid", "objectid", "gid"];

const PREFERRED_CODE_KEYS = ["ne_id", "adm0_a3", "iso_a3"];
const CODE_LIKE = /cd$|cd\d{2}$|_code$|^code$/i;

/**
 * Pick a column whose values can serve as stable feature ids for the whole dataset:
 * NE_ID, ADM0_A3, ISO_A3 (in that order), then any code-like column (CTRY23CD, lad_code, CODE…).
 * A column qualifies only if every feature has a non-empty value, no value is "-99", and no two values repeat.
 */
export function pickIdColumn(rows: Array<Record<string, unknown> | null | undefined>): string | null {
  if (!rows.length) return null;
  const keys: string[] = [];
  for (const r of rows) for (const k of Object.keys(r ?? {})) if (!keys.includes(k)) keys.push(k);
  const qualifies = (key: string): boolean => {
    const seen = new Set<string>();
    for (const r of rows) {
      const t = textOf((r ?? {})[key]);
      if (t === null || t === "-99" || seen.has(t)) return false;
      seen.add(t);
    }
    return true;
  };
  for (const want of PREFERRED_CODE_KEYS) {
    const key = keys.find((k) => k.toLowerCase() === want);
    if (key && qualifies(key)) return key;
  }
  for (const key of keys) if (CODE_LIKE.test(key) && qualifies(key)) return key;
  return null;
}

export function featureId(
  feature: { id?: unknown; properties?: Record<string, unknown> | null },
  index: number,
  codeColumn?: string | null,
): string {
  const direct = textOf(feature.id);
  if (direct !== null) return direct;
  const props = feature.properties ?? {};
  const lower = new Map<string, unknown>();
  for (const [k, v] of Object.entries(props)) lower.set(k.toLowerCase(), v);
  for (const key of ID_KEYS) {
    const t = textOf(lower.get(key));
    if (t !== null) return t;
  }
  if (codeColumn) {
    const t = textOf(props[codeColumn]);
    if (t !== null) return t;
  }
  return "f" + index;
}
