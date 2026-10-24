// The converter: turns files into other kinds of files, on this device. Nothing is sent anywhere to
// convert it; the browser decodes (pictures, video, sound) and src/client/formats.ts and media.ts write
// the new file. What it can't do here yet, it says so, rather than pretending.
import {
  docxToText,
  fromBase64,
  imagesToPdf,
  jsonToRows,
  makeZip,
  markdownToHtml,
  page,
  parseCsv,
  readZip,
  rowsToHtml,
  rowsToJson,
  rowsToMarkdown,
  rowsToXlsx,
  sniff,
  textToPdf,
  toBase64,
  toCsv,
  toYaml,
  xlsxToRows,
} from "/lib/client/formats.ts";
import { encodeGif, encodeIco, encodeWav, OggOpusWriter } from "/lib/client/media.ts";
import { qrEncode, qrPath } from "/lib/shared/qr.ts";

const EXT = {
  image: ["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif", "ico", "svg"],
  video: ["mp4", "webm", "mov", "m4v", "mkv", "ogv"],
  audio: ["mp3", "wav", "ogg", "oga", "opus", "m4a", "aac", "flac", "weba"],
  table: ["csv", "tsv", "xlsx"],
  json: ["json"],
  docx: ["docx"],
  markdown: ["md", "markdown"],
  text: ["txt", "log", "text"],
  html: ["html", "htm"],
  zip: ["zip"],
};
/** Kinds we know but can't decode in a browser yet, and what to do instead. */
const NOT_YET = {
  heic: "iPhone photos (HEIC) can't be opened by this browser yet. On the iPhone: Settings → Camera → Formats → Most Compatible, or share them as JPEG.",
  heif: "HEIF photos can't be opened by this browser yet.",
  pdf: "Turning a PDF into pictures or text needs a PDF reader this can't carry yet. Coming.",
  doc: "Old Word files (.doc) need saving as .docx first.",
  xls: "Old Excel files (.xls) need saving as .xlsx first.",
  pptx: "Slides (.pptx) can't be converted here yet.",
  rar: "RAR archives can't be opened here (only .zip).",
  "7z": "7-Zip archives can't be opened here (only .zip).",
};

/** Most a phone or laptop can comfortably hold while converting media whole. */
export const MEDIA_MAX = 400 * 1024 * 1024;

export function extOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name || "");
  return m ? m[1].toLowerCase() : "";
}

export function baseOf(name) {
  return (name || "file").replace(/\.[a-z0-9]+$/i, "") || "file";
}

/** What kind of thing a file is, for converting. */
export function kindOf(file) {
  const ext = extOf(file.name);
  const type = file.type || "";
  if (EXT.docx.includes(ext)) return "docx";
  if (EXT.zip.includes(ext) || type === "application/zip") return "zip";
  if (EXT.table.includes(ext) || type === "text/csv") return "table";
  if (EXT.json.includes(ext) || type === "application/json") return "json";
  if (EXT.markdown.includes(ext)) return "markdown";
  if (EXT.html.includes(ext) || type === "text/html") return "html";
  if (NOT_YET[ext] || /image\/hei[cf]/.test(type)) return "unsupported";
  if (EXT.image.includes(ext) || type.startsWith("image/")) return "image";
  if (EXT.video.includes(ext) || type.startsWith("video/")) return "video";
  if (EXT.audio.includes(ext) || type.startsWith("audio/")) return "audio";
  if (EXT.text.includes(ext) || type.startsWith("text/")) return "text";
  return "other";
}

/** Why a file can't be converted here, or null. */
export function cantConvert(file) {
  const ext = extOf(file.name);
  if (NOT_YET[ext]) return NOT_YET[ext];
  if (/image\/hei[cf]/.test(file.type || "")) return NOT_YET.heic;
  return null;
}

/**
 * What these files can become. Each target: { id, label, many } where `many`
 * means all the chosen files go into one result (a PDF of pictures, a zip…).
 */
