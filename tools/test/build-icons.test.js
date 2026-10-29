import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { afterEach, describe, expect, it } from "vitest";
import { findExport, buildIco, encodeBmp24, resizeArea, buildBrandKit, ICO_SIZES } from "../build-icons.mjs";

const solid = (w, h, r, g, b, a = 255) => {
  const data = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([r, g, b, a], i * 4);
  return { width: w, height: h, data };
};
const png = (img) => PNG.sync.write(Object.assign(new PNG({ width: img.width, height: img.height }), { data: img.data }));

describe("buildIco", () => {
  it("writes a valid directory for 7 PNG entries", () => {
    const entries = ICO_SIZES.map((size) => ({ size, png: Buffer.alloc(10 + size, size % 251) }));
    const ico = buildIco(entries);
    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBe(7);
    let offset = 6 + 16 * 7;
    entries.forEach((e, i) => {
      const d = 6 + i * 16;
      const dim = e.size === 256 ? 0 : e.size;
      expect(ico[d]).toBe(dim);
      expect(ico[d + 1]).toBe(dim);
      expect(ico.readUInt16LE(d + 4)).toBe(1);
      expect(ico.readUInt16LE(d + 6)).toBe(32);
      expect(ico.readUInt32LE(d + 8)).toBe(e.png.length);
      expect(ico.readUInt32LE(d + 12)).toBe(offset);
      expect(ico.subarray(offset, offset + e.png.length).equals(e.png)).toBe(true);
      offset += e.png.length;
    });
    expect(ico.length).toBe(offset);
  });
});

describe("resizeArea", () => {
  it("averages a 4x4 down to 2x2, premultiplied by alpha", () => {
    const img = solid(4, 4, 0, 0, 0, 0);
    const set = (x, y, px) => img.data.set(px, (y * 4 + x) * 4);
    // top-left block: two opaque red, two fully transparent (green, must not leak)
    set(0, 0, [255, 0, 0, 255]); set(1, 0, [255, 0, 0, 255]);
    set(0, 1, [0, 255, 0, 0]); set(1, 1, [0, 255, 0, 0]);
    // top-right block: opaque 100 grey and 200 grey, all four
    for (const [x, y] of [[2, 0], [3, 0], [2, 1], [3, 1]]) set(x, y, [y === 0 ? 100 : 200, y === 0 ? 100 : 200, y === 0 ? 100 : 200, 255]);
    const out = resizeArea(img, 2, 2);
    expect(out.width).toBe(2);
    expect([...out.data.subarray(0, 4)]).toEqual([255, 0, 0, 128]);
    expect([...out.data.subarray(4, 8)]).toEqual([150, 150, 150, 255]);
    expect(out.data[11]).toBe(0); // bottom-left stays transparent
  });
});

describe("encodeBmp24", () => {
  it("writes a bottom-up 24 bpp BMP with padded rows, flattened onto white", () => {
    const bmp = encodeBmp24(solid(150, 57, 0, 0, 0, 0));
    const stride = 452;
    expect(bmp.toString("latin1", 0, 2)).toBe("BM");
    expect(bmp.readUInt32LE(2)).toBe(54 + stride * 57);
    expect(bmp.length).toBe(54 + stride * 57);
    expect(bmp.readUInt32LE(10)).toBe(54);
    expect(bmp.readUInt32LE(14)).toBe(40);
    expect(bmp.readInt32LE(18)).toBe(150);
    expect(bmp.readInt32LE(22)).toBe(57);
    expect(bmp.readUInt16LE(28)).toBe(24);
    expect(bmp.readUInt32LE(30)).toBe(0);
    expect(bmp[54]).toBe(255); // transparent -> white
    expect(bmp[54 + 450]).toBe(0); // padding
  });
  it("is bottom-up: the first stored row is the image's last row", () => {
    const img = solid(2, 2, 255, 255, 255);
    img.data.set([10, 20, 30, 255], 2 * 4); // (0,1) bottom-left
    const bmp = encodeBmp24(img);
    expect([...bmp.subarray(54, 57)]).toEqual([30, 20, 10]); // BGR
  });
});

