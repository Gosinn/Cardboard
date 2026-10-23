/**
 * Location, taken out of photos and videos before they leave the device. Phones
 * write where a photo was taken (GPS) into the file itself, and most people
 * never know they're sending their home address along with it.
 *
 * Only the location goes: everything else (which way up the photo is, the
 * date, the camera) stays, and the picture or video itself isn't touched. JPEG,
 * PNG and WebP photos (EXIF GPS, and XMP), and MP4/MOV videos (Apple's and
 * Android's location tags). Big videos are never read whole: only the part
 * that holds the tags.
 */
import { crc32, join } from "./formats.ts";

const latin1 = (bytes: Uint8Array) => Array.from(bytes, (b) => String.fromCharCode(b)).join("");

/** A file, or anything that hands out its bytes by range like one (what's shared to the Android app). */
export interface Source {
  size: number;
  type?: string;
  name?: string;
  slice(start?: number, end?: number): { arrayBuffer(): Promise<ArrayBuffer> };
}

type Piece = Uint8Array | [start: number, end: number];

/** The file put back together from new bytes and ranges of the old one: a Blob for a Blob, otherwise the same kind of range reader. */
function assemble<T extends Source>(file: T, pieces: Piece[]): T {
  if (file instanceof Blob) {
    const blob: Blob = file;
    return new Blob(pieces.map((p) => (p instanceof Uint8Array ? p : blob.slice(p[0], p[1]))), { type: blob.type }) as unknown as T;
  }
  const sizes = pieces.map((p) => (p instanceof Uint8Array ? p.length : p[1] - p[0]));
  const size = sizes.reduce((a, b) => a + b, 0);
  const read = async (start: number, end: number) => {
    const out = new Uint8Array(Math.max(0, end - start));
    let at = 0;
    for (let i = 0; i < pieces.length && at < end; at += sizes[i]!, i++) {
      const [from, to] = [Math.max(start, at), Math.min(end, at + sizes[i]!)];
      if (from >= to) continue;
      const p = pieces[i]!;
      const bytes = p instanceof Uint8Array ? p.subarray(from - at, to - at) : new Uint8Array(await file.slice(p[0] + from - at, p[0] + to - at).arrayBuffer());
      out.set(bytes, from - start);
    }
    return out;
  };
  return { ...file, size, name: file.name, type: file.type, slice: (start = 0, end = size) => ({ arrayBuffer: async () => (await read(start, Math.min(end, size))).buffer as ArrayBuffer }) };
}

const bytesOf = async (file: Source, start: number, end: number) => new Uint8Array(await file.slice(start, end).arrayBuffer());

/** The same file without its location, and whether there was one. */
export async function withoutLocation<T extends Source>(file: T): Promise<{ blob: T; removed: boolean }> {
  const head = await bytesOf(file, 0, 16);
  const is = (...bytes: number[]) => bytes.every((b, i) => head[i] === b);
  try {
    if (is(0xff, 0xd8, 0xff)) return await jpeg(file);
    if (is(0x89, 0x50, 0x4e, 0x47)) return await png(file);
    if (is(0x52, 0x49, 0x46, 0x46) && latin1(head.subarray(8, 12)) === "WEBP") return await webp(file);
    if (latin1(head.subarray(4, 8)) === "ftyp") return await mp4(file);
  } catch {
    // A file this can't make sense of goes as it is, rather than not at all.
  }
  return { blob: file, removed: false };
}

// ── EXIF (TIFF) ──────────────────────────────────────────────────────────────

const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