export function targetsFor(files) {
  if (!files.length) return [];
  const kinds = new Set(files.map(kindOf));
  const only = (k) => kinds.size === 1 && kinds.has(k);
  const t = [];
  if (only("image")) {
    t.push({ id: "jpeg", label: "JPEG picture" }, { id: "png", label: "PNG picture" }, { id: "webp", label: "WebP picture (smaller)" });
    t.push({ id: "pdf-images", label: files.length > 1 ? "One PDF of them all" : "PDF", many: true });
    if (files.length > 1) t.push({ id: "gif-images", label: "An animated GIF of them", many: true });
    t.push({ id: "ico", label: "Icon (.ico)" });
    t.push({ id: "rotate-right", label: "Turned right ↻" }, { id: "rotate-left", label: "Turned left ↺" }, { id: "rotate-180", label: "Upside down" }, { id: "flip", label: "Mirrored" });
  }
  if (only("video")) t.push({ id: "gif-video", label: "Animated GIF (a clip)" }, { id: "frame", label: "A still picture (JPEG)" }, { id: "opus", label: "Just the sound (Opus .ogg, small)" }, { id: "wav", label: "Just the sound (WAV, any player)" });
  if (only("audio")) t.push({ id: "opus", label: "Opus .ogg (small)" }, { id: "wav", label: "WAV (any player)" });
  if (only("table") || only("json")) {
    t.push({ id: "xlsx", label: "Excel (.xlsx)" }, { id: "csv", label: "CSV" }, { id: "tsv", label: "TSV (tabs)" }, { id: "json", label: "JSON" }, { id: "html-table", label: "Web page (table)" }, { id: "md-table", label: "Markdown table" });
  }
  if (only("json")) t.push({ id: "yaml", label: "YAML" }, { id: "json-pretty", label: "Tidy JSON" });
  if (only("docx")) t.push({ id: "txt", label: "Plain text" }, { id: "pdf-text", label: "PDF" }, { id: "html-text", label: "Web page" });
  if (only("markdown")) t.push({ id: "html-md", label: "Web page" }, { id: "pdf-text", label: "PDF" });
  if (only("text")) t.push({ id: "pdf-text", label: "PDF" }, { id: "html-text", label: "Web page" }, { id: "qr", label: "QR code (PNG)" }, { id: "unbase64", label: "Decode Base64 back to a file" });
  if (only("html")) t.push({ id: "txt", label: "Plain text" });
  if (only("zip")) t.push({ id: "unzip", label: "Unpack it (every file inside)" });
  t.push({ id: "zip", label: files.length > 1 ? "One .zip of them all" : ".zip", many: true }, { id: "base64", label: "Base64 text" });
  return t.filter((x) => !(x.id === "zip" && only("zip") && files.length === 1));
}

const bytesOf = async (file) => new Uint8Array(await file.arrayBuffer());
const textOf = async (file) => new TextDecoder().decode(await bytesOf(file));
const out = (name, type, data) => ({ name, type, blob: data instanceof Blob ? data : new Blob([data], { type }) });

/**
 * Converts. `options`: { quality (0–1), maxSide (px), start (s), seconds, width (px), at (s), onProgress(fraction, words) }.
 * Resolves with [{ name, type, blob }].
 */