describe("buildBrandKit", () => {
  const dirs = [];
  afterEach(() => { while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true }); });
  const tmp = () => { const d = mkdtempSync(path.join(tmpdir(), "brand-")); dirs.push(d); return d; };

  it("generates all 7 ico sizes from only the master and warns about the rest", () => {
    const root = tmp();
    const input = path.join(root, "export");
    mkdirSync(input);
    writeFileSync(path.join(input, "icon-1024.png"), png(solid(1024, 1024, 10, 120, 200)));
    const res = buildBrandKit({ inputDir: input, buildDir: path.join(root, "build"), docsDir: path.join(root, "docs") });
    const ico = readFileSync(path.join(root, "build", "icon.ico"));
    expect(ico.readUInt16LE(4)).toBe(7);
    expect(res.generated).toEqual(expect.arrayContaining(["icon-16", "icon-256"]));
    expect(res.warnings.join("\n")).toMatch(/installer-sidebar/);
    expect(res.warnings.join("\n")).toMatch(/social-preview/);
    expect(existsSync(path.join(root, "build", "icon.png"))).toBe(true);
    expect(existsSync(path.join(root, "build", "installerSidebar.bmp"))).toBe(false);
  });

  it("accepts a suffixed file name and writes bitmaps and docs images", () => {
    const root = tmp();
    const input = path.join(root, "export");
    mkdirSync(input);
    writeFileSync(path.join(input, "icon-1024.png"), png(solid(1024, 1024, 1, 2, 3)));
    writeFileSync(path.join(input, "icon-32@2x.png"), png(solid(32, 32, 255, 0, 0)));
    writeFileSync(path.join(input, "installer-sidebar.png"), png(solid(164, 314, 5, 5, 5)));
    writeFileSync(path.join(input, "installer-header.png"), png(solid(150, 57, 5, 5, 5)));
    writeFileSync(path.join(input, "social-preview.png"), png(solid(1280, 640, 5, 5, 5)));
    writeFileSync(path.join(input, "logo-topbar.svg"), "<svg/>");
    const res = buildBrandKit({ inputDir: input, buildDir: path.join(root, "build"), docsDir: path.join(root, "docs") });
    expect(res.handmade).toContain("icon-32");
    expect(readFileSync(path.join(root, "build", "installerSidebar.bmp")).readInt32LE(22)).toBe(314);
    expect(existsSync(path.join(root, "build", "installerHeader.bmp"))).toBe(true);
    expect(existsSync(path.join(root, "docs", "brand", "social-preview.png"))).toBe(true);
    expect(readFileSync(path.join(root, "docs", "brand", "logo-topbar.svg"), "utf8")).toBe("<svg/>");
  });

  it("fails clearly when the master is missing", () => {
    const root = tmp();
    mkdirSync(path.join(root, "export"));
    expect(() => buildBrandKit({ inputDir: path.join(root, "export"), buildDir: path.join(root, "b"), docsDir: path.join(root, "d") })).toThrow(/icon-1024\.png/);
  });
});

describe("findExport rules", () => {
  const dirs = [];
  afterEach(() => { while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true }); });
  const mk = (...files) => {
    const d = mkdtempSync(path.join(tmpdir(), "find-")); dirs.push(d);
    for (const f of files) writeFileSync(path.join(d, f), "x");
    return d;
  };
  it("matches case-insensitively", () => {
    const d = mk("Icon-32.PNG");
    expect(path.basename(findExport(d, "icon-32", "png"))).toBe("Icon-32.PNG");
  });
  it("prefers the exact name over suffixed names", () => {
    const d = mk("icon-32 copy.png", "icon-32.png", "icon-32@2x.png");
    expect(path.basename(findExport(d, "icon-32", "png"))).toBe("icon-32.png");
  });
  it("picks the shortest then alphabetical among suffixed names", () => {
    const d = mk("icon-32-b.png", "icon-32-a.png", "icon-32-long.png");
    expect(path.basename(findExport(d, "icon-32", "png"))).toBe("icon-32-a.png");
  });
  it("does not mistake a longer size for the name (icon-32 vs icon-320)", () => {
    const d = mk("icon-320.png");
    expect(findExport(d, "icon-32", "png")).toBeNull();
  });
  it("prefers a candidate whose pixel size matches the target", () => {
    const d = mk();
    writeFileSync(path.join(d, "icon-32-a.png"), png(solid(64, 64, 1, 1, 1)));
    writeFileSync(path.join(d, "icon-32-zz.png"), png(solid(32, 32, 1, 1, 1)));
    expect(path.basename(findExport(d, "icon-32", "png", 32))).toBe("icon-32-zz.png");
  });
});

describe("master size", () => {
  const dirs = [];
  afterEach(() => { while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true }); });
  const run = (size) => {
    const root = mkdtempSync(path.join(tmpdir(), "master-")); dirs.push(root);
    mkdirSync(path.join(root, "export"));
    writeFileSync(path.join(root, "export", "icon-1024.png"), png(solid(size, size, 9, 9, 9)));
    return () => buildBrandKit({ inputDir: path.join(root, "export"), buildDir: path.join(root, "b"), docsDir: path.join(root, "d") });
  };
  it("warns when smaller than 1024", () => {
    expect(run(512)().warnings.join("\n")).toMatch(/icon-1024.*512/);
  });
  it("fails clearly when smaller than 256", () => {
    expect(run(128)).toThrow(/at least 256/);
  });
});
