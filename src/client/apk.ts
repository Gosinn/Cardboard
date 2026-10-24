/**
 * Android app files, read on the device: a plain .apk, or an app bundle
 * (.apkm from APKMirror, .apks, .xapk), which is a zip of a base APK and the
 * split APKs that go with it (one per kind of phone: its processor, its screen,
 * its languages). Says what the app is (name, version, who signed it) and
 * which parts this phone needs, so the Android app can install just those.
 *
 * Files are read by range, never whole: a bundle can be gigabytes.
 */
import { fail } from "../shared/errors.ts";
import type { Source } from "./privacy.ts";

const latin1 = (bytes: Uint8Array) => Array.from(bytes, (b) => String.fromCharCode(b)).join("");
const bytesOf = async (src: Source, start: number, end: number) => new Uint8Array(await src.slice(start, end).arrayBuffer());
const notAnApp = (why: string) => fail("not_an_app", 422, `That isn't an Android app this can read: ${why}.`, "Use an .apk, .apkm, .apks or .xapk file, downloaded whole.");

// ── ZIP, by range ────────────────────────────────────────────────────────────

export interface ZipItem {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

/** The files in a zip (its central directory), without reading what's in them. ZIP64 too (bundles with big extras). */
export async function zipItems(src: Source): Promise<ZipItem[]> {
  const tailStart = Math.max(0, src.size - 65557);
  const tail = await bytesOf(src, tailStart, src.size);
  const tv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw notAnApp("it isn't a zip (or it's cut short)");
  let count = tv.getUint16(eocd + 10, true);
  let cdSize = tv.getUint32(eocd + 12, true);
  let cdOffset = tv.getUint32(eocd + 16, true);
  if (count === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) {
    // ZIP64: a locator just before the end record says where the bigger record is.
    const at = eocd - 20;
    if (at < 0 || tv.getUint32(at, true) !== 0x07064b50) throw notAnApp("its zip directory is damaged");
    const record = Number(tv.getBigUint64(at + 8, true));
    const z = new DataView((await bytesOf(src, record, record + 56)).buffer);
    if (z.getUint32(0, true) !== 0x06064b50) throw notAnApp("its zip directory is damaged");
    count = Number(z.getBigUint64(32, true));
    cdSize = Number(z.getBigUint64(40, true));
    cdOffset = Number(z.getBigUint64(48, true));
  }
  if (cdOffset + cdSize > src.size || cdSize > 64 * 1024 * 1024) throw notAnApp("its zip directory is damaged");
  const cd = await bytesOf(src, cdOffset, cdOffset + cdSize);
  const v = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
  const items: ZipItem[] = [];
  let p = 0;
  for (let n = 0; n < count && p + 46 <= cd.length; n++) {
    if (v.getUint32(p, true) !== 0x02014b50) throw notAnApp("its zip directory is damaged");
    const flags = v.getUint16(p + 8, true);
    const nameLength = v.getUint16(p + 28, true);
    const extraLength = v.getUint16(p + 30, true);
    const commentLength = v.getUint16(p + 32, true);
    let compressedSize = v.getUint32(p + 20, true);
    let size = v.getUint32(p + 24, true);
    let localOffset = v.getUint32(p + 42, true);
    const name = new TextDecoder(flags & 0x0800 ? "utf-8" : "latin1").decode(cd.subarray(p + 46, p + 46 + nameLength));
    // ZIP64 sizes and offset, in the order the fields that overflowed come.
    for (let e = p + 46 + nameLength; e + 4 <= p + 46 + nameLength + extraLength; ) {
      const id = v.getUint16(e, true);
      const len = v.getUint16(e + 2, true);
      if (id === 0x0001) {
        let q = e + 4;
        if (size === 0xffffffff) (size = Number(v.getBigUint64(q, true))), (q += 8);
        if (compressedSize === 0xffffffff) (compressedSize = Number(v.getBigUint64(q, true))), (q += 8);
        if (localOffset === 0xffffffff) localOffset = Number(v.getBigUint64(q, true));
      }
      e += 4 + len;
    }
    items.push({ name, method: v.getUint16(p + 10, true), compressedSize, size, localOffset });
    p += 46 + nameLength + extraLength + commentLength;
  }
  return items;
}

/** Where an item's (packed) bytes start: after its local header, whose name and extra lengths can differ from the directory's. */
async function dataStart(src: Source, item: ZipItem): Promise<number> {
  const local = new DataView((await bytesOf(src, item.localOffset, item.localOffset + 30)).buffer);
  if (local.getUint32(0, true) !== 0x04034b50) throw notAnApp(`${item.name} in it is damaged`);
  return item.localOffset + 30 + local.getUint16(26, true) + local.getUint16(28, true);
}

/** An item's bytes, unpacked, as a stream (stored ones are read a piece at a time; packed ones unpacked as they come). */
export async function itemStream(src: Source, item: ZipItem, piece = 1024 * 1024): Promise<ReadableStream<Uint8Array>> {
  if (item.method !== 0 && item.method !== 8) throw notAnApp(`${item.name} in it is packed in a way this can't open`);
  const start = await dataStart(src, item);
  const end = start + item.compressedSize;
  let at = start;
  const raw = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (at >= end) return controller.close();
      const next = Math.min(end, at + piece);
      controller.enqueue(await bytesOf(src, at, next));
      at = next;
    },
  });
  return item.method === 0 ? raw : raw.pipeThrough(new DecompressionStream("deflate-raw"));
}