export async function convert(target, files, options = {}) {
  const progress = options.onProgress ?? (() => {});
  const each = async (fn) => {
    const results = [];
    for (let i = 0; i < files.length; i++) {
      progress(i / files.length, `Converting ${files[i].name}…`);
      results.push(...[].concat(await fn(files[i])));
    }
    progress(1, "");
    return results;
  };
  const name = (file, ext) => `${baseOf(file.name)}.${ext}`;
  const together = files.length === 1 ? baseOf(files[0].name) : "converted";
  switch (target) {
    case "jpeg":
    case "png":
    case "webp":
      return each(async (f) => {
        const type = `image/${target}`;
        const blob = await canvasBlob(await drawn(f, options.maxSide, target === "jpeg"), type, options.quality ?? 0.9);
        if (blob.type !== type) throw new Error(`This browser can't make ${target.toUpperCase()} pictures. Try another kind (PNG always works).`);
        return out(name(f, target === "jpeg" ? "jpg" : target), type, blob);
      });
    case "rotate-right":
    case "rotate-left":
    case "rotate-180":
    case "flip":
      // Changed, and kept as the same kind of picture (PNG when the browser can't write that kind).
      return each(async (f) => {
        const img = await loadImage(f);
        const quarter = target === "rotate-right" || target === "rotate-left";
        const canvas = sized(quarter ? img.height : img.width, quarter ? img.width : img.height);
        const ctx = canvas.getContext("2d");
        ctx.translate(canvas.width / 2, canvas.height / 2);
        if (target === "flip") ctx.scale(-1, 1);
        else ctx.rotate({ "rotate-right": Math.PI / 2, "rotate-left": -Math.PI / 2, "rotate-180": Math.PI }[target]);
        ctx.drawImage(pixels(img), -img.width / 2, -img.height / 2, img.width, img.height);
        img.close?.();
        const wanted = /^image\/(jpeg|png|webp)$/.test(f.type) ? f.type : "image/png";
        let blob = await canvasBlob(canvas, wanted, 0.92);
        if (blob.type !== wanted) blob = await canvasBlob(canvas, "image/png");
        const ext = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" }[blob.type] ?? "png";
        return out(`${baseOf(f.name)} (${{ "rotate-right": "turned", "rotate-left": "turned", "rotate-180": "turned", flip: "mirrored" }[target]}).${ext}`, blob.type, blob);
      });
    case "ico":
      return each(async (f) => {
        const img = await loadImage(f);
        const sizes = [16, 32, 48, 64, 128, 256];
        const pngs = [];
        for (const size of sizes) pngs.push({ size, png: new Uint8Array(await (await canvasBlob(square(img, size), "image/png")).arrayBuffer()) });
        img.close?.();
        return out(name(f, "ico"), "image/x-icon", encodeIco(pngs));
      });
    case "pdf-images": {
      const pages = [];
      for (let i = 0; i < files.length; i++) {
        progress(i / files.length, `Adding ${files[i].name}…`);
        const canvas = await drawn(files[i], "maxSide" in options ? options.maxSide : 2400, true);
        pages.push({ jpeg: new Uint8Array(await (await canvasBlob(canvas, "image/jpeg", options.quality ?? 0.88)).arrayBuffer()), width: canvas.width, height: canvas.height });
      }
      progress(1, "");
      return [out(`${together}.pdf`, "application/pdf", imagesToPdf(pages, together))];
    }
    case "gif-images": {
      const first = await loadImage(files[0]);
      const { width, height } = fit(first.width, first.height, options.width ?? 480);
      first.close?.();
      const frames = [];
      for (let i = 0; i < files.length; i++) {
        progress(i / files.length, `Adding ${files[i].name}…`);
        const img = await loadImage(files[i]);
        const canvas = sized(width, height);
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, width, height);
        const scale = Math.min(width / img.width, height / img.height);
        ctx.drawImage(pixels(img), (width - img.width * scale) / 2, (height - img.height * scale) / 2, img.width * scale, img.height * scale);
        img.close?.();
        frames.push({ rgba: ctx.getImageData(0, 0, width, height).data, delay: Math.round((options.frameSeconds ?? 0.7) * 100) });
      }
      progress(0.95, "Making the GIF…");
      await idle();
      return [out(`${together}.gif`, "image/gif", encodeGif(frames, width, height))];
    }
    case "gif-video":
      return each(async (f) => out(name(f, "gif"), "image/gif", await videoToGif(f, options, progress)));
    case "frame":
      return each(async (f) => out(name(f, "jpg"), "image/jpeg", await videoFrame(f, options.at)));
    case "wav":
    case "opus":
      return each(async (f) => {
        if (f.size > MEDIA_MAX) throw new Error(`${f.name} is too big to convert on this device (most is about ${Math.round(MEDIA_MAX / 1024 / 1024)} MB).`);
        progress(0.05, `Reading the sound in ${f.name}…`);
        const audio = await decodeAudio(f);
        if (target === "wav") return out(name(f, "wav"), "audio/wav", encodeWav(channelsOf(audio), audio.sampleRate));
        return out(name(f, "ogg"), "audio/ogg", await toOpus(audio, options.bitrate ?? 96000, (x) => progress(0.1 + x * 0.9, `Making ${name(f, "ogg")}…`)));
      });
    case "xlsx":
    case "csv":
    case "tsv":
    case "json":
    case "html-table":
    case "md-table":
      return each(async (f) => {
        const rows = await tableOf(f);
        if (target === "xlsx") return out(name(f, "xlsx"), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", await rowsToXlsx(rows, baseOf(f.name)));
        if (target === "csv") return out(name(f, "csv"), "text/csv", `﻿${toCsv(rows)}`);
        if (target === "tsv") return out(name(f, "tsv"), "text/tab-separated-values", toCsv(rows, "\t"));
        if (target === "json") return out(name(f, "json"), "application/json", JSON.stringify(rowsToJson(rows), null, 2));
        if (target === "html-table") return out(name(f, "html"), "text/html", rowsToHtml(rows, baseOf(f.name)));
        return out(name(f, "md"), "text/markdown", rowsToMarkdown(rows));
      });
    case "yaml":
      return each(async (f) => out(name(f, "yaml"), "application/yaml", `${toYaml(JSON.parse(await textOf(f)))}\n`));
    case "json-pretty":
      return each(async (f) => out(name(f, "json"), "application/json", JSON.stringify(JSON.parse(await textOf(f)), null, 2)));
    case "txt":
      return each(async (f) => out(name(f, "txt"), "text/plain", await plainText(f)));
    case "pdf-text":
      return each(async (f) => out(name(f, "pdf"), "application/pdf", textToPdf(await plainText(f), baseOf(f.name))));
    case "html-text":
      return each(async (f) => out(name(f, "html"), "text/html", page(baseOf(f.name), `<pre style="white-space:pre-wrap">${escape(await plainText(f))}</pre>`)));
    case "html-md":
      return each(async (f) => out(name(f, "html"), "text/html", page(baseOf(f.name), markdownToHtml(await textOf(f)))));
    case "qr":
      return each(async (f) => {
        const text = (await textOf(f)).trim();
        if (text.length > 1200) throw new Error(`${f.name} is too long for a QR code (most is about 1,200 characters).`);
        return out(name(f, "png"), "image/png", await qrPng(text));
      });
    case "unbase64":
      return each(async (f) => {
        const data = fromBase64(await textOf(f));
        const kind = sniff(data);
        return out(`${baseOf(f.name)}.${kind.ext}`, kind.type, data);
      });
    case "unzip":
      return each(async (f) => (await readZip(await bytesOf(f))).map((e) => out(e.name.split("/").pop() || "file", "", e.data)));
    case "zip": {
      const entries = [];
      for (let i = 0; i < files.length; i++) {
        progress(i / files.length, `Packing ${files[i].name}…`);
        entries.push({ name: files[i].name, data: await bytesOf(files[i]) });
      }
      progress(1, "");
      return [out(`${together}.zip`, "application/zip", await makeZip(entries))];
    }
    case "base64":
      return each(async (f) => out(`${f.name}.base64.txt`, "text/plain", toBase64(await bytesOf(f))));
    default:
      throw new Error("This can't make that.");
  }
}

