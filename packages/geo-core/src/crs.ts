import proj4 from "proj4";
import type { CrsInfo } from "./types.js";

const BNG_PROJ4 =
  "+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy " +
  "+towgs84=446.448,-125.157,542.06,0.15,0.247,0.842,-20.489 +units=m +no_defs";

const KNOWN: Record<number, CrsInfo> = {
  4326: { id: "EPSG:4326", proj4: "+proj=longlat +datum=WGS84 +no_defs", label: "WGS 84" },
  4258: { id: "EPSG:4258", proj4: "+proj=longlat +ellps=GRS80 +no_defs", label: "ETRS89" },
  3857: {
    id: "EPSG:3857",
    proj4:
      "+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +wktext +no_defs",
    label: "WGS 84 / Pseudo-Mercator",
  },
  27700: { id: "EPSG:27700", proj4: BNG_PROJ4, label: "OSGB 1936 / British National Grid" },
  29903: {
    id: "EPSG:29903",
    proj4:
      "+proj=tmerc +lat_0=53.5 +lon_0=-8 +k=1.000035 +x_0=200000 +y_0=250000 +ellps=mod_airy " +
      "+towgs84=482.5,-130.6,564.6,-1.042,-0.214,-0.631,8.15 +units=m +no_defs",
    label: "TM75 / Irish Grid",
  },
  8857: {
    id: "EPSG:8857",
    proj4: "+proj=eqearth +lon_0=0 +x_0=0 +y_0=0 +ellps=WGS84 +units=m +no_defs",
    label: "WGS 84 / Equal Earth Greenwich",
  },
};

export const WGS84: CrsInfo = KNOWN[4326];

export function crsFromEpsg(code: number): CrsInfo {
  const known = KNOWN[code];
  if (known) return known;
  const utm =
    code >= 32601 && code <= 32660 ? { zone: code - 32600, south: false } :
    code >= 32701 && code <= 32760 ? { zone: code - 32700, south: true } : null;
  if (utm) {
    return {
      id: `EPSG:${code}`,
      proj4: `+proj=utm +zone=${utm.zone}${utm.south ? " +south" : ""} +datum=WGS84 +units=m +no_defs`,
      label: `WGS 84 / UTM zone ${utm.zone}${utm.south ? "S" : "N"}`,
    };
  }
  throw new Error(
    `EPSG:${code} isn't a coordinate system AffinityGeo knows yet. Re-save the data as WGS 84 (EPSG:4326) or British National Grid (EPSG:27700) and try again.`,
  );
}

/** Lower-case, underscores to spaces, collapsed whitespace. */
function normaliseName(name: string): string {
  return name.toLowerCase().replace(/_/g, " ").replace(/\s+/g, " ").trim();
}

const NAME_TO_EPSG: Record<string, number> = {
  "british national grid": 27700,
  "osgb 1936 / british national grid": 27700,
  "osgb36 / british national grid": 27700,
  "osgb 1936 british national grid": 27700,
  "osgb36 british national grid": 27700,
  "gcs wgs 1984": 4326,
  "wgs 84": 4326,
  "wgs 1984": 4326,
  "wgs84": 4326,
  "gcs etrs 1989": 4258,
  "etrs89": 4258,
  "etrs 1989": 4258,
  "wgs 84 / pseudo-mercator": 3857,
  "wgs 84 / pseudo mercator": 3857,
  "wgs 84 pseudo mercator": 3857,
  "wgs 84 pseudo-mercator": 3857,
  "wgs 1984 web mercator auxiliary sphere": 3857,
  "wgs 84 / equal earth greenwich": 8857,
  "tm75 / irish grid": 29903,
  "tm75 irish grid": 29903,
};

function epsgFromName(name: string): number | null {
  const n = normaliseName(name);
  if (NAME_TO_EPSG[n] !== undefined) return NAME_TO_EPSG[n];
  const m = /^wgs (?:84|1984) (?:\/ )?utm zone (\d{1,2}) ?([ns])$/.exec(n);
  if (m) {
    const zone = Number(m[1]);
    if (zone >= 1 && zone <= 60) return (m[2] === "n" ? 32600 : 32700) + zone;
  }
  return null;
}

function hash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, "0");
}

/** Identify a CRS from the text of a .prj file (ESRI or OGC WKT). */
export function crsFromPrj(wkt: string): CrsInfo {
  const text = wkt.trim();
  const m = /^\s*(?:PROJCS|GEOGCS|PROJCRS|GEOGCRS|GEODCRS|BASEGEOGCRS)\s*\[\s*"([^"]*)"/i.exec(text);
  const name = m ? m[1] : null;
  if (name) {
    const code = epsgFromName(name);
    if (code !== null) return crsFromEpsg(code);
  }
  try {
    proj4(text);
  } catch {
    throw new Error("AffinityGeo couldn't understand the coordinate system definition it was given.");
  }
  return { id: `WKT:${hash(text)}`, proj4: text, label: name ?? "Custom coordinate system" };
}
