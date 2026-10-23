/**
 * Media written on the device, with no libraries: WAV, Opus audio in an Ogg
 * file (from the browser's own encoder), animated GIFs and icons (.ico). The
 * browser decodes; these put the result into a file.
 */
import { join } from "./formats.ts";

// ── WAV ──────────────────────────────────────────────────────────────────────

/** 16-bit WAV from decoded audio (one Float32Array per channel). */
export function encodeWav(channels: Float32Array[], sampleRate: number): Uint8Array {
  const count = channels.length;
  const frames = channels[0]?.length ?? 0;
  const data = frames * count * 2;
  const out = new Uint8Array(44 + data);
  const v = new DataView(out.buffer);
  const text = (at: number, s: string) => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  text(0, "RIFF");
  v.setUint32(4, 36 + data, true);
  text(8, "WAVE");
  text(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, count, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * count * 2, true);
  v.setUint16(32, count * 2, true);
  v.setUint16(34, 16, true);
  text(36, "data");
  v.setUint32(40, data, true);
  let at = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < count; c++) {
      const s = Math.max(-1, Math.min(1, channels[c]![i]!));
      v.setInt16(at, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      at += 2;
    }
  }
  return out;
}

// ── Ogg Opus ─────────────────────────────────────────────────────────────────

const OGG_CRC = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n << 24;
    for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function oggCrc(data: Uint8Array): number {
  let c = 0;
  for (let i = 0; i < data.length; i++) c = ((c << 8) ^ OGG_CRC[((c >>> 24) ^ data[i]!) & 0xff]!) >>> 0;
  return c >>> 0;
}

/** Opus packets (from the browser's AudioEncoder) in an Ogg file, as every player reads them. */
export class OggOpusWriter {
  private readonly pages: Uint8Array[] = [];
  private readonly serial = Math.floor(Math.random() * 0xffffffff) >>> 0;
  private sequence = 0;
  private granule = 0;
  private pending: Uint8Array[] = [];
  private pendingSegments = 0;
  readonly preSkip: number;

  constructor(channels: number, inputRate: number, preSkip = 312) {
    this.preSkip = preSkip;
    const head = new Uint8Array(19);
    const hv = new DataView(head.buffer);
    head.set([..."OpusHead"].map((c) => c.charCodeAt(0)));
    hv.setUint8(8, 1);
    hv.setUint8(9, channels);
    hv.setUint16(10, preSkip, true);
    hv.setUint32(12, inputRate, true);
    hv.setInt16(16, 0, true);
    hv.setUint8(18, 0);
    this.page([head], 0, 0x02);
    const vendor = new TextEncoder().encode("Cardboard");
    const tags = new Uint8Array(8 + 4 + vendor.length + 4);
    const tv = new DataView(tags.buffer);
    tags.set([..."OpusTags"].map((c) => c.charCodeAt(0)));
    tv.setUint32(8, vendor.length, true);
    tags.set(vendor, 12);
    tv.setUint32(12 + vendor.length, 0, true);
    this.page([tags], 0, 0);
    this.granule = preSkip;
  }

  /** One encoded packet, `samples` long (at 48 kHz). */
  add(packet: Uint8Array, samples: number) {
    const segments = Math.floor(packet.length / 255) + 1;
    if (this.pendingSegments + segments > 255) this.flush(false);
    this.pending.push(packet);
    this.pendingSegments += segments;
    this.granule += samples;
    // About a second per page, like other encoders.
    if (this.pending.length >= 50) this.flush(false);
  }

  finish(): Uint8Array {
    this.flush(true);
    return join(this.pages);
  }

  private flush(last: boolean) {
    if (!this.pending.length && !last) return;
    this.page(this.pending, this.granule, last ? 0x04 : 0);
    this.pending = [];
    this.pendingSegments = 0;
  }

  private page(packets: Uint8Array[], granule: number, flags: number) {
    const lacing: number[] = [];
    for (const p of packets) {
      for (let n = p.length; ; n -= 255) {
        lacing.push(Math.min(n, 255));
        if (n < 255) break;
      }
    }
    const header = new Uint8Array(27 + lacing.length);
    const v = new DataView(header.buffer);
    header.set([0x4f, 0x67, 0x67, 0x53]);
    v.setUint8(4, 0);
    v.setUint8(5, flags);
    v.setUint32(6, granule >>> 0, true);
    v.setUint32(10, Math.floor(granule / 0x100000000), true);
    v.setUint32(14, this.serial, true);
    v.setUint32(18, this.sequence++, true);
    v.setUint8(26, lacing.length);
    header.set(lacing, 27);
    const page = join([header, ...packets]);
    new DataView(page.buffer).setUint32(22, oggCrc(page), true);
    this.pages.push(page);
  }
}

// ── GIF ──────────────────────────────────────────────────────────────────────

export interface GifFrame {
  /** RGBA pixels, width × height × 4. */
  rgba: Uint8ClampedArray | Uint8Array;
  /** How long it shows, in hundredths of a second. */
  delay: number;
}