// ── Pictures ─────────────────────────────────────────────────────────────────

const idle = () => new Promise((resolve) => setTimeout(resolve, 0));

function escape(text) {
  return text.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]);
}

/** A picture, decoded: an ImageBitmap, or (for SVG) an <img>, which never runs scripts. */
async function loadImage(file) {
  if (extOf(file.name) !== "svg" && file.type !== "image/svg+xml" && typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file);
    } catch {
      // Some kinds (ICO in some browsers) only open through <img>.
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return { width: img.naturalWidth || 512, height: img.naturalHeight || 512, source: img, close() {} };
  } catch {
    throw new Error(`${file.name} isn't a picture this browser can open.`);
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

function sized(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

function fit(width, height, max) {
  if (!max || (width <= max && height <= max)) return { width, height };
  const scale = max / Math.max(width, height);
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

const pixels = (img) => img.source ?? img;

/** A picture drawn on a canvas, no bigger than `maxSide`; on white when the result has no transparency. */
async function drawn(file, maxSide, opaque) {
  const img = await loadImage(file);
  const { width, height } = fit(img.width, img.height, maxSide);
  const canvas = sized(width, height);
  const ctx = canvas.getContext("2d");
  if (opaque) {
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, width, height);
  }
  ctx.drawImage(pixels(img), 0, 0, width, height);
  img.close?.();
  return canvas;
}

function square(img, size) {
  const canvas = sized(size, size);
  const scale = Math.min(size / img.width, size / img.height);
  canvas.getContext("2d").drawImage(pixels(img), (size - img.width * scale) / 2, (size - img.height * scale) / 2, img.width * scale, img.height * scale);
  return canvas;
}

function canvasBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("This browser couldn't make the picture."))), type, quality));
}

async function qrPng(text) {
  const matrix = qrEncode(text);
  const scale = 12;
  const size = (matrix.length + 8) * scale;
  const canvas = sized(size, size);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = "#000";
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.fill(new Path2D(qrPath(matrix)));
  return canvasBlob(canvas, "image/png");
}

// ── Video ────────────────────────────────────────────────────────────────────

async function openVideo(file) {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  const url = URL.createObjectURL(file);
  video.src = url;
  await new Promise((resolve, reject) => {
    video.onloadeddata = resolve;
    video.onerror = () => reject(new Error(`${file.name} isn't a video this browser can open.`));
  });
  return { video, done: () => URL.revokeObjectURL(url) };
}

function seek(video, t) {
  return new Promise((resolve) => {
    if (Math.abs(video.currentTime - t) < 0.001 && video.readyState >= 2) return resolve();
    video.onseeked = () => resolve();
    video.currentTime = t;
  });
}

async function videoFrame(file, at) {
  const { video, done } = await openVideo(file);
  try {
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    await seek(video, Math.min(Math.max(0, at ?? Math.min(1, duration / 2)), Math.max(0, duration - 0.05)));
    const canvas = sized(video.videoWidth, video.videoHeight);
    canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
    return await canvasBlob(canvas, "image/jpeg", 0.92);
  } finally {
    done();
  }
}

