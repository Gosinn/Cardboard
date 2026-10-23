import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { blankGps, blankVideoLocation, withoutLocation } from "../src/client/privacy.ts";

const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const cat = (...parts: Uint8Array[]) => Uint8Array.from(parts.flatMap((p) => [...p]));

/** EXIF (little-endian TIFF) with an orientation, and a GPS IFD saying 64°N 21°W. */
function exif(): Uint8Array {
  const t = new Uint8Array(120);
  const v = new DataView(t.buffer);
  t.set(ascii("II"));
  v.setUint16(2, 42, true);
  v.setUint32(4, 8, true);
  v.setUint16(8, 2, true); // IFD0: two entries
  v.setUint16(10, 0x0112, true); // orientation
  v.setUint16(12, 3, true);
  v.setUint32(14, 1, true);
  v.setUint16(18, 6, true);
  v.setUint16(22, 0x8825, true); // GPS IFD at 40
  v.setUint16(24, 4, true);
  v.setUint32(26, 1, true);
  v.setUint32(30, 40, true);
  v.setUint16(40, 2, true); // GPS IFD: two entries
  v.setUint16(42, 1, true); // latitude ref "N"
  v.setUint16(44, 2, true);
  v.setUint32(46, 2, true);
  t.set(ascii("N\0"), 50);
  v.setUint16(54, 2, true); // latitude: rational at 80
  v.setUint16(56, 5, true);
  v.setUint32(58, 1, true);
  v.setUint32(62, 80, true);
  v.setUint32(80, 64, true);
  v.setUint32(84, 1, true);
  return t;
}

describe("taking the location out of photos and videos", () => {
  it("blanks EXIF GPS and keeps everything else", () => {
    const t = exif();
    assert.equal(blankGps(t), true);
    const v = new DataView(t.buffer);
    assert.equal(v.getUint16(18, true), 6, "the orientation stays");
    assert.equal(v.getUint16(40, true), 0, "the GPS IFD is empty");
    assert.equal(v.getUint32(80, true), 0, "and its numbers are gone");
    assert.equal(blankGps(t), false, "nothing left the second time");
  });

  it("takes it out of a JPEG, leaving the picture as it was", async () => {
    const app1 = cat(ascii("Exif\0\0"), exif());
    const picture = cat(Uint8Array.of(0xff, 0xda, 0, 4, 1, 2), ascii("the picture itself"), Uint8Array.of(0xff, 0xd9));
    const file = cat(Uint8Array.of(0xff, 0xd8, 0xff, 0xe1, (app1.length + 2) >> 8, (app1.length + 2) & 0xff), app1, picture);
    const { blob, removed } = await withoutLocation(new Blob([file], { type: "image/jpeg" }));
    assert.equal(removed, true);
    const out = new Uint8Array(await blob.arrayBuffer());
    assert.equal(out.length, file.length);
    assert.deepEqual(out.subarray(out.length - picture.length), picture);
    assert.equal(blob.type, "image/jpeg");
    const again = await withoutLocation(blob);
    assert.equal(again.removed, false);
  });

  it("zeroes where a video was filmed (Apple's ©xyz and Android's loci)", () => {
    const xyz = ascii("....\xa9xyz\0\x12\x15\xc7+64.1466-021.9426/");
    const loci = cat(Uint8Array.of(0, 0, 0, 33), ascii("loci"), new Uint8Array(4), Uint8Array.of(0x15, 0xc7), ascii("Home\0"), Uint8Array.of(0), Uint8Array.of(0, 0x15, 0, 0, 0, 0x40, 0, 0, 0, 0, 0, 0), new Uint8Array(1));
    const moov = cat(ascii("moov"), xyz, loci);
    assert.equal(blankVideoLocation(moov), true);
    const text = Array.from(moov, (b) => String.fromCharCode(b)).join("");
    assert.ok(text.includes("+00.0000+000.0000/"), text);
    assert.ok(text.includes("Home"), "a loci's place name stays");
    assert.ok(!moov.subarray(moov.length - 13, moov.length - 1).some((b) => b !== 0), "its coordinates don't");
    assert.equal(blankVideoLocation(moov), false);
  });

  it("leaves files it doesn't know alone", async () => {
    const blob = new Blob([ascii("just some text")]);
    const { blob: out, removed } = await withoutLocation(blob);
    assert.equal(removed, false);
    assert.equal(out, blob);
  });
});

describe("files read by range (shared to the Android app)", () => {
  it("comes back as a range reader with the location gone and the rest the same", async () => {
    const xyz = ascii("udta\xa9xyz\0\x12\x15\xc7+64.1466-021.9426/");
    const moov = cat(Uint8Array.of(0, 0, 0, 8 + xyz.length), ascii("moov"), xyz);
    const ftyp = cat(Uint8Array.of(0, 0, 0, 16), ascii("ftypisom"), new Uint8Array(4));
    const mdat = cat(Uint8Array.of(0, 0, 0, 20), ascii("mdat"), ascii("the film itself!"));
    const whole = cat(ftyp, moov, mdat);
    const reads: Array<[number, number]> = [];
    const source = {
      name: "clip.mp4",
      type: "video/mp4",
      size: whole.length,
      slice: (start = 0, end = whole.length) => ({ arrayBuffer: async () => (reads.push([start, end]), whole.slice(start, end).buffer) }),
    };
    const { blob, removed } = await withoutLocation(source);
    const mdatStart = ftyp.length + moov.length;
    assert.ok(!reads.some(([s, e]) => e > mdatStart + 16), "the film itself wasn't read to find the tags");
    assert.equal(removed, true);
    assert.ok(!(blob instanceof Blob));
    assert.equal(blob.size, whole.length);
    const out = new Uint8Array(await blob.slice(0, blob.size).arrayBuffer());
    assert.ok(Array.from(out, (b) => String.fromCharCode(b)).join("").includes("+00.0000+000.0000/"));
    assert.deepEqual(out.subarray(whole.length - mdat.length), mdat);
    assert.deepEqual(new Uint8Array(await blob.slice(3, 40).arrayBuffer()), out.subarray(3, 40), "any range reads right");
  });
});