/** An item's bytes, unpacked (at most `limit` of them). */
export async function itemBytes(src: Source, item: ZipItem, limit = 64 * 1024 * 1024): Promise<Uint8Array> {
  if (item.size > limit) throw notAnApp(`${item.name} in it is too big to look at here`);
  const reader = (await itemStream(src, item)).getReader();
  const out = new Uint8Array(item.size);
  let at = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (at + value.length > out.length) {
      await reader.cancel();
      throw notAnApp(`${item.name} in it is bigger than it says`);
    }
    out.set(value, at);
    at += value.length;
  }
  return out;
}

/** An item as a file of its own, read by range when it's stored (split APKs in bundles are), unpacked whole when it isn't. */
export async function itemSource(src: Source, item: ZipItem): Promise<Source> {
  if (item.method === 0) {
    const start = await dataStart(src, item);
    return { size: item.size, slice: (a = 0, b = item.size) => src.slice(start + a, start + Math.min(b, item.size)) };
  }
  return new Blob([await itemBytes(src, item, 512 * 1024 * 1024)]);
}

// ── Android's binary XML (AndroidManifest.xml) and resources (resources.arsc) ─

/** A string pool: decoded only when a string is asked for (an app's can hold 100,000). */
function stringPool(b: Uint8Array, at: number): (i: number) => string {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const headerSize = v.getUint16(at + 2, true);
  const count = v.getUint32(at + 8, true);
  const utf8 = (v.getUint32(at + 16, true) & 0x100) !== 0;
  const stringsStart = at + v.getUint32(at + 20, true);
  const cache = new Map<number, string>();
  return (i) => {
    if (i < 0 || i >= count) return "";
    const hit = cache.get(i);
    if (hit !== undefined) return hit;
    let p = stringsStart + v.getUint32(at + headerSize + i * 4, true);
    let s: string;
    if (utf8) {
      p += b[p]! & 0x80 ? 2 : 1; // length in characters
      let n = b[p]!;
      if (n & 0x80) (n = ((n & 0x7f) << 8) | b[p + 1]!), (p += 2);
      else p += 1;
      s = new TextDecoder().decode(b.subarray(p, p + n));
    } else {
      let n = v.getUint16(p, true);
      if (n & 0x8000) (n = ((n & 0x7fff) << 16) | v.getUint16(p + 2, true)), (p += 4);
      else p += 2;
      s = new TextDecoder("utf-16le").decode(b.subarray(p, p + n * 2));
    }
    cache.set(i, s);
    return s;
  };
}

type Value = string | number | boolean | { ref: number } | null;