/** Blanks the GPS part of TIFF/EXIF data (in place): its values, then the entries. Returns whether there was one. */
export function blankGps(tiff: Uint8Array): boolean {
  if (tiff.length < 8) return false;
  const little = tiff[0] === 0x49 && tiff[1] === 0x49;
  if (!little && !(tiff[0] === 0x4d && tiff[1] === 0x4d)) return false;
  const v = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const u16 = (at: number) => v.getUint16(at, little);
  const u32 = (at: number) => v.getUint32(at, little);
  const ifd0 = u32(4);
  if (ifd0 + 2 > tiff.length) return false;
  const count = u16(ifd0);
  for (let i = 0; i < count; i++) {
    const entry = ifd0 + 2 + i * 12;
    if (entry + 12 > tiff.length) return false;
    if (u16(entry) !== 0x8825) continue;
    const gps = u32(entry + 8);
    if (gps + 2 > tiff.length) return false;
    const n = u16(gps);
    let found = false;
    for (let j = 0; j < n; j++) {
      const e = gps + 2 + j * 12;
      if (e + 12 > tiff.length) break;
      const size = (TYPE_SIZE[u16(e + 2)] ?? 1) * u32(e + 4);
      if (size > 4) {
        const at = u32(e + 8);
        if (at + size <= tiff.length) tiff.fill(0, at, at + size);
      }
      // GPSVersionID (tag 0) on its own says nothing about where.
      if (u16(e) !== 0) found = true;
      tiff.fill(0, e, e + 12);
    }
    v.setUint16(gps, 0, little);
    return found;
  }
  return false;
}

/** XMP that says where (exif:GPSLatitude and the like). */
const xmpHasLocation = (text: string) => /GPS(Latitude|Longitude|Altitude|Position)|Iptc4xmpExt:LocationShown|photoshop:City/.test(text);

// ── JPEG ─────────────────────────────────────────────────────────────────────

async function jpeg<T extends Source>(file: T) {
  // The tags are near the start, before the picture itself (marked SOS).
  for (const size of [256 * 1024, 2 * 1024 * 1024]) {
    const bytes = await bytesOf(file, 0, size);
    const out: Uint8Array[] = [bytes.subarray(0, 2)];
    let at = 2;
    let removed = false;
    let complete = false;
    while (at + 4 <= bytes.length) {
      if (bytes[at] !== 0xff) break;
      const marker = bytes[at + 1]!;
      if (marker === 0xda || marker === 0xd9) {
        complete = true;
        break;
      }
      const length = (bytes[at + 2]! << 8) | bytes[at + 3]!;
      if (at + 2 + length > bytes.length) break;
      const segment = bytes.slice(at, at + 2 + length);
      const payload = segment.subarray(4);
      let keep = true;
      if (marker === 0xe1 && latin1(payload.subarray(0, 6)) === "Exif\0\0") removed = blankGps(payload.subarray(6)) || removed;
      else if (marker === 0xe1 && latin1(payload.subarray(0, 29)) === "http://ns.adobe.com/xap/1.0/\0" && xmpHasLocation(latin1(payload))) {
        keep = false;
        removed = true;
      }
      if (keep) out.push(segment);
      at += 2 + length;
    }
    if (!complete) continue;
    if (!removed) return { blob: file, removed: false };
    return { blob: assemble(file, [join(out), [at, file.size]]), removed: true };
  }
  return { blob: file, removed: false };
}

// ── PNG ──────────────────────────────────────────────────────────────────────

async function png<T extends Source>(file: T) {
  // Small enough to read: PNGs are pictures, not films.
  const bytes = await bytesOf(file, 0, file.size);
  const v = new DataView(bytes.buffer);
  const out: Uint8Array[] = [bytes.subarray(0, 8)];
  let removed = false;
  for (let at = 8; at + 12 <= bytes.length; ) {
    const length = v.getUint32(at);
    const type = latin1(bytes.subarray(at + 4, at + 8));
    const chunk = bytes.slice(at, at + 12 + length);
    const data = chunk.subarray(8, 8 + length);
    let keep = true;
    if (type === "eXIf" && blankGps(data)) {
      new DataView(chunk.buffer).setUint32(8 + length, crc32(chunk.subarray(4, 8 + length)));
      removed = true;
    } else if ((type === "iTXt" || type === "tEXt") && latin1(data.subarray(0, 17)) === "XML:com.adobe.xmp" && xmpHasLocation(latin1(data))) {
      keep = false;
      removed = true;
    }
    if (keep) out.push(chunk);
    at += 12 + length;
    if (type === "IEND") break;
  }
  return removed ? { blob: assemble(file, [join(out)]), removed } : { blob: file, removed };
}

