import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import * as shapefile from "shapefile";
import { WGS84, crsFromPrj } from "../crs.js";
import type { CrsInfo, Dataset } from "../types.js";
import { buildDatasets, coordinateExtent, type RawFeature } from "./build.js";

/** Find a sibling file next to the .shp, trying lower- and upper-case extensions. */
function sibling(shpPath: string, ext: string): string | null {
  const stem = shpPath.replace(/\.[^.\\/]*$/, "");
  for (const e of [ext, ext.toUpperCase()]) if (existsSync(`${stem}.${e}`)) return `${stem}.${e}`;
  return null;
}

function encodingFromCpg(text: string | null): string {
  if (!text) return "utf-8";
  const t = text.trim().toLowerCase();
  if (/^\d+$/.test(t)) return t === "65001" ? "utf-8" : `windows-${t}`;
  if (t === "utf8") return "utf-8";
  try {
    new TextDecoder(t);
    return t;
  } catch {
    return "utf-8";
  }
}

export async function readShapefile(path: string): Promise<Dataset[]> {
  const file = path.split(/[\\/]/).pop() ?? path;
  if (!existsSync(path)) {
    throw new Error(`Couldn't open ${file}: the file wasn't found.`);
  }
  const dbfPath = sibling(path, "dbf");
  const prjPath = sibling(path, "prj");
  const cpgPath = sibling(path, "cpg");
  let encoding: string;
  let prjText: string;
  try {
    encoding = encodingFromCpg(cpgPath ? await readFile(cpgPath, "utf8") : null);
    prjText = prjPath ? (await readFile(prjPath, "utf8")).trim() : "";
  } catch {
    throw new Error(`Couldn't open the files that go with ${file}. Check that they exist and aren't open in another program.`);
  }
  const crsOf = (): CrsInfo => {
    try {
      return crsFromPrj(prjText);
    } catch {
      const prjName = (prjPath ?? path).split(/[\\/]/).pop();
      throw new Error(`AffinityGeo couldn't understand the coordinate system in ${prjName}.`);
    }
  };

  const raw: RawFeature[] = [];
  try {
    const shpSource = /\.shp$/.test(path) ? path : new Uint8Array(await readFile(path));
    const dbfSource = dbfPath ? new Uint8Array(await readFile(dbfPath)) : null;
    const src = await shapefile.open(shpSource, dbfSource, { encoding });
    for (;;) {
      const r = await src.read();
      if (r.done) break;
      raw.push(r.value);
    }
  } catch (e) {
    throw new Error(`Couldn't read ${file}: ${(e as Error).message}`);
  }

  if (prjText) return buildDatasets(raw, { path, format: "shapefile", crs: crsOf() });

  const { maxX, maxY } = coordinateExtent(raw);
  if (maxX > 180 || maxY > 90) {
    throw new Error(
      `This shapefile doesn't say which coordinate system it uses (no .prj file), and its coordinates aren't longitude/latitude. ` +
        `Add the .prj file that came with ${file} next to it and try again.`,
    );
  }
  return buildDatasets(raw, { path, format: "shapefile", crs: WGS84 });
}