const ATTR: Record<number, string> = {
  0x01010001: "label",
  0x01010003: "name",
  0x0101020c: "minSdkVersion",
  0x01010270: "targetSdkVersion",
  0x0101021b: "versionCode",
  0x0101021c: "versionName",
  0x0101055b: "isFeatureSplit",
  0x01010591: "isSplitRequired",
};

/** Each element of a binary XML file, with its attributes by name, in order. */
export function readBinaryXml(b: Uint8Array): Array<{ name: string; attrs: Record<string, Value> }> {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length < 8 || v.getUint16(0, true) !== 0x0003) throw notAnApp("its manifest isn't Android's binary XML");
  let str: (i: number) => string = () => "";
  let resMap: Uint32Array = new Uint32Array();
  const out: Array<{ name: string; attrs: Record<string, Value> }> = [];
  for (let at = v.getUint16(2, true); at + 8 <= b.length; ) {
    const type = v.getUint16(at, true);
    const size = v.getUint32(at + 4, true);
    if (size < 8 || at + size > b.length) break;
    if (type === 0x0001) str = stringPool(b, at);
    else if (type === 0x0180) resMap = Uint32Array.from({ length: (size - v.getUint16(at + 2, true)) / 4 }, (_, i) => v.getUint32(at + v.getUint16(at + 2, true) + i * 4, true));
    else if (type === 0x0102) {
      const ext = at + 16;
      const name = str(v.getUint32(ext + 4, true));
      const attrStart = v.getUint16(ext + 8, true);
      const attrSize = v.getUint16(ext + 10, true);
      const attrCount = v.getUint16(ext + 12, true);
      const attrs: Record<string, Value> = {};
      for (let i = 0; i < attrCount; i++) {
        const a = ext + attrStart + i * attrSize;
        const nameIdx = v.getUint32(a + 4, true);
        const key = (nameIdx < resMap.length && ATTR[resMap[nameIdx]!]) || str(nameIdx);
        const raw = v.getUint32(a + 8, true);
        const dataType = b[a + 15]!;
        const data = v.getUint32(a + 16, true);
        attrs[key] =
          dataType === 0x03 ? str(data) : dataType === 0x01 ? { ref: data } : dataType === 0x12 ? data !== 0 : dataType === 0x10 || dataType === 0x11 ? data | 0 : raw !== 0xffffffff ? str(raw) : null;
      }
      out.push({ name, attrs });
    }
    at += size;
  }
  return out;
}

/** A string resource (an app's name, say), in `language` if the app has it, else its default. */
export function resourceString(arsc: Uint8Array, id: number, languages: string[] = []): string | null {
  const v = new DataView(arsc.buffer, arsc.byteOffset, arsc.byteLength);
  if (arsc.length < 12 || v.getUint16(0, true) !== 0x0002) return null;
  let global: (i: number) => string = () => "";
  const pkgId = id >>> 24;
  const typeId = (id >>> 16) & 0xff;
  const entry = id & 0xffff;
  // Every value the resource has, by the language of its configuration ("" for the default).
  const found: Array<{ lang: string; dataType: number; data: number }> = [];
  for (let at = v.getUint16(2, true); at + 8 <= arsc.length; ) {
    const type = v.getUint16(at, true);
    const size = v.getUint32(at + 4, true);
    if (size < 8 || at + size > arsc.length) break;
    if (type === 0x0001) global = stringPool(arsc, at);
    else if (type === 0x0200 && v.getUint32(at + 8, true) === pkgId) {
      for (let c = at + v.getUint16(at + 2, true); c + 8 <= at + size; ) {
        const ct = v.getUint16(c, true);
        const cs = v.getUint32(c + 4, true);
        if (cs < 8) break;
        if (ct === 0x0201 && arsc[c + 8] === typeId) {
          const flags = arsc[c + 9]!;
          const count = v.getUint32(c + 12, true);
          const entriesStart = c + v.getUint32(c + 16, true);
          const lang = arsc[c + 20 + 8] ? String.fromCharCode(arsc[c + 20 + 8]!, arsc[c + 20 + 9]!) : "";
          const index = c + v.getUint16(c + 2, true);
          let offset = -1;
          if (flags & 0x01) {
            // Sparse: (entry, offset/4) pairs, sorted.
            for (let i = 0; i < count; i++) if (v.getUint16(index + i * 4, true) === entry) offset = v.getUint16(index + i * 4 + 2, true) * 4;
          } else if (entry < count) {
            if (flags & 0x02) {
              const o = v.getUint16(index + entry * 2, true);
              offset = o === 0xffff ? -1 : o * 4;
            } else {
              const o = v.getUint32(index + entry * 4, true);
              offset = o === 0xffffffff ? -1 : o;
            }
          }
          if (offset >= 0) {
            const e = entriesStart + offset;
            const eflags = v.getUint16(e + 2, true);
            if (eflags & 0x0008) found.push({ lang, dataType: eflags >> 8, data: v.getUint32(e + 4, true) }); // compact
            else if (!(eflags & 0x0001)) found.push({ lang, dataType: arsc[e + v.getUint16(e, true) + 3]!, data: v.getUint32(e + v.getUint16(e, true) + 4, true) });
          }
        }
        c += cs;
      }
    }
    at += size;
  }
  const pick = languages.map((l) => found.find((f) => f.lang === l.slice(0, 2).toLowerCase())).find(Boolean) ?? found.find((f) => f.lang === "") ?? found[0];
  if (!pick) return null;
  if (pick.dataType === 0x03) return global(pick.data);
  if (pick.dataType === 0x01 && pick.data !== id) return resourceString(arsc, pick.data, languages);
  return null;
}