async function videoToGif(file, options, progress) {
  const { video, done } = await openVideo(file);
  try {
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    const start = Math.min(Math.max(0, options.start ?? 0), Math.max(0, duration - 0.1));
    const length = Math.min(options.seconds ?? 5, 20, Math.max(0.1, duration - start));
    const fps = options.fps ?? 10;
    const { width, height } = fit(video.videoWidth, video.videoHeight, options.width ?? 480);
    const canvas = sized(width, height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const count = Math.max(1, Math.round(length * fps));
    const frames = [];
    for (let i = 0; i < count; i++) {
      progress((i / count) * 0.8, `Taking frame ${i + 1} of ${count}…`);
      await seek(video, start + i / fps);
      ctx.drawImage(video, 0, 0, width, height);
      frames.push({ rgba: ctx.getImageData(0, 0, width, height).data, delay: Math.round(100 / fps) });
    }
    progress(0.85, "Making the GIF…");
    await idle();
    return encodeGif(frames, width, height);
  } finally {
    done();
  }
}

// ── Sound ────────────────────────────────────────────────────────────────────

async function decodeAudio(file) {
  const Context = globalThis.OfflineAudioContext ?? globalThis.webkitOfflineAudioContext;
  if (!Context) throw new Error("This browser can't open sound.");
  const ctx = new Context(1, 1, 48000);
  try {
    return await ctx.decodeAudioData(await file.arrayBuffer());
  } catch {
    throw new Error(`${file.name} has no sound this browser can open.`);
  }
}

/** The audio's channels, at most two (more are mixed down to stereo). */
function channelsOf(audio) {
  const all = Array.from({ length: audio.numberOfChannels }, (_, c) => audio.getChannelData(c));
  if (all.length <= 2) return all;
  const left = new Float32Array(audio.length);
  const right = new Float32Array(audio.length);
  all.forEach((ch, c) => {
    const to = c % 2 ? right : left;
    for (let i = 0; i < ch.length; i++) to[i] += ch[i] / Math.ceil(all.length / 2);
  });
  return [left, right];
}

async function toOpus(audio, bitrate, progress) {
  if (typeof AudioEncoder === "undefined") throw new Error("This browser can't make Opus sound. Choose WAV, or use Chrome, Edge or Firefox.");
  const channels = channelsOf(audio);
  const config = { codec: "opus", sampleRate: 48000, numberOfChannels: channels.length, bitrate };
  if (!(await AudioEncoder.isConfigSupported(config)).supported) throw new Error("This browser can't make Opus sound. Choose WAV instead.");
  const writer = new OggOpusWriter(channels.length, audio.sampleRate);
  let failed = null;
  const encoder = new AudioEncoder({
    output: (chunk) => {
      const packet = new Uint8Array(chunk.byteLength);
      chunk.copyTo(packet);
      writer.add(packet, Math.round(((chunk.duration ?? 20000) * 48000) / 1e6));
    },
    error: (err) => (failed = err),
  });
  encoder.configure(config);
  const step = 48000; // a second at a time
  for (let at = 0; at < audio.length; at += step) {
    const frames = Math.min(step, audio.length - at);
    const planar = new Float32Array(frames * channels.length);
    channels.forEach((ch, c) => planar.set(ch.subarray(at, at + frames), c * frames));
    const data = new AudioData({ format: "f32-planar", sampleRate: 48000, numberOfFrames: frames, numberOfChannels: channels.length, timestamp: Math.round((at / 48000) * 1e6), data: planar });
    encoder.encode(data);
    data.close();
    if (encoder.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 5));
    progress(at / audio.length);
    if (failed) break;
  }
  await encoder.flush();
  encoder.close();
  if (failed) throw new Error(`The sound couldn't be encoded: ${failed.message}`);
  return writer.finish();
}

// ── Tables and text ──────────────────────────────────────────────────────────

async function tableOf(file) {
  const ext = extOf(file.name);
  if (ext === "xlsx") return xlsxToRows(await bytesOf(file));
  const text = await textOf(file);
  if (ext === "json" || file.type === "application/json") return jsonToRows(JSON.parse(text));
  return parseCsv(text, ext === "tsv" ? "\t" : undefined);
}

async function plainText(file) {
  const kind = kindOf(file);
  if (kind === "docx") return docxToText(await bytesOf(file));
  const text = await textOf(file);
  // DOMParser builds the page without running anything in it.
  if (kind === "html") return new DOMParser().parseFromString(text, "text/html").body?.textContent?.replace(/\n{3,}/g, "\n\n").trim() ?? "";
  return text;
}
