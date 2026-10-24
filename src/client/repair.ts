/**
 * Fixing broken files, on the device. Each check looks for one way files get
 * broken in real life (a download cut short, a file named wrong, text saved in
 * the wrong encoding, a recording stopped half way) and, when it finds it,
 * makes a fixed copy. The original is never changed.
 */
import { crc32, inflateRaw, join, makeZip, type ZipEntry } from "./formats.ts";

export interface Repaired {
  /** What was wrong and what was done, in plain words, one line each. */
  fixes: string[];
  /** What was looked at and is fine, or can't be fixed here. */
  notes: string[];
  /** The fixed copy, if anything was fixed. */
  data: Uint8Array | null;
  /** Its name (the right extension, if it had the wrong one). */
  name: string;
  type: string;
}

const latin1 = (b: Uint8Array) => Array.from(b, (c) => String.fromCharCode(c)).join("");

/** What some bytes really are, by how they start (and, for zips, what's inside). */
export function realKind(b: Uint8Array): { ext: string; type: string; words: string } | null {
  const at = (i: number, ...bytes: number[]) => bytes.every((x, j) => b[i + j] === x);
  const text = (i: number, s: string) => latin1(b.subarray(i, i + s.length)) === s;
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return { ext: "png", type: "image/png", words: "a PNG picture" };
  if (at(0, 0xff, 0xd8, 0xff)) return { ext: "jpg", type: "image/jpeg", words: "a JPEG picture" };
  if (text(0, "GIF8")) return { ext: "gif", type: "image/gif", words: "a GIF" };
  if (text(0, "RIFF") && text(8, "WEBP")) return { ext: "webp", type: "image/webp", words: "a WebP picture" };
  if (text(0, "RIFF") && text(8, "WAVE")) return { ext: "wav", type: "audio/wav", words: "a WAV sound" };
  if (text(0, "RIFF") && text(8, "AVI ")) return { ext: "avi", type: "video/x-msvideo", words: "an AVI video" };
  if (text(0, "BM") && b.length > 26 && new DataView(b.buffer, b.byteOffset).getUint32(2, true) <= b.length + 1024) return { ext: "bmp", type: "image/bmp", words: "a BMP picture" };
  if (at(0, 0x00, 0x00, 0x01, 0x00) && b[4]! > 0) return { ext: "ico", type: "image/x-icon", words: "an icon" };
  if (text(0, "II*\0") || text(0, "MM\0*")) return { ext: "tif", type: "image/tiff", words: "a TIFF picture" };
  if (text(0, "%PDF")) return { ext: "pdf", type: "application/pdf", words: "a PDF" };
  if (text(0, "OggS")) return { ext: "ogg", type: "audio/ogg", words: "an Ogg sound" };
  if (text(0, "fLaC")) return { ext: "flac", type: "audio/flac", words: "a FLAC sound" };
  if (text(0, "ID3") || (b[0] === 0xff && (b[1]! & 0xe0) === 0xe0 && (b[1]! & 0x06) !== 0)) return { ext: "mp3", type: "audio/mpeg", words: "an MP3 sound" };
  if (at(0, 0x1a, 0x45, 0xdf, 0xa3)) return latin1(b.subarray(0, 64)).includes("webm") ? { ext: "webm", type: "video/webm", words: "a WebM video" } : { ext: "mkv", type: "video/x-matroska", words: "an MKV video" };
  if (text(4, "ftyp")) {
    const brand = latin1(b.subarray(8, 12));
    if (/^(heic|heix|mif1|msf1|heim|heis)$/.test(brand)) return { ext: "heic", type: "image/heic", words: "an HEIC photo" };
    if (/^avi[fs]$/.test(brand)) return { ext: "avif", type: "image/avif", words: "an AVIF picture" };
    if (brand === "qt  ") return { ext: "mov", type: "video/quicktime", words: "a MOV video" };
    if (/^M4[AB] $/.test(brand)) return { ext: "m4a", type: "audio/mp4", words: "an M4A sound" };
    return { ext: "mp4", type: "video/mp4", words: "an MP4 video" };
  }
  if (at(0, 0x1f, 0x8b)) return { ext: "gz", type: "application/gzip", words: "a gzip file" };
  if (at(0, 0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c)) return { ext: "7z", type: "application/x-7z-compressed", words: "a 7-Zip file" };
  if (text(0, "Rar!")) return { ext: "rar", type: "application/vnd.rar", words: "a RAR file" };
  if (text(0, "PK\x03\x04") || text(0, "PK\x05\x06")) {
    const head = latin1(b.subarray(0, Math.min(b.length, 4096)));
    if (head.includes("word/")) return { ext: "docx", type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", words: "a Word document" };
    if (head.includes("xl/")) return { ext: "xlsx", type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", words: "an Excel workbook" };
    if (head.includes("ppt/")) return { ext: "pptx", type: "application/vnd.openxmlformats-officedocument.presentationml.presentation", words: "a PowerPoint" };
    if (head.includes("mimetypeapplication/epub+zip")) return { ext: "epub", type: "application/epub+zip", words: "an e-book" };
    if (head.includes("AndroidManifest.xml")) return { ext: "apk", type: "application/vnd.android.package-archive", words: "an Android app" };
    return { ext: "zip", type: "application/zip", words: "a zip" };
  }
  return null;
}

/** Extensions that name the same kind of file. */
const SAME: Record<string, string[]> = {
  jpg: ["jpg", "jpeg", "jpe", "jfif"],
  tif: ["tif", "tiff"],
  mp4: ["mp4", "m4v", "3gp", "mov"],
  mov: ["mov", "mp4"],
  m4a: ["m4a", "m4b", "mp4", "aac"],
  zip: ["zip", "apkm", "apks", "xapk", "jar", "cbz", "odt", "ods", "odp", "kmz", "aab"],
  apk: ["apk", "apks", "apkm", "xapk", "aab", "zip"],
  heic: ["heic", "heif"],
  mkv: ["mkv", "mka"],
  ogg: ["ogg", "oga", "opus", "ogv"],
  docx: ["docx", "docm", "dotx"],
  xlsx: ["xlsx", "xlsm"],
  html: ["html", "htm"],
};

const TEXT_EXT = /\.(txt|csv|tsv|md|markdown|json|html?|xml|srt|vtt|ini|cfg|conf|log|ya?ml|js|ts|css|svg)$/i;

/** Looks a file over and fixes what it can. */
export async function repairFile(name: string, data: Uint8Array): Promise<Repaired> {
  const fixes: string[] = [];
  const notes: string[] = [];
  let out = data;
  let kind = realKind(out);

  // Junk before the file itself (a picture or PDF saved with something in front of it).
  if (!kind) {
    for (const [sig, words] of [
      ["\xff\xd8\xff", "JPEG picture"],
      ["%PDF-", "PDF"],
      ["\x89PNG", "PNG picture"],
    ] as const) {
      const at = latin1(out.subarray(0, Math.min(out.length, 64 * 1024))).indexOf(sig);
      if (at > 0) {
        out = out.subarray(at);
        fixes.push(`There were ${at} bytes of something else before the ${words}: they're gone.`);
        kind = realKind(out);
        break;
      }
    }
  }

  // The right name: files saved or sent with the wrong extension (or none) open in the wrong app, or not at all.
  let fixedName = name;
  const ext = /\.([a-z0-9]{1,5})$/i.exec(name)?.[1]?.toLowerCase() ?? "";
  if (kind && ext !== kind.ext && !(SAME[kind.ext] ?? []).includes(ext) && !(kind.ext === "zip" && /^(docx|xlsx|pptx|epub|apk)$/.test(ext))) {
    fixedName = `${ext ? name.slice(0, -ext.length - 1) : name}.${kind.ext}`;
    fixes.push(ext ? `It's really ${kind.words}, but its name ended in .${ext}: it's named .${kind.ext} now, so it opens in the right app.` : `It had no extension: it's ${kind.words}, so it's named .${kind.ext} now.`);
  }

  const before = out;
  if (kind?.ext === "jpg") out = jpeg(out, fixes, notes);
  else if (kind?.ext === "png") out = png(out, fixes, notes);
  else if (kind?.ext === "gif") out = gif(out, fixes);
  else if (kind?.ext === "wav") out = wav(out, fixes);
  else if (kind?.ext === "pdf") out = pdf(out, fixes, notes);
  else if (kind && (kind.ext === "zip" || kind.ext === "docx" || kind.ext === "xlsx" || kind.ext === "pptx" || kind.ext === "epub")) out = await zip(out, fixes, notes);
  else if (kind?.ext === "apk") notes.push("It's an Android app: if it's damaged, it can't be fixed here (fixing it would break its signature). Download it again.");
  else if (kind && /^(mp4|mov|m4a)$/.test(kind.ext)) mp4(out, notes);
  else if (!kind && (TEXT_EXT.test(name) || looksLikeText(out))) out = text(name, out, fixes, notes);
  else if (!kind) notes.push("This doesn't know what kind of file it is, so it can't check it.");

  return { fixes, notes, data: fixes.length ? (out === before && before === data ? data.slice() : out) : null, name: fixes.length ? fixedName.replace(/(\.[^.]+)?$/, (e) => ` (fixed)${e}`) : name, type: kind?.type ?? (TEXT_EXT.test(fixedName) ? "text/plain" : "application/octet-stream") };
}

function looksLikeText(b: Uint8Array): boolean {
  const sample = b.subarray(0, 4096);
  return sample.length > 0 && !sample.includes(0);
}

// ── Pictures ─────────────────────────────────────────────────────────────────

function jpeg(b: Uint8Array, fixes: string[], notes: string[]): Uint8Array {
  if (b[b.length - 2] === 0xff && b[b.length - 1] === 0xd9) return b;
  // A picture cut off part way: closed, so it opens (the part that never arrived shows grey).
  let end = b.length;
  while (end > 2 && b[end - 1] === 0) end--;
  if (b.lastIndexOf(0xda) < 0) {
    notes.push("The picture's data never started: there's nothing to show.");
    return b;
  }
  fixes.push("The picture was cut off part way (a download or copy that stopped): it's closed off now, so it opens. What never arrived stays grey.");
  return join([b.subarray(0, end), Uint8Array.of(0xff, 0xd9)]);
}

function png(b: Uint8Array, fixes: string[], notes: string[]): Uint8Array {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out: Uint8Array[] = [b.subarray(0, 8)];
  let bad = 0;
  let ended = false;
  let at = 8;
  for (; at + 12 <= b.length; ) {
    const length = v.getUint32(at);
    const type = latin1(b.subarray(at + 4, at + 8));
    if (at + 12 + length > b.length || !/^[A-Za-z]{4}$/.test(type)) break;
    const chunk = b.slice(at, at + 12 + length);
    const crc = crc32(chunk.subarray(4, 8 + length));
    if (new DataView(chunk.buffer).getUint32(8 + length) !== crc) {
      new DataView(chunk.buffer).setUint32(8 + length, crc);
      bad++;
    }
    out.push(chunk);
    at += 12 + length;
    if (type === "IEND") {
      ended = true;
      break;
    }
  }
  if (bad) fixes.push(`${bad} part${bad === 1 ? "'s" : "s'"} checksum${bad === 1 ? " was" : "s were"} wrong (it was changed by something that didn't update them): put right, so picky apps open it.`);
  if (!ended) {
    const end = new Uint8Array(12);
    end.set([0x49, 0x45, 0x4e, 0x44], 4);
    new DataView(end.buffer).setUint32(8, crc32(end.subarray(4, 8)));
    out.push(end);
    fixes.push("The picture was cut off part way: the parts that arrived are kept and it's closed off, so it opens.");
  }
  if (!bad && ended) {
    notes.push("The picture checks out.");
    return b;
  }
  return join(out);
}

function gif(b: Uint8Array, fixes: string[]): Uint8Array {
  if (b[b.length - 1] === 0x3b) return b;
  fixes.push("The GIF was cut off at the end: it's closed off now, so it plays.");
  return join([b, Uint8Array.of(0x3b)]);
}

// ── Sound and video ──────────────────────────────────────────────────────────

/** A recording stopped before it was finished leaves its sizes at 0: everything that's there is counted again. */
function wav(b: Uint8Array, fixes: string[]): Uint8Array {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let at = 12;
  while (at + 8 <= b.length && latin1(b.subarray(at, at + 4)) !== "data") at += 8 + v.getUint32(at + 4, true) + (v.getUint32(at + 4, true) % 2);
  if (at + 8 > b.length) return b;
  const riffSize = b.length - 8;
  const dataSize = b.length - at - 8;
  if (v.getUint32(4, true) === riffSize && v.getUint32(at + 4, true) === dataSize) return b;
  const out = b.slice();
  const o = new DataView(out.buffer);
  o.setUint32(4, riffSize, true);
  o.setUint32(at + 4, dataSize, true);
  fixes.push("The recording's length was wrong (it was stopped before it was finished, or cut short): it's counted again, so all of it plays.");
  return out;
}

function mp4(b: Uint8Array, notes: string[]) {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let at = 0;
  let moov = false;
  while (at + 8 <= b.length) {
    let size = v.getUint32(at);
    if (latin1(b.subarray(at + 4, at + 8)) === "moov") moov = true;
    if (size === 1 && at + 16 <= b.length) size = Number(v.getBigUint64(at + 8));
    if (size < 8) break;
    at += size;
  }
  notes.push(moov ? "The video's index is there: it should play." : "The video's index is missing (a recording that was cut off before it was saved). That can't be rebuilt here: try a video repair app with another recording from the same phone.");
}

// ── PDF ──────────────────────────────────────────────────────────────────────

/** A PDF's table of where everything is: rebuilt when it points to the wrong places (an edited or cut-off PDF). */
function pdf(b: Uint8Array, fixes: string[], notes: string[]): Uint8Array {
  const s = latin1(b);
  const start = Number(/startxref\s+(\d+)\s+%%EOF\s*$/.exec(s.slice(-2048))?.[1] ?? -1);
  const pointsRight = start > 0 && start < s.length && (s.startsWith("xref", start) || /^\d+\s+\d+\s+obj/.test(s.slice(start, start + 40)));
  const objects = [...s.matchAll(/(?:^|[\r\n\s])(\d+)\s+(\d+)\s+obj\b/g)].map((m) => ({ n: Number(m[1]), gen: Number(m[2]), at: m.index! + m[0].length - m[0].trimStart().length }));
  let consistent = pointsRight;
  if (pointsRight && s.startsWith("xref", start)) {
    // A few of its entries, checked against where the objects really are.
    const table = /xref\s+(\d+)\s+(\d+)\s+([\s\S]*?)trailer/.exec(s.slice(start));
    const first = Number(table?.[1] ?? 0);
    const rows = [...(table?.[3] ?? "").matchAll(/(\d{10}) (\d{5}) ([nf])/g)].slice(0, 50);
    consistent = rows.every((r, i) => r[3] === "f" || s.slice(Number(r[1]), Number(r[1]) + 20).startsWith(`${first + i} `));
  }
  if (consistent) {
    notes.push("The PDF's table of contents checks out.");
    return b;
  }
  if (!objects.length) {
    notes.push("There's nothing readable in this PDF to rebuild it from.");
    return b;
  }
  const last = new Map<number, (typeof objects)[number]>();
  for (const o of objects) last.set(o.n, o);
  const root = /\/Root\s+(\d+\s+\d+\s+R)/.exec(s)?.[1] ?? (() => {
    const catalog = objects.find((o) => /\/Type\s*\/Catalog/.test(s.slice(o.at, o.at + 2000).split("endobj")[0]!));
    return catalog ? `${catalog.n} ${catalog.gen} R` : null;
  })();
  if (!root) {
    notes.push("The PDF's starting point is missing, so its pages can't be found.");
    return b;
  }
  const info = /\/Info\s+(\d+\s+\d+\s+R)/.exec(s)?.[1];
  const size = Math.max(...last.keys()) + 1;
  const body = s.replace(/\s*(xref[\s\S]*)?(trailer[\s\S]*)?startxref[\s\S]*$/, "").replace(/\s+$/, "");
  const end = body.length + 1;
  let table = `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let n = 1; n < size; n++) {
    const o = last.get(n);
    table += o && o.at < body.length ? `${String(o.at).padStart(10, "0")} ${String(o.gen).padStart(5, "0")} n \n` : "0000000000 65535 f \n";
  }
  const tail = `\n${table}trailer\n<< /Size ${size} /Root ${root}${info ? ` /Info ${info}` : ""} >>\nstartxref\n${end}\n%%EOF\n`;
  fixes.push(start < 0 ? "The PDF was cut off at the end: its table of contents is rebuilt, so it opens." : "The PDF's table of contents pointed to the wrong places (an edited or damaged PDF): it's rebuilt from what's really in it.");
  return Uint8Array.from(body + tail, (c) => c.charCodeAt(0) & 0xff);
}

// ── Zips (and Word, Excel, PowerPoint, e-books, which are zips inside) ───────

async function zip(b: Uint8Array, fixes: string[], notes: string[]): Promise<Uint8Array> {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let end = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) {
    if (v.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  let directoryOk = false;
  if (end >= 0) {
    const count = v.getUint16(end + 10, true);
    let at = v.getUint32(end + 16, true);
    directoryOk = at < b.length;
    for (let n = 0; n < count && directoryOk; n++) {
      if (at + 46 > b.length || v.getUint32(at, true) !== 0x02014b50) directoryOk = false;
      else {
        const local = v.getUint32(at + 42, true);
        if (local + 4 > b.length || v.getUint32(local, true) !== 0x04034b50) directoryOk = false;
        at += 46 + v.getUint16(at + 28, true) + v.getUint16(at + 30, true) + v.getUint16(at + 32, true);
      }
    }
  }
  if (directoryOk) {
    notes.push("The zip's table of contents checks out.");
    return b;
  }
  // Every file that's whole, found by its own header: what a cut-off download or a damaged zip still holds.
  const kept: ZipEntry[] = [];
  const lost: string[] = [];
  for (let at = 0; at + 30 <= b.length; ) {
    if (v.getUint32(at, true) !== 0x04034b50) {
      at++;
      continue;
    }
    const flags = v.getUint16(at + 6, true);
    const method = v.getUint16(at + 8, true);
    const crc = v.getUint32(at + 14, true);
    let packed = v.getUint32(at + 18, true);
    const nameLength = v.getUint16(at + 26, true);
    const extra = v.getUint16(at + 28, true);
    const name = new TextDecoder(flags & 0x800 ? "utf-8" : "latin1").decode(b.subarray(at + 30, at + 30 + nameLength));
    const start = at + 30 + nameLength + extra;
    if (flags & 0x08 || packed === 0xffffffff) {
      // Sizes come after the data: up to the next header.
      let next = start;
      while (next + 4 <= b.length && !(b[next] === 0x50 && b[next + 1] === 0x4b && [0x0403, 0x0201, 0x0807, 0x0605].includes(v.getUint16(next + 2, true)))) next++;
      packed = next - start;
    }
    const raw = b.subarray(start, start + packed);
    at = start + packed;
    if (name.endsWith("/")) continue;
    try {
      if (start + packed > b.length || flags & 1) throw new Error("cut off");
      const data = method === 0 ? raw.slice() : method === 8 ? await inflateRaw(raw) : null;
      if (!data || (!(flags & 0x08) && crc32(data) !== crc)) throw new Error("damaged");
      kept.push({ name, data });
    } catch {
      lost.push(name);
    }
  }
  if (!kept.length) {
    notes.push("Nothing in this zip could be saved.");
    return b;
  }
  fixes.push(
    `Its table of contents was ${end < 0 ? "missing (the file was cut off)" : "damaged"}: rebuilt from the ${kept.length} file${kept.length === 1 ? "" : "s"} that are whole.${lost.length ? ` ${lost.length} couldn't be saved: ${lost.slice(0, 5).join(", ")}${lost.length > 5 ? "…" : ""}.` : ""}`,
  );
  return makeZip(kept);
}

// ── Text ─────────────────────────────────────────────────────────────────────

/** Letters that show up when UTF-8 text is read as Windows-1252 (Ã©, â€™, Ã¾…). */
const MOJIBAKE = /[ÃÂâ][\u0080-¿‘-›€ŒœŠšŸŽžƒˆ˜]/g;
const CP1252 = new TextDecoder("windows-1252");

function text(name: string, b: Uint8Array, fixes: string[], notes: string[]): Uint8Array {
  let s: string;
  let changed = false;
  try {
    s = new TextDecoder("utf-8", { fatal: true }).decode(b);
  } catch {
    // Not UTF-8: saved by an older program (Windows-1252, which covers Western European letters).
    s = CP1252.decode(b);
    changed = true;
    fixes.push("The text was saved in an old encoding, so letters like é, ð or ö showed as �: it's UTF-8 now, which every app reads.");
  }
  const garbled = s.match(MOJIBAKE)?.length ?? 0;
  if (!changed && garbled >= 2) {
    // UTF-8 that was read as Windows-1252 and saved again: undone.
    const back = Uint8Array.from(s, (c) => {
      const code = c.charCodeAt(0);
      if (code < 256) return code;
      const i = [..."€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ"].indexOf(c);
      return i < 0 ? 0x3f : [0x80, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x8b, 0x8c, 0x8e, 0x91, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0x9b, 0x9c, 0x9e, 0x9f][i]!;
    });
    try {
      const undone = new TextDecoder("utf-8", { fatal: true }).decode(back);
      if ((undone.match(MOJIBAKE)?.length ?? 0) < garbled) {
        s = undone;
        changed = true;
        fixes.push(`The text had scrambled letters (like Ã© for é, ${garbled} of them): it was read in the wrong encoding and saved again. Put back.`);
      }
    } catch {
      // Not that, then.
    }
  }
  if (/\.json$/i.test(name)) {
    try {
      JSON.parse(s);
    } catch {
      // JSON as people write it: comments and trailing commas, which JSON doesn't allow.
      const loose = s
        .replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, str) => str ?? "")
        .replace(/("(?:[^"\\]|\\.)*")|,(\s*[}\]])/g, (m, str, close) => str ?? close);
      try {
        s = JSON.stringify(JSON.parse(loose), null, 2) + "\n";
        changed = true;
        fixes.push("The JSON had comments or commas before a closing bracket, which JSON doesn't allow: taken out, so it reads.");
      } catch (err) {
        notes.push(`The JSON is broken in a way this can't guess: ${(err as Error).message}.`);
      }
    }
  }
  if (!changed) {
    notes.push("The text reads fine.");
    return b;
  }
  return new TextEncoder().encode(s);
}
