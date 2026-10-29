// Builds every icon and installer image AffinityGeo needs from the artboards exported out of the Affinity brand template.
// Run with: npm run icons   (reads assets/brand/export/, writes apps/desktop/build/ and docs/brand/)
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";

export const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

const pngSize = (file) => {
  try {
    const b = readFileSync(file);
    return b.length >= 24 ? [b.readUInt32BE(16), b.readUInt32BE(20)] : null;
  } catch { return null; }
};

/**
 * Finds the export for an artboard (names match case-insensitively; Affinity may add suffixes).
 * With `size`, a PNG whose pixels already equal size x size beats one that would need resizing.
 * Then an exact <name>.<ext> beats suffixed names; ties go to the shortest name, then alphabetical.
 */
export function findExport(dir, name, ext, size) {
  if (!existsSync(dir)) return null;
  const n = name.toLowerCase();
  const exact = `${n}.${ext}`;
  const candidates = readdirSync(dir).filter((f) => {
    const l = f.toLowerCase();
    return l.endsWith(`.${ext}`) && l.startsWith(n) && (l === exact || !/^\d/.test(l.slice(n.length)));
  });
  if (!candidates.length) return null;
  const key = (f) => {
    const sz = size ? pngSize(path.join(dir, f)) : null;
    const mismatch = size && !(sz && sz[0] === size && sz[1] === size) ? 1 : 0;
    return [mismatch, f.toLowerCase() === exact ? 0 : 1, f.length, f];
  };
  const cmp = (x, y) => {
    const kx = key(x), ky = key(y);
    for (let i = 0; i < 3; i++) if (kx[i] !== ky[i]) return kx[i] - ky[i];
    return kx[3] < ky[3] ? -1 : kx[3] > ky[3] ? 1 : 0;
  };
  return path.join(dir, candidates.sort(cmp)[0]);
}

export const decodePng = (buf) => {
  const p = PNG.sync.read(buf);
  return { width: p.width, height: p.height, data: p.data };
};
export const encodePng = (img) => PNG.sync.write(Object.assign(new PNG({ width: img.width, height: img.height }), { data: img.data }));

/** Area-averaging resample (box filter with fractional coverage) in premultiplied alpha. */
export function resizeArea(img, w, h) {
  const { width: sw, height: sh, data } = img;
  const out = Buffer.alloc(w * h * 4);
  const xr = sw / w;
  const yr = sh / h;
  for (let y = 0; y < h; y++) {
    const y0 = y * yr, y1 = y0 + yr;
    for (let x = 0; x < w; x++) {
      const x0 = x * xr, x1 = x0 + xr;
      let r = 0, g = 0, b = 0, a = 0, wsum = 0;
      for (let sy = Math.floor(y0); sy < Math.min(sh, Math.ceil(y1)); sy++) {
        const wy = Math.min(sy + 1, y1) - Math.max(sy, y0);
        for (let sx = Math.floor(x0); sx < Math.min(sw, Math.ceil(x1)); sx++) {
          const wt = wy * (Math.min(sx + 1, x1) - Math.max(sx, x0));
          const i = (sy * sw + sx) * 4;
          const al = data[i + 3] / 255;
          r += data[i] * al * wt; g += data[i + 1] * al * wt; b += data[i + 2] * al * wt; a += al * wt;
          wsum += wt;
        }
      }
      const o = (y * w + x) * 4;
      if (a > 0) {
        out[o] = Math.round(r / a); out[o + 1] = Math.round(g / a); out[o + 2] = Math.round(b / a);
      }
      out[o + 3] = Math.round((a / wsum) * 255);
    }
  }
  return { width: w, height: h, data: out };
}

/** ICO container with PNG-compressed entries (fine for every size on modern Windows). */
export function buildIco(entries) {
  const head = Buffer.alloc(6 + 16 * entries.length);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(entries.length, 4);
  let offset = head.length;
  entries.forEach((e, i) => {
    const d = 6 + i * 16;
    const dim = e.size >= 256 ? 0 : e.size;
    head[d] = dim; head[d + 1] = dim;
    head.writeUInt16LE(1, d + 4); // planes
    head.writeUInt16LE(32, d + 6); // bits per pixel
    head.writeUInt32LE(e.png.length, d + 8);
    head.writeUInt32LE(offset, d + 12);
    offset += e.png.length;
  });
  return Buffer.concat([head, ...entries.map((e) => e.png)]);
}