// ── Who signed it ────────────────────────────────────────────────────────────

/** One DER element: its tag, and where its contents are. */
function der(b: Uint8Array, at: number): { tag: number; start: number; end: number } {
  const tag = b[at]!;
  let len = b[at + 1]!;
  let start = at + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + b[at + 2 + i]!;
    start += n;
  }
  return { tag, start, end: start + len };
}
function children(b: Uint8Array, el: { start: number; end: number }) {
  const out: Array<{ tag: number; at: number; start: number; end: number }> = [];
  for (let p = el.start; p < el.end; ) {
    const c = der(b, p);
    out.push({ ...c, at: p });
    p = c.end;
  }
  return out;
}

/** Who a certificate says it belongs to: its organisation, or else its common name. */
function certificateName(cert: Uint8Array): string | null {
  try {
    const tbs = children(cert, der(cert, 0))[0]!;
    const parts = children(cert, tbs);
    const subject = parts[parts[0]!.tag === 0xa0 ? 5 : 4]!;
    const names: Record<string, string> = {};
    for (const set of children(cert, subject)) {
      for (const pair of children(cert, set)) {
        const [oid, value] = children(cert, pair);
        if (!oid || !value) continue;
        const key = latin1(cert.subarray(oid.start, oid.end)) === "\x55\x04\x0a" ? "O" : latin1(cert.subarray(oid.start, oid.end)) === "\x55\x04\x03" ? "CN" : "";
        if (key) names[key] = new TextDecoder().decode(cert.subarray(value.start, value.end));
      }
    }
    return names["O"] || names["CN"] || null;
  } catch {
    return null;
  }
}

export interface Signer {
  /** SHA-256 of the signing certificate, as apksigner and APKMirror show it. */
  sha256: string;
  name: string | null;
  scheme: "v1" | "v2" | "v3";
}

async function describeCert(cert: Uint8Array, scheme: Signer["scheme"]): Promise<Signer> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(cert)));
  return { sha256: Array.from(hash, (x) => x.toString(16).padStart(2, "0")).join(""), name: certificateName(cert), scheme };
}

