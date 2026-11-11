import { describe, expect, it } from "vitest";
import zlib from "node:zlib";
import { crc32, readZip, writeZip } from "../../src/project/zip.js";

const enc = (s: string) => new TextEncoder().encode(s);

describe("zip", () => {
  it("round-trips stored and deflated entries", () => {
    const entries = [
      { name: "tiny.txt", data: enc("a") }, // too small to deflate: stored
      { name: "data/big.json", data: enc("hello world ".repeat(500)) }, // deflated
      { name: "empty.txt", data: new Uint8Array(0) },
    ];
    const zip = writeZip(entries);
    const back = readZip(zip);
    expect(back.map((e) => e.name)).toEqual(entries.map((e) => e.name));
    back.forEach((e, i) => expect(Array.from(e.data)).toEqual(Array.from(entries[i].data)));
  });

  it("rejects backslash and absolute entry names", () => {
    expect(() => writeZip([{ name: "a\\b", data: enc("x") }])).toThrow(/forward slashes/);
    expect(() => writeZip([{ name: "/a", data: enc("x") }])).toThrow(/relative/);
  });

  it("rejects non-zip data", () => {
    expect(() => readZip(enc("just some text, not a zip file at all"))).toThrow(/zip/i);
  });

  it("detects a corrupted entry", () => {
    const zip = writeZip([{ name: "a.txt", data: enc("hello") }]);
    zip[30 + "a.txt".length] ^= 0xff; // flip a byte of the stored body
    expect(() => readZip(zip)).toThrow(/Checksum/);
  });

  it("refuses zip64", () => {
    const zip = writeZip([{ name: "a.txt", data: enc("hello") }]);
    const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    const eocd = zip.length - 22;
    dv.setUint16(eocd + 10, 0xffff, true);
    expect(() => readZip(zip)).toThrow(/zip64/i);
  });
  it("throws a clear error for a truncated zip or one with wild offsets", () => {
    const zip = writeZip([{ name: "a.txt", data: enc("hello world ".repeat(50)) }]);
    expect(() => readZip(zip.slice(0, zip.length - 30))).toThrow(/zip/i);
    const badCd = zip.slice();
    new DataView(badCd.buffer).setUint32(badCd.length - 22 + 16, 0x7ffffff0, true); // central directory offset
    expect(() => readZip(badCd)).toThrow("Corrupt zip file.");
    const badLocal = zip.slice();
    const cd = new DataView(badLocal.buffer).getUint32(badLocal.length - 22 + 16, true);
    new DataView(badLocal.buffer).setUint32(cd + 42, 0x7ffffff0, true); // local header offset
    expect(() => readZip(badLocal)).toThrow("Corrupt zip file.");
    const badSize = zip.slice();
    new DataView(badSize.buffer).setUint32(cd + 20, 0x7ffffff0, true); // compressed size
    expect(() => readZip(badSize)).toThrow("Corrupt zip file.");
  });

  it("refuses a deflate entry that inflates past its declared size", () => {
    const real = enc("a".repeat(100000));
    const body = zlib.deflateRawSync(real);
    const name = enc("bomb.txt");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(body.length, 18); local.writeUInt32LE(10, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc32(real), 16); central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(10, 24); central.writeUInt16LE(name.length, 28);
    const cdOff = local.length + name.length + body.length;
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
    end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(cdOff, 16);
    const zip = new Uint8Array(Buffer.concat([local, name, body, central, name, end]));
    expect(() => readZip(zip)).toThrow("Corrupt zip file.");
  });
});