// ── WebP ─────────────────────────────────────────────────────────────────────

async function webp<T extends Source>(file: T) {
  const bytes = await bytesOf(file, 0, file.size);
  const v = new DataView(bytes.buffer);
  let removed = false;
  for (let at = 12; at + 8 <= bytes.length; ) {
    const type = latin1(bytes.subarray(at, at + 4));
    const length = v.getUint32(at + 4, true);
    const data = bytes.subarray(at + 8, at + 8 + length);
    if (type === "EXIF") removed = blankGps(latin1(data.subarray(0, 6)) === "Exif\0\0" ? data.subarray(6) : data) || removed;
    if (type === "XMP " && xmpHasLocation(latin1(data))) {
      // Blanked rather than cut out, so every size in the file stays right.
      data.fill(0x20);
      removed = true;
    }
    at += 8 + length + (length % 2);
  }
  return removed ? { blob: assemble(file, [bytes]), removed } : { blob: file, removed };
}

// ── MP4 and MOV ──────────────────────────────────────────────────────────────

/** Where a video was filmed, as Apple and others write it: "+64.1466-021.9426+012.000/". */
const ISO6709 = /[+-]\d{1,3}\.\d+[+-]\d{1,3}\.\d+(?:[+-]\d+(?:\.\d+)?)?(?:CRS[^/]{0,40})?\//g;

async function mp4<T extends Source>(file: T) {
  // Find the moov box (the one with the tags) without reading the film itself.
  let at = 0;
  while (at + 8 <= file.size) {
    const header = new DataView((await bytesOf(file, at, at + 16)).buffer);
    let size = header.getUint32(0);
    const type = latin1(new Uint8Array(header.buffer, 4, 4));
    let headerSize = 8;
    if (size === 1) {
      size = Number(header.getBigUint64(8));
      headerSize = 16;
    } else if (size === 0) size = file.size - at;
    if (size < headerSize) break;
    if (type === "moov") {
      if (size > 64 * 1024 * 1024) break;
      const moov = await bytesOf(file, at, at + size);
      if (!blankVideoLocation(moov)) return { blob: file, removed: false };
      return { blob: assemble(file, [[0, at], moov, [at + size, file.size]]), removed: true };
    }
    at += size;
  }
  return { blob: file, removed: false };
}

/** Blanks location tags in a video's moov box (in place): the place becomes 0,0, nothing moves. */
export function blankVideoLocation(moov: Uint8Array): boolean {
  let removed = false;
  const text = latin1(moov);
  // Apple's ©xyz, and the ISO 6709 strings in QuickTime metadata: every digit of the place becomes 0.
  for (const m of text.matchAll(ISO6709)) {
    const place = m[0].split("CRS")[0]!;
    if (!/[1-9-]/.test(place)) continue;
    // Signs too: a minus says which half of the world.
    for (let i = 0; i < place.length; i++) {
      if (place[i]! >= "1" && place[i]! <= "9") moov[m.index! + i] = 0x30;
      else if (place[i] === "-") moov[m.index! + i] = 0x2b;
    }
    removed = true;
  }
  // 3GPP's loci box (Android): name, then longitude, latitude and altitude as numbers.
  for (let i = text.indexOf("loci"); i >= 4; i = text.indexOf("loci", i + 4)) {
    const v = new DataView(moov.buffer, moov.byteOffset);
    const size = v.getUint32(i - 4);
    const end = i - 4 + size;
    if (size < 22 || end > moov.length) continue;
    let p = i + 4 + 4 + 2; // version and flags, language
    while (p < end && moov[p] !== 0) p++; // the place's name (kept: it may be empty, and isn't coordinates)
    p += 2; // its end, and the role
    if (p + 12 <= end && moov.subarray(p, p + 12).some((b) => b !== 0)) {
      moov.fill(0, p, p + 12);
      removed = true;
    }
  }
  return removed;
}