/** The certificate an APK is signed with: from its APK Signing Block (v3, then v2), or its v1 signature file. */
export async function apkSigner(src: Source, items?: ZipItem[]): Promise<Signer | null> {
  const tail = await bytesOf(src, Math.max(0, src.size - 65557), src.size);
  const tv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let cdOffset = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (tv.getUint32(i, true) === 0x06054b50) (cdOffset = tv.getUint32(i + 16, true)), (i = -1);
  if (cdOffset >= 24) {
    const footer = await bytesOf(src, cdOffset - 24, cdOffset);
    if (latin1(footer.subarray(8)) === "APK Sig Block 42") {
      const size = Number(new DataView(footer.buffer).getBigUint64(0, true));
      const start = cdOffset - size - 8;
      if (start >= 0 && size < 64 * 1024 * 1024) {
        const block = await bytesOf(src, start + 8, cdOffset - 24);
        const bv = new DataView(block.buffer);
        const ids = new Map<number, Uint8Array>();
        for (let p = 0; p + 12 <= block.length; ) {
          const len = Number(bv.getBigUint64(p, true));
          ids.set(bv.getUint32(p + 8, true), block.subarray(p + 12, p + 8 + len));
          p += 8 + len;
        }
        for (const [id, scheme] of [
          [0x1b93ad61, "v3"],
          [0xf05368c0, "v3"],
          [0x7109871a, "v2"],
        ] as const) {
          const value = ids.get(id);
          if (!value) continue;
          // signers → first signer → signed data → certificates → first certificate (each length-prefixed).
          const u32 = (b: Uint8Array, at: number) => new DataView(b.buffer, b.byteOffset).getUint32(at, true);
          const signer = value.subarray(8);
          const signed = signer.subarray(4, 4 + u32(signer, 0));
          const digests = u32(signed, 0);
          const certs = signed.subarray(8 + digests);
          const cert = certs.subarray(4, 4 + u32(certs, 0));
          if (cert.length) return describeCert(cert, scheme);
        }
      }
    }
  }
  // v1: META-INF/*.RSA (or .DSA, .EC), a PKCS#7 SignedData whose certificates come after its content info.
  const list = items ?? (await zipItems(src));
  const sig = list.find((i) => /^META-INF\/[^/]+\.(RSA|DSA|EC)$/i.test(i.name));
  if (!sig) return null;
  try {
    const p7 = await itemBytes(src, sig, 1024 * 1024);
    const signedData = children(p7, children(p7, children(p7, der(p7, 0))[1]!)[0]!);
    const certs = signedData.find((c) => c.tag === 0xa0);
    if (!certs) return null;
    const first = der(p7, certs.start);
    return describeCert(p7.slice(certs.start, first.end), "v1");
  } catch {
    return null;
  }
}

// ── The app ──────────────────────────────────────────────────────────────────

export interface Part {
  /** Where it is in the bundle ("" for a plain .apk: the file itself). */
  file: string;
  /** "" for the base; otherwise its split name, like "config.arm64_v8a" or "config.en". */
  split: string;
  kind: "base" | "abi" | "density" | "language" | "feature" | "other";
  /** The processor, screen density or language it's for. */
  value: string;
  size: number;
}

export interface AppFile {
  format: "apk" | "apkm" | "apks" | "xapk";
  package: string;
  label: string | null;
  versionName: string | null;
  versionCode: number | null;
  minSdk: number | null;
  targetSdk: number | null;
  permissions: string[];
  signer: Signer | null;
  parts: Part[];
  /** Files beside the APKs (XAPK's game data in Android/obb): not installed. */
  extras: string[];
}

const ABIS = new Set(["armeabi", "armeabi_v7a", "arm64_v8a", "x86", "x86_64", "mips", "mips64", "riscv64"]);
const DENSITIES: Record<string, number> = { ldpi: 120, mdpi: 160, tvdpi: 213, hdpi: 240, xhdpi: 320, xxhdpi: 480, xxxhdpi: 640, nodpi: 0, anydpi: 0 };

/** What a split is for, from its name ("config.arm64_v8a", "config.xxhdpi", "config.de"; anything else is a feature). */
function classify(split: string): Pick<Part, "kind" | "value"> {
  if (!split) return { kind: "base", value: "" };
  if (!split.startsWith("config.")) return { kind: "feature", value: split };
  const what = split.slice(7);
  if (ABIS.has(what)) return { kind: "abi", value: what.replace(/_/g, "-") };
  if (what in DENSITIES) return { kind: "density", value: what };
  if (/^[a-z]{2,3}([_-]r?[A-Z]{2})?$/.test(what) || what.startsWith("b+")) return { kind: "language", value: what };
  return { kind: "other", value: what };
}