/** Up to 256 colours that suit these pixels (median cut over a sample of them). */
export function palette(frames: GifFrame[], colors = 256): Uint8Array {
  const samples: number[] = [];
  const total = frames.reduce((n, f) => n + f.rgba.length / 4, 0);
  const step = Math.max(1, Math.floor(total / 60000));
  let i = 0;
  for (const f of frames) {
    for (let p = 0; p < f.rgba.length; p += 4, i++) if (i % step === 0) samples.push((f.rgba[p]! << 16) | (f.rgba[p + 1]! << 8) | f.rgba[p + 2]!);
  }
  let boxes: number[][] = [samples.length ? samples : [0]];
  const channel = (c: number, k: number) => (c >> (16 - k * 8)) & 0xff;
  while (boxes.length < colors) {
    // Split the box with the widest spread of any colour channel.
    let best = -1;
    let bestRange = 0;
    let bestChannel = 0;
    boxes.forEach((box, b) => {
      if (box.length < 2) return;
      for (let k = 0; k < 3; k++) {
        let lo = 255;
        let hi = 0;
        for (const c of box) {
          const v = channel(c, k);
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
        if (hi - lo > bestRange) {
          bestRange = hi - lo;
          best = b;
          bestChannel = k;
        }
      }
    });
    if (best < 0) break;
    const box = boxes[best]!.sort((a, b) => channel(a, bestChannel) - channel(b, bestChannel));
    const mid = box.length >> 1;
    boxes.splice(best, 1, box.slice(0, mid), box.slice(mid));
  }
  const out = new Uint8Array(colors * 3);
  boxes.forEach((box, b) => {
    for (let k = 0; k < 3; k++) out[b * 3 + k] = Math.round(box.reduce((n, c) => n + channel(c, k), 0) / box.length);
  });
  return out;
}

function lzw(indices: Uint8Array, minCode: number): Uint8Array {
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  const clear = 1 << minCode;
  const end = clear + 1;
  let size = minCode + 1;
  let next = end + 1;
  let dict = new Map<number, number>();
  const write = (code: number) => {
    buffer |= code << bits;
    bits += size;
    while (bits >= 8) {
      out.push(buffer & 0xff);
      buffer >>>= 8;
      bits -= 8;
    }
  };
  write(clear);
  let prefix = indices[0] ?? 0;
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i]!;
    const key = (prefix << 8) | k;
    const found = dict.get(key);
    if (found !== undefined) {
      prefix = found;
      continue;
    }
    write(prefix);
    if (next < 4096) {
      dict.set(key, next++);
      if (next > 1 << size && size < 12) size++;
    } else {
      write(clear);
      dict = new Map();
      size = minCode + 1;
      next = end + 1;
    }
    prefix = k;
  }
  write(prefix);
  write(end);
  if (bits > 0) out.push(buffer & 0xff);
  // In sub-blocks of at most 255 bytes.
  const blocks: number[] = [];
  for (let i = 0; i < out.length; i += 255) {
    const chunk = out.slice(i, i + 255);
    blocks.push(chunk.length, ...chunk);
  }
  blocks.push(0);
  return Uint8Array.from(blocks);
}

/** An animated GIF that loops forever. */
export function encodeGif(frames: GifFrame[], width: number, height: number): Uint8Array {
  const colors = palette(frames);
  const nearest = new Map<number, number>();
  const indexOf = (r: number, g: number, b: number) => {
    const key = ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2);
    let found = nearest.get(key);
    if (found === undefined) {
      let best = Infinity;
      found = 0;
      for (let c = 0; c < 256; c++) {
        const dr = colors[c * 3]! - r;
        const dg = colors[c * 3 + 1]! - g;
        const db = colors[c * 3 + 2]! - b;
        const d = dr * dr * 2 + dg * dg * 4 + db * db * 3;
        if (d < best) {
          best = d;
          found = c;
        }
      }
      nearest.set(key, found);
    }
    return found;
  };
  const head = new Uint8Array(13);
  const hv = new DataView(head.buffer);
  head.set([..."GIF89a"].map((c) => c.charCodeAt(0)));
  hv.setUint16(6, width, true);
  hv.setUint16(8, height, true);
  head[10] = 0xf7; // a global palette of 256 colours
  const loop = Uint8Array.from([0x21, 0xff, 0x0b, ...[..."NETSCAPE2.0"].map((c) => c.charCodeAt(0)), 0x03, 0x01, 0x00, 0x00, 0x00]);
  const parts: Uint8Array[] = [head, colors, loop];
  for (const f of frames) {
    const indices = new Uint8Array(width * height);
    for (let p = 0, q = 0; q < indices.length; p += 4, q++) indices[q] = indexOf(f.rgba[p]!, f.rgba[p + 1]!, f.rgba[p + 2]!);
    const control = Uint8Array.from([0x21, 0xf9, 0x04, 0x04, f.delay & 0xff, (f.delay >> 8) & 0xff, 0x00, 0x00]);
    const descriptor = new Uint8Array(10);
    const dv = new DataView(descriptor.buffer);
    descriptor[0] = 0x2c;
    dv.setUint16(5, width, true);
    dv.setUint16(7, height, true);
    parts.push(control, descriptor, Uint8Array.of(8), lzw(indices, 8));
  }
  parts.push(Uint8Array.of(0x3b));
  return join(parts);
}

// ── Icons ────────────────────────────────────────────────────────────────────

/** A Windows/web icon (.ico) from square PNGs (16, 32, 48, 256…), each kept as a PNG inside. */
export function encodeIco(pngs: Array<{ size: number; png: Uint8Array }>): Uint8Array {
  const head = new Uint8Array(6 + pngs.length * 16);
  const v = new DataView(head.buffer);
  v.setUint16(2, 1, true);
  v.setUint16(4, pngs.length, true);
  let offset = head.length;
  pngs.forEach(({ size, png }, i) => {
    const at = 6 + i * 16;
    v.setUint8(at, size >= 256 ? 0 : size);
    v.setUint8(at + 1, size >= 256 ? 0 : size);
    v.setUint16(at + 4, 1, true);
    v.setUint16(at + 6, 32, true);
    v.setUint32(at + 8, png.length, true);
    v.setUint32(at + 12, offset, true);
    offset += png.length;
  });
  return join([head, ...pngs.map((p) => p.png)]);
}
