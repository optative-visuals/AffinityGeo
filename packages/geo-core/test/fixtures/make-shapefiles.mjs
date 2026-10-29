// Minimal writer for polygon shapefiles (shape type 5) + dBase III. No dependencies.
// Run: node make-shapefiles.mjs   (writes bng3/, noprj/, wgsnoprj/ next to this script)
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const BNG_PRJ =
  'PROJCS["British_National_Grid",GEOGCS["GCS_OSGB_1936",DATUM["D_OSGB_1936",SPHEROID["Airy_1830",6377563.396,299.3249646]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",400000.0],PARAMETER["False_Northing",-100000.0],PARAMETER["Central_Meridian",-2.0],PARAMETER["Scale_Factor",0.9996012717],PARAMETER["Latitude_Of_Origin",49.0],UNIT["Meter",1.0]]';

// Clockwise outer ring (shapefile convention), closed.
function square(x, y, w, h) {
  return [[x, y], [x, y + h], [x + w, y + h], [x + w, y], [x, y]];
}

function writeShp(polys) {
  const contents = polys.map((ring) => {
    const xs = ring.map((p) => p[0]);
    const ys = ring.map((p) => p[1]);
    const len = 44 + 4 + ring.length * 16;
    const b = Buffer.alloc(len);
    b.writeInt32LE(5, 0);
    b.writeDoubleLE(Math.min(...xs), 4);
    b.writeDoubleLE(Math.min(...ys), 12);
    b.writeDoubleLE(Math.max(...xs), 20);
    b.writeDoubleLE(Math.max(...ys), 28);
    b.writeInt32LE(1, 36);
    b.writeInt32LE(ring.length, 40);
    b.writeInt32LE(0, 44);
    ring.forEach((p, i) => {
      b.writeDoubleLE(p[0], 48 + i * 16);
      b.writeDoubleLE(p[1], 56 + i * 16);
    });
    return b;
  });
  const all = polys.flat();
  const bbox = [
    Math.min(...all.map((p) => p[0])), Math.min(...all.map((p) => p[1])),
    Math.max(...all.map((p) => p[0])), Math.max(...all.map((p) => p[1])),
  ];
  const header = (fileBytes) => {
    const h = Buffer.alloc(100);
    h.writeInt32BE(9994, 0);
    h.writeInt32BE(fileBytes / 2, 24);
    h.writeInt32LE(1000, 28);
    h.writeInt32LE(5, 32);
    bbox.forEach((v, i) => h.writeDoubleLE(v, 36 + i * 8));
    return h;
  };
  const recs = [];
  const idx = [];
  let offset = 100;
  contents.forEach((c, i) => {
    const rh = Buffer.alloc(8);
    rh.writeInt32BE(i + 1, 0);
    rh.writeInt32BE(c.length / 2, 4);
    recs.push(rh, c);
    const ih = Buffer.alloc(8);
    ih.writeInt32BE(offset / 2, 0);
    ih.writeInt32BE(c.length / 2, 4);
    idx.push(ih);
    offset += 8 + c.length;
  });
  return {
    shp: Buffer.concat([header(offset), ...recs]),
    shx: Buffer.concat([header(100 + idx.length * 8), ...idx]),
  };
}

// dBase III with NAME C(40), POP N(10,0)
function writeDbf(rows) {
  const fields = [["NAME", "C", 40], ["POP", "N", 10]];
  const recLen = 1 + fields.reduce((s, f) => s + f[2], 0);
  const headerLen = 32 + fields.length * 32 + 1;
  const h = Buffer.alloc(32);
  h[0] = 3;
  h[1] = 126; h[2] = 10; h[3] = 27;
  h.writeUInt32LE(rows.length, 4);
  h.writeUInt16LE(headerLen, 8);
  h.writeUInt16LE(recLen, 10);
  const descs = fields.map(([name, type, len]) => {
    const d = Buffer.alloc(32);
    d.write(name, 0, "ascii");
    d.write(type, 11, "ascii");
    d[16] = len;
    d[17] = 0;
    return d;
  });
  const recs = rows.map((r) => {
    const b = Buffer.alloc(recLen, 0x20);
    b.write(String(r.NAME).padEnd(40, " "), 1, "ascii");
    b.write(String(r.POP).padStart(10, " "), 41, "ascii");
    return b;
  });
  return Buffer.concat([h, ...descs, Buffer.from([0x0d]), ...recs, Buffer.from([0x1a])]);
}

function emit(dir, base, polys, rows, prj) {
  const out = join(here, dir);
  mkdirSync(out, { recursive: true });
  const { shp, shx } = writeShp(polys);
  writeFileSync(join(out, base + ".shp"), shp);
  writeFileSync(join(out, base + ".shx"), shx);
  writeFileSync(join(out, base + ".dbf"), writeDbf(rows));
  if (prj) writeFileSync(join(out, base + ".prj"), prj);
}

const rows = [
  { NAME: "Alpha", POP: 1200 },
  { NAME: "Bravo", POP: 3400 },
  { NAME: "Charlie", POP: 560 },
];
const bng = [
  square(500000, 200000, 1000, 1000),
  square(502000, 200000, 1500, 800),
  square(500000, 202000, 900, 1200),
];
const wgs = [
  square(-1.5, 51.0, 0.1, 0.1),
  square(-1.3, 51.0, 0.15, 0.08),
  square(-1.5, 51.2, 0.09, 0.12),
];

emit("bng3", "bng3", bng, rows, BNG_PRJ);
emit("noprj", "noprj", bng, rows, null);
emit("wgsnoprj", "wgsnoprj", wgs, rows, null);