/** A split's name from its file name, when its manifest can't be read (bundletool's base-xxhdpi.apk, APKMirror's split_config.de.apk). */
function splitFromName(file: string): string {
  const base = file.split("/").pop()!.replace(/\.apk$/i, "");
  if (/^(base|base-master|main)$/i.test(base)) return "";
  const m = /^(?:split_)?(config\.[\w+-]+)$/.exec(base) ?? /^base-([\w+-]+)$/.exec(base);
  if (m) return m[1]!.startsWith("config.") ? m[1]! : `config.${m[1]}`;
  return base.replace(/^split_/, "");
}

async function manifestOf(src: Source, items: ZipItem[]) {
  const item = items.find((i) => i.name === "AndroidManifest.xml");
  if (!item) throw notAnApp("it has no AndroidManifest.xml");
  const xml = readBinaryXml(await itemBytes(src, item, 8 * 1024 * 1024));
  const root = xml.find((e) => e.name === "manifest")?.attrs ?? {};
  const sdk = xml.find((e) => e.name === "uses-sdk")?.attrs ?? {};
  const label = xml.find((e) => e.name === "application")?.attrs["label"] ?? null;
  const num = (x: Value) => (typeof x === "number" ? x : typeof x === "string" && /^\d+$/.test(x) ? Number(x) : null);
  return {
    package: typeof root["package"] === "string" ? root["package"] : "",
    split: typeof root["split"] === "string" ? root["split"] : "",
    versionName: typeof root["versionName"] === "string" ? root["versionName"] : null,
    versionCode: num(root["versionCode"] ?? null),
    minSdk: num(sdk["minSdkVersion"] ?? null),
    targetSdk: num(sdk["targetSdkVersion"] ?? null),
    label,
    permissions: xml.filter((e) => e.name === "uses-permission" && typeof e.attrs["name"] === "string").map((e) => e.attrs["name"] as string),
  };
}

