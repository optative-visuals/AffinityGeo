import { describe, expect, it } from "vitest";
import { readZip, writeZip } from "../../src/project/zip.js";

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
});