/** 24-bit, bottom-up, uncompressed BMP, flattened onto white (NSIS wants no alpha). */
export function encodeBmp24(img) {
  const { width: w, height: h, data } = img;
  const stride = (w * 3 + 3) & ~3;
  const buf = Buffer.alloc(54 + stride * h);
  buf.write("BM", 0, "latin1");
  buf.writeUInt32LE(buf.length, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(w, 18);
  buf.writeInt32LE(h, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  buf.writeUInt32LE(stride * h, 34);
  buf.writeInt32LE(2835, 38);
  buf.writeInt32LE(2835, 42);
  for (let y = 0; y < h; y++) {
    const row = 54 + (h - 1 - y) * stride;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const a = data[i + 3] / 255;
      for (let c = 0; c < 3; c++) buf[row + x * 3 + c] = Math.round(data[i + 2 - c] * a + 255 * (1 - a));
    }
  }
  return buf;
}

const wrongSize = (img, w, h) => img.width !== w || img.height !== h;

export function buildBrandKit({ inputDir, buildDir, docsDir, log = () => {} }) {
  const generated = [], handmade = [], warnings = [];
  const masterPath = findExport(inputDir, "icon-1024", "png");
  if (!masterPath) {
    throw new Error(`icon-1024.png not found in ${inputDir}. Export the icon-1024 artboard from the Affinity template as PNG into that folder first.`);
  }
  const masterBuf = readFileSync(masterPath);
  const master = decodePng(masterBuf);
  if (master.width !== master.height) throw new Error(`icon-1024 must be square, but ${path.basename(masterPath)} is ${master.width}x${master.height}.`);
  if (master.width < 256) throw new Error(`icon-1024 is only ${master.width}x${master.height}; it must be at least 256x256 (ideally 1024x1024). Re-export the icon-1024 artboard.`);
  if (master.width < 1024) warnings.push(`icon-1024 is ${master.width}x${master.height}, smaller than 1024x1024: icons may look soft.`);

  const entries = ICO_SIZES.map((size) => {
    const file = findExport(inputDir, `icon-${size}`, "png", size);
    if (!file) {
      generated.push(`icon-${size}`);
      return { size, png: encodePng(resizeArea(master, size, size)) };
    }
    handmade.push(`icon-${size}`);
    let img = decodePng(readFileSync(file));
    if (wrongSize(img, size, size)) {
      warnings.push(`${path.basename(file)} is ${img.width}x${img.height}, not ${size}x${size}: resized.`);
      img = resizeArea(img, size, size);
    }
    return { size, png: encodePng(img) };
  });
  if (generated.length) {
    warnings.push(`Not exported, generated by downscaling icon-1024: ${generated.join(", ")}. Hand-tune the small sizes (32, 24, 16) for crisper results.`);
  }

  mkdirSync(buildDir, { recursive: true });
  writeFileSync(path.join(buildDir, "icon.ico"), buildIco(entries));
  writeFileSync(path.join(buildDir, "icon.png"), masterBuf);
  log(`icon.ico (${ICO_SIZES.join(", ")}) and icon.png written to ${buildDir}`);

  for (const [name, w, h, out] of [["installer-sidebar", 164, 314, "installerSidebar.bmp"], ["installer-header", 150, 57, "installerHeader.bmp"]]) {
    const file = findExport(inputDir, name, "png");
    if (!file) { warnings.push(`${name}.png not found: ${out} skipped (the installer keeps its default image).`); continue; }
    let img = decodePng(readFileSync(file));
    if (wrongSize(img, w, h)) {
      warnings.push(`${path.basename(file)} is ${img.width}x${img.height}, not ${w}x${h}: resized.`);
      img = resizeArea(img, w, h);
    }
    writeFileSync(path.join(buildDir, out), encodeBmp24(img));
    log(`${out} written`);
  }

  const brandDir = path.join(docsDir, "brand");
  const social = findExport(inputDir, "social-preview", "png");
  const logo = findExport(inputDir, "logo-topbar", "svg");
  if (!social) warnings.push("social-preview.png not found: docs/brand/social-preview.png skipped.");
  if (!logo) warnings.push("logo-topbar.svg not found: docs/brand/logo-topbar.svg skipped.");
  if (social || logo) mkdirSync(brandDir, { recursive: true });
  if (social) { copyFileSync(social, path.join(brandDir, "social-preview.png")); log("social-preview.png copied"); }
  if (logo) { copyFileSync(logo, path.join(brandDir, "logo-topbar.svg")); log("logo-topbar.svg copied"); }
  return { generated, handmade, warnings };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  try {
    const res = buildBrandKit({
      inputDir: path.join(root, "assets", "brand", "export"),
      buildDir: path.join(root, "apps", "desktop", "build"),
      docsDir: path.join(root, "docs"),
      log: (m) => console.log(m),
    });
    console.log(`Hand-made icon sizes: ${res.handmade.join(", ") || "none"}. Generated: ${res.generated.join(", ") || "none"}.`);
    for (const w of res.warnings) console.warn(`Warning: ${w}`);
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
}