/** Reads an app file: a plain APK or a bundle, told apart by what's inside, whatever it's called. */
export async function readAppFile(src: Source, options: { languages?: string[] } = {}): Promise<AppFile> {
  const items = await zipItems(src);
  const languages = options.languages ?? [];
  if (items.some((i) => i.name === "AndroidManifest.xml")) {
    const m = await manifestOf(src, items);
    const arsc = items.find((i) => i.name === "resources.arsc");
    const label = typeof m.label === "string" ? m.label : m.label && typeof m.label === "object" && arsc ? resourceString(await itemBytes(src, arsc), m.label.ref, languages) : null;
    return {
      format: "apk",
      package: m.package,
      label,
      versionName: m.versionName,
      versionCode: m.versionCode,
      minSdk: m.minSdk,
      targetSdk: m.targetSdk,
      permissions: m.permissions,
      signer: await apkSigner(src, items),
      parts: [{ file: "", split: m.split, ...classify(m.split), size: src.size }],
      extras: [],
    };
  }
  const apks = items.filter((i) => /\.apk$/i.test(i.name) && !i.name.endsWith("/"));
  if (!apks.length) throw notAnApp("there's no app inside it (an encrypted bundle, or not an app at all)");
  const json = async (name: string) => {
    const item = items.find((i) => i.name === name);
    try {
      return item ? (JSON.parse(new TextDecoder().decode(await itemBytes(src, item, 1024 * 1024))) as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  const xapk = await json("manifest.json");
  const apkm = await json("info.json");
  const parts: Part[] = [];
  let base: { src: Source; items: ZipItem[]; m: Awaited<ReturnType<typeof manifestOf>> } | null = null;
  for (const item of apks) {
    let split = splitFromName(item.name);
    try {
      const inner = await itemSource(src, item);
      const innerItems = await zipItems(inner);
      const m = await manifestOf(inner, innerItems);
      split = m.split;
      if (!split && !base) base = { src: inner, items: innerItems, m };
    } catch {
      // Named, then, by its file name.
    }
    parts.push({ file: item.name, split, ...classify(split), size: item.size });
  }
  if (!base) throw notAnApp("there's no base APK in it");
  const arsc = base.items.find((i) => i.name === "resources.arsc");
  const fromArsc = base.m.label && typeof base.m.label === "object" && arsc ? resourceString(await itemBytes(base.src, arsc), base.m.label.ref, languages) : null;
  const named = (x: unknown) => (typeof x === "string" && x.trim() ? x.trim() : null);
  return {
    format: xapk ? "xapk" : apkm ? "apkm" : "apks",
    package: base.m.package,
    label: (typeof base.m.label === "string" ? base.m.label : fromArsc) ?? named(xapk?.["name"]) ?? named(apkm?.["app_name"]),
    versionName: base.m.versionName,
    versionCode: base.m.versionCode,
    minSdk: base.m.minSdk,
    targetSdk: base.m.targetSdk,
    permissions: base.m.permissions,
    signer: await apkSigner(base.src, base.items),
    parts: parts.sort((a, b) => (a.kind === "base" ? -1 : b.kind === "base" ? 1 : a.split.localeCompare(b.split))),
    extras: items.filter((i) => !/\.apk$/i.test(i.name) && !i.name.endsWith("/") && !["manifest.json", "info.json", "icon.png", "toc.pb"].includes(i.name)).map((i) => i.name),
  };
}

export interface Phone {
  /** Its processors, best first (Build.SUPPORTED_ABIS: "arm64-v8a", "armeabi-v7a"). */
  abis: string[];
  dpi: number;
  /** Its languages ("en", "is"), first preferred. */
  languages: string[];
  sdk: number;
}

/**
 * The parts this phone needs, as APKMirror's installer picks them: the base and
 * any features, the best processor and screen density it has a part for, and
 * its languages (or English, when the app has none of them).
 */
export function partsFor(app: AppFile, phone: Phone): Part[] {
  const of = (kind: Part["kind"]) => app.parts.filter((p) => p.kind === kind);
  const chosen = app.parts.filter((p) => p.kind === "base" || p.kind === "feature" || p.kind === "other");
  const abi = phone.abis.map((a) => of("abi").find((p) => p.value === a)).find(Boolean);
  if (abi) chosen.push(abi);
  const densities = of("density").filter((p) => DENSITIES[p.value]! > 0);
  const fitting = densities.filter((p) => DENSITIES[p.value]! >= phone.dpi).sort((a, b) => DENSITIES[a.value]! - DENSITIES[b.value]!)[0];
  const density = fitting ?? densities.sort((a, b) => DENSITIES[b.value]! - DENSITIES[a.value]!)[0];
  if (density) chosen.push(density);
  const langs = of("language");
  const wanted = langs.filter((p) => phone.languages.some((l) => p.value.toLowerCase().replace(/^b\+/, "").slice(0, 2) === l.slice(0, 2).toLowerCase()));
  chosen.push(...(wanted.length ? wanted : langs.filter((p) => p.value === "en")));
  return chosen;
}

/** Why this phone can't run it, if it can't: too old an Android, or no part for its processor. */
export function cantRun(app: AppFile, phone: Phone): string | null {
  if (app.minSdk && phone.sdk && app.minSdk > phone.sdk) return `It needs Android ${androidVersion(app.minSdk)} or newer, and this phone has Android ${androidVersion(phone.sdk)}.`;
  const abis = app.parts.filter((p) => p.kind === "abi");
  if (abis.length && !abis.some((p) => phone.abis.includes(p.value))) return `It's made for ${abis.map((p) => p.value).join(", ")} processors, and this phone has ${phone.abis.join(", ")}.`;
  return null;
}

/** Android's version number for an API level ("14" for 34). */
export function androidVersion(sdk: number): string {
  const names: Record<number, string> = { 21: "5", 22: "5.1", 23: "6", 24: "7", 25: "7.1", 26: "8", 27: "8.1", 28: "9", 29: "10", 30: "11", 31: "12", 32: "12L", 33: "13", 34: "14", 35: "15", 36: "16", 37: "17" };
  return names[sdk] ?? `API ${sdk}`;
}

/** Whether a file's name says it's an Android app. */
export function isAppFileName(name: string): boolean {
  return /\.(apk|apkm|apks|xapk)$/i.test(name);
}
