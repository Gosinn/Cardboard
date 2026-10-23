/**
 * File formats, read and written on the device: ZIP, tables (CSV, TSV, JSON,
 * Excel), Word text, Markdown, YAML and PDF. No libraries and no server: the
 * converter (convert.ts) runs everything here in the browser, so what you
 * convert never leaves your device unsealed.
 */
import { fail } from "../shared/errors.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// ── CRC-32 (ZIP's) ───────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array, crc = 0): number {
  let c = ~crc >>> 0;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return ~c >>> 0;
}

async function through(data: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([data]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

// ── ZIP ──────────────────────────────────────────────────────────────────────

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

/** A .zip of `entries`, each compressed when that makes it smaller. */
export async function makeZip(entries: ZipEntry[], now = new Date()): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((Math.max(1980, now.getFullYear()) - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const seen = new Set<string>();
  for (const entry of entries) {
    let name = entry.name.replace(/\\/g, "/").replace(/^\/+/, "") || "file";
    for (let i = 2; seen.has(name); i++) name = name.replace(/(\.[^./]*)?$/, (ext) => ` (${i})${ext}`);
    seen.add(name);
    const nameBytes = encoder.encode(name);
    const crc = crc32(entry.data);
    const deflated = entry.data.length > 64 ? await through(entry.data, new CompressionStream("deflate-raw")) : null;
    const packed = deflated && deflated.length < entry.data.length ? deflated : entry.data;
    const method = packed === entry.data ? 0 : 8;
    if (offset + packed.length > 0xffffffff - 1024 || entry.data.length > 0xffffffff) {
      throw fail("too_big", 413, "That's more than a .zip can hold without ZIP64 (4 GB).", "Make smaller zips.");
    }
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true); // UTF-8 names
    lv.setUint16(8, method, true);
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, packed.length, true);
    lv.setUint32(22, entry.data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    const head = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(head.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, packed.length, true);
    cv.setUint32(24, entry.data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    head.set(nameBytes, 46);
    parts.push(local, packed);
    central.push(head);
    offset += local.length + packed.length;
  }
  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  return join([...parts, ...central, end]);
}

/** What's in a .zip: names and their contents (folders left out). */
export async function readZip(zip: Uint8Array): Promise<ZipEntry[]> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65535); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw fail("bad_zip", 400, "That isn't a .zip file (or it's cut short).", "Check it opens on a computer.");
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  if (at === 0xffffffff || count === 0xffff) throw fail("bad_zip", 400, "That .zip is a ZIP64 one (over 4 GB, or over 65,535 files), which this can't open yet.", "Open it on a computer.");
  const out: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (view.getUint32(at, true) !== 0x02014b50) throw fail("bad_zip", 400, "That .zip is damaged.", "Check it opens on a computer.");
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const size = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const extra = view.getUint16(at + 30, true);
    const comment = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = new TextDecoder(flags & 0x0800 ? "utf-8" : "latin1").decode(zip.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extra + comment;
    if (name.endsWith("/")) continue;
    if (flags & 1) throw fail("zip_locked", 400, `${name} in that .zip has a password.`, "Open it on a computer with its password.");
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const packed = zip.subarray(start, start + size);
    if (method === 0) out.push({ name, data: packed.slice() });
    else if (method === 8) out.push({ name, data: await through(packed, new DecompressionStream("deflate-raw")) });
    else throw fail("bad_zip", 400, `${name} in that .zip is packed a way this can't open (method ${method}).`, "Open it on a computer.");
  }
  return out;
}

export function join(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// ── Tables: CSV, TSV, JSON, Excel ────────────────────────────────────────────

/** A table: the first row is the header. */
export type Rows = string[][];

/** Reads CSV (or TSV, or semicolons: whichever the first line uses most). */
export function parseCsv(text: string, delimiter?: string): Rows {
  const body = text.replace(/^﻿/, "");
  const sep = delimiter ?? guessDelimiter(body);
  const rows: Rows = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (quoted) {
      if (ch === '"' && body[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === sep) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && body[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function guessDelimiter(text: string): string {
  const line = text.split(/\r?\n/, 1)[0] ?? "";
  let best = ",";
  let most = 0;
  for (const sep of [",", "\t", ";", "|"]) {
    let n = 0;
    let quoted = false;
    for (const ch of line) {
      if (ch === '"') quoted = !quoted;
      else if (ch === sep && !quoted) n++;
    }
    if (n > most) {
      most = n;
      best = sep;
    }
  }
  return best;
}

export function toCsv(rows: Rows, sep = ","): string {
  const cell = (v: string) => (v.includes(sep) || v.includes('"') || v.includes("\n") || v.includes("\r") ? `"${v.replace(/"/g, '""')}"` : v);
  return rows.map((r) => r.map(cell).join(sep)).join("\r\n") + "\r\n";
}

/** JSON (a list of objects, a list of lists, or one object) as a table. */
export function jsonToRows(value: unknown): Rows {
  const text = (v: unknown) => (v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
  if (Array.isArray(value)) {
    if (value.every((v) => Array.isArray(v))) return value.map((r) => (r as unknown[]).map(text));
    const header: string[] = [];
    for (const item of value) if (item && typeof item === "object") for (const k of Object.keys(item)) if (!header.includes(k)) header.push(k);
    if (!header.length) return [["value"], ...value.map((v) => [text(v)])];
    return [header, ...value.map((item) => header.map((k) => text(item && typeof item === "object" ? (item as Record<string, unknown>)[k] : undefined)))];
  }
  if (value && typeof value === "object") return [["key", "value"], ...Object.entries(value).map(([k, v]) => [k, text(v)])];
  return [["value"], [text(value)]];
}

/** A table as a list of objects, numbers and true/false turned back into themselves. */
export function rowsToJson(rows: Rows): Array<Record<string, unknown>> {
  const [header = [], ...body] = rows;
  const names = header.map((h, i) => h || `column ${i + 1}`);
  return body.map((r) => Object.fromEntries(names.map((h, i) => [h, typed(r[i] ?? "")])));
}

function typed(v: string): unknown {
  if (/^-?(0|[1-9]\d{0,14})(\.\d+)?$/.test(v)) return Number(v);
  if (v === "true" || v === "false") return v === "true";
  return v;
}

const xml = (v: string) => v.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]!).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");

function column(n: number): string {
  let s = "";
  for (n++; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** An Excel workbook (.xlsx) with one sheet. */
export async function rowsToXlsx(rows: Rows, sheet = "Sheet1"): Promise<Uint8Array> {
  const cells = rows
    .map((r, y) => {
      const cs = r.map((v, x) => {
        const ref = `${column(x)}${y + 1}`;
        if (/^-?(0|[1-9]\d{0,14})(\.\d+)?$/.test(v)) return `<c r="${ref}"><v>${v}</v></c>`;
        return v === "" ? "" : `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xml(v)}</t></is></c>`;
      });
      return `<row r="${y + 1}">${cs.join("")}</row>`;
    })
    .join("");
  const files: Record<string, string> = {
    "[Content_Types].xml":
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    "_rels/.rels":
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xml(sheet.slice(0, 31))}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels":
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    "xl/worksheets/sheet1.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${cells}</sheetData></worksheet>`,
  };
  return makeZip(Object.entries(files).map(([name, text]) => ({ name, data: encoder.encode(text) })));
}

function unxml(v: string): string {
  return v.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_, e: string) => {
    const named: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
    if (named[e.toLowerCase()]) return named[e.toLowerCase()]!;
    const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : "";
  });
}

/** The first sheet of an Excel workbook (.xlsx), as a table. */
export async function xlsxToRows(file: Uint8Array): Promise<Rows> {
  const entries = new Map((await readZip(file)).map((e) => [e.name, decoder.decode(e.data)]));
  const rels = entries.get("xl/_rels/workbook.xml.rels") ?? "";
  const workbook = entries.get("xl/workbook.xml") ?? "";
  const firstId = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(workbook)?.[1];
  const target = firstId ? new RegExp(`<Relationship\\b[^>]*\\bId="${firstId}"[^>]*\\bTarget="([^"]+)"`).exec(rels)?.[1] ?? new RegExp(`<Relationship\\b[^>]*\\bTarget="([^"]+)"[^>]*\\bId="${firstId}"`).exec(rels)?.[1] : null;
  const path = target ? (target.startsWith("/") ? target.slice(1) : `xl/${target}`) : "xl/worksheets/sheet1.xml";
  const sheet = entries.get(path) ?? entries.get("xl/worksheets/sheet1.xml");
  if (!sheet) throw fail("bad_xlsx", 400, "That workbook has no sheet this can read.", "Save it again from Excel (as .xlsx) and try again.");
  const shared: string[] = [];
  for (const si of (entries.get("xl/sharedStrings.xml") ?? "").match(/<si>[\s\S]*?<\/si>/g) ?? []) {
    shared.push(unxml((si.match(/<t[^>]*>[\s\S]*?<\/t>/g) ?? []).map((t) => t.replace(/<[^>]+>/g, "")).join("")));
  }
  const rows: Rows = [];
  for (const row of sheet.match(/<row\b[\s\S]*?<\/row>|<row\b[^>]*\/>/g) ?? []) {
    const y = Number(/\br="(\d+)"/.exec(row)?.[1] ?? rows.length + 1) - 1;
    const cells: string[] = [];
    for (const c of row.match(/<c\b[^>]*\/>|<c\b[\s\S]*?<\/c>/g) ?? []) {
      const ref = /\br="([A-Z]+)\d+"/.exec(c)?.[1];
      const x = ref ? [...ref].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1 : cells.length;
      const type = /\bt="(\w+)"/.exec(c)?.[1];
      const v = /<v>([\s\S]*?)<\/v>/.exec(c)?.[1] ?? "";
      let value: string;
      if (type === "s") value = shared[Number(v)] ?? "";
      else if (type === "inlineStr") value = unxml((c.match(/<t[^>]*>[\s\S]*?<\/t>/g) ?? []).map((t) => t.replace(/<[^>]+>/g, "")).join(""));
      else if (type === "b") value = v === "1" ? "true" : "false";
      else value = unxml(v);
      cells[x] = value;
    }
    rows[y] = Array.from(cells, (v) => v ?? "");
  }
  const width = Math.max(0, ...rows.map((r) => r?.length ?? 0));
  return Array.from(rows, (r) => Array.from({ length: width }, (_, i) => r?.[i] ?? ""));
}

export function rowsToHtml(rows: Rows, title: string): string {
  const [header = [], ...body] = rows;
  const cell = (tag: string, v: string) => `<${tag}>${xml(v)}</${tag}>`;
  return page(title, `<table><thead><tr>${header.map((v) => cell("th", v)).join("")}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((v) => cell("td", v)).join("")}</tr>`).join("\n")}</tbody></table>`);
}

export function rowsToMarkdown(rows: Rows): string {
  const [header = [], ...body] = rows;
  const cell = (v: string) => v.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
  const line = (r: string[]) => `| ${header.map((_, i) => cell(r[i] ?? "")).join(" | ")} |`;
  return [line(header), `| ${header.map(() => "---").join(" | ")} |`, ...body.map(line)].join("\n") + "\n";
}

// ── Documents ────────────────────────────────────────────────────────────────

/** The text of a Word document (.docx): paragraphs, tabs and line breaks. */
export async function docxToText(file: Uint8Array): Promise<string> {
  const doc = (await readZip(file)).find((e) => e.name === "word/document.xml");
  if (!doc) throw fail("bad_docx", 400, "That isn't a Word document (.docx).", "Old .doc files need saving as .docx first.");
  const body = decoder.decode(doc.data);
  return (body.match(/<w:p\b[\s\S]*?<\/w:p>|<w:p\b[^>]*\/>/g) ?? [])
    .map((p) =>
      // Only what's shown: the text runs, tabs and line breaks, in order (not the paragraph's tab-stop settings).
      [...p.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:(?:br|cr)\b[^>]*\/>/g)]
        .map((m) => (m[1] !== undefined ? unxml(m[1]) : m[0].startsWith("<w:tab") ? "\t" : "\n"))
        .join(""),
    )
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** A whole HTML page around `body`, plain and readable, with no scripts. */
export function page(title: string, body: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${xml(title)}</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem;color:#222}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:4px 8px;text-align:left}pre{background:#f4f4f4;padding:8px;overflow:auto}code{background:#f4f4f4}blockquote{border-left:3px solid #ccc;margin-left:0;padding-left:1rem;color:#555}</style>
</head><body>
${body}
</body></html>
`;
}

/** Markdown to HTML. Everything is escaped first, so nothing in the text can become a script; links are http(s) or mailto only. */
export function markdownToHtml(md: string): string {
  const inline = (text: string) =>
    xml(text)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
      .replace(/\[([^\]]+)\]\(((?:https?:\/\/|mailto:)[^)\s"]+)\)/g, '<a href="$2">$1</a>');
  const out: string[] = [];
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  let para: string[] = [];
  let list: { tag: string; items: string[] } | null = null;
  const flush = () => {
    if (para.length) out.push(`<p>${inline(para.join(" "))}</p>`);
    para = [];
    if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join("")}</${list.tag}>`);
    list = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = /^```/.test(line);
    if (fence) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]!); i++) code.push(lines[i]!);
      out.push(`<pre><code>${xml(code.join("\n"))}</code></pre>`);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      out.push(`<h${heading[1]!.length}>${inline(heading[2]!)}</h${heading[1]!.length}>`);
    } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      out.push("<hr>");
    } else if (/^>\s?/.test(line)) {
      flush();
      out.push(`<blockquote>${inline(line.replace(/^>\s?/, ""))}</blockquote>`);
    } else if (bullet || numbered) {
      const tag = bullet ? "ul" : "ol";
      if (para.length || (list && list.tag !== tag)) flush();
      list ??= { tag, items: [] };
      list.items.push((bullet ?? numbered)![1]!);
    } else if (!line.trim()) flush();
    else {
      if (list) flush();
      para.push(line.trim());
    }
  }
  flush();
  return out.join("\n");
}

/** YAML for a JSON value: readable, and read back as the same value. */
export function toYaml(value: unknown, indent = ""): string {
  const scalar = (v: unknown): string => {
    if (v === null || v === undefined) return "null";
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    const s = String(v);
    return /^[\w./@-][\w ./@:-]*$/.test(s) && !/^(true|false|null|yes|no|on|off|~|-?\d[\d.e+-]*)$/i.test(s) && !/:\s|\s$/.test(s) ? s : JSON.stringify(s);
  };
  if (Array.isArray(value)) {
    if (!value.length) return "[]";
    return value.map((v) => (v && typeof v === "object" && Object.keys(v).length ? `${indent}-\n${toYaml(v, `${indent}  `)}` : `${indent}- ${v && typeof v === "object" ? (Array.isArray(v) ? "[]" : "{}") : scalar(v)}`)).join("\n");
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (!entries.length) return "{}";
    return entries
      .map(([k, v]) => {
        const key = scalar(k);
        if (v && typeof v === "object" && Object.keys(v).length) return `${indent}${key}:\n${toYaml(v, `${indent}  `)}`;
        return `${indent}${key}: ${v && typeof v === "object" ? (Array.isArray(v) ? "[]" : "{}") : scalar(v)}`;
      })
      .join("\n");
  }
  return `${indent}${scalar(value)}`;
}

// ── PDF ──────────────────────────────────────────────────────────────────────

/** Helvetica's widths (thousandths of the font size) for the printable ASCII characters. */
const HELVETICA = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500,
  667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500,
  722, 500, 500, 500, 334, 260, 334, 584,
];
/** Windows-1252 (PDF's WinAnsi) for the characters it has above Latin-1's 0x7F–0x9F gap. */
const WIN_ANSI: Record<string, number> = { "€": 0x80, "‚": 0x82, "ƒ": 0x83, "„": 0x84, "…": 0x85, "†": 0x86, "‡": 0x87, ˆ: 0x88, "‰": 0x89, Š: 0x8a, "‹": 0x8b, Œ: 0x8c, Ž: 0x8e, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97, "˜": 0x98, "™": 0x99, š: 0x9a, "›": 0x9b, œ: 0x9c, ž: 0x9e, Ÿ: 0x9f };

function winAnsi(ch: string): number {
  const code = ch.codePointAt(0)!;
  if (code >= 32 && code < 127) return code;
  if (code >= 0xa0 && code <= 0xff) return code;
  return WIN_ANSI[ch] ?? 63; // "?"
}

function widthOf(code: number): number {
  return code >= 32 && code < 127 ? HELVETICA[code - 32]! : 556;
}

export interface PdfImage {
  /** JPEG bytes. */
  jpeg: Uint8Array;
  width: number;
  height: number;
}

const A4 = { width: 595.28, height: 841.89 };

/** Builds a PDF from page content streams and the images they use. */
function buildPdf(pages: Array<{ content: string; images: PdfImage[]; size?: { width: number; height: number } }>, title: string): Uint8Array {
  const objects: Uint8Array[][] = [];
  const add = (...parts: Array<string | Uint8Array>) => {
    objects.push(parts.map((p) => (typeof p === "string" ? latin1(p) : p)));
    return objects.length;
  };
  const catalog = add(""); // filled in below
  const pagesObj = add("");
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const kids: number[] = [];
  for (const p of pages) {
    const xobjects = p.images.map((img) => add(`<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.jpeg.length} >>\nstream\n`, img.jpeg, "\nendstream"));
    const body = latin1(p.content);
    const content = add(`<< /Length ${body.length} >>\nstream\n`, body, "\nendstream");
    const size = p.size ?? A4;
    const images = xobjects.map((id, i) => `/Im${i} ${id} 0 R`).join(" ");
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${size.width.toFixed(2)} ${size.height.toFixed(2)}] /Contents ${content} 0 R /Resources << /Font << /F1 ${font} 0 R >>${images ? ` /XObject << ${images} >>` : ""} >> >>`));
  }
  objects[catalog - 1] = [latin1(`<< /Type /Catalog /Pages ${pagesObj} 0 R >>`)];
  objects[pagesObj - 1] = [latin1(`<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`)];
  const info = add(`<< /Title (${pdfString(title)}) /Producer (Cardboard) >>`);
  const out: Uint8Array[] = [latin1("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")];
  let at = out[0]!.length;
  const offsets: number[] = [];
  objects.forEach((parts, i) => {
    offsets.push(at);
    const chunk = join([latin1(`${i + 1} 0 obj\n`), ...parts, latin1("\nendobj\n")]);
    out.push(chunk);
    at += chunk.length;
  });
  const xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out.push(latin1(`${xref}trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${at}\n%%EOF\n`));
  return join(out);
}

function latin1(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

/** A string for inside ( ) in a PDF, as WinAnsi bytes. */
function pdfString(s: string): string {
  let out = "";
  for (const ch of s) {
    const code = winAnsi(ch);
    const c = String.fromCharCode(code);
    out += c === "(" || c === ")" || c === "\\" ? `\\${c}` : c;
  }
  return out;
}

/** Text as a PDF: A4 pages, Helvetica, wrapped to the page. */
export function textToPdf(text: string, title: string, size = 11): Uint8Array {
  const margin = 56;
  const width = A4.width - margin * 2;
  const lineHeight = size * 1.4;
  const perPage = Math.floor((A4.height - margin * 2) / lineHeight);
  const lines: string[] = [];
  for (const raw of text.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n")) {
    let line = "";
    let lineWidth = 0;
    for (const word of raw.split(/(\s+)/)) {
      const w = [...word].reduce((n, ch) => n + (widthOf(winAnsi(ch)) * size) / 1000, 0);
      if (lineWidth + w > width && line.trim()) {
        lines.push(line.trimEnd());
        line = "";
        lineWidth = 0;
        if (!word.trim()) continue;
      }
      if (w > width) {
        // A word longer than the line: break it by character.
        for (const ch of word) {
          const cw = (widthOf(winAnsi(ch)) * size) / 1000;
          if (lineWidth + cw > width) {
            lines.push(line);
            line = "";
            lineWidth = 0;
          }
          line += ch;
          lineWidth += cw;
        }
      } else {
        line += word;
        lineWidth += w;
      }
    }
    lines.push(line.trimEnd());
  }
  const pages = [];
  for (let i = 0; i < Math.max(1, lines.length); i += perPage) {
    const chunk = lines.slice(i, i + perPage);
    // The first line where Td put it (Tj), each next one a line lower (').
    const shown = chunk.map((l, n) => `(${pdfString(l)}) ${n ? "'" : "Tj"}`).join("\n");
    pages.push({ content: `BT /F1 ${size} Tf ${lineHeight.toFixed(2)} TL ${margin} ${(A4.height - margin - size).toFixed(2)} Td\n${shown}\nET`, images: [] });
  }
  return buildPdf(pages, title);
}

/** Pictures as a PDF: one per page, as big as fits on A4 (turned to suit the picture), centred. */
export function imagesToPdf(images: PdfImage[], title: string): Uint8Array {
  return buildPdf(
    images.map((img) => {
      const landscape = img.width > img.height;
      const size = landscape ? { width: A4.height, height: A4.width } : A4;
      const margin = 28;
      const scale = Math.min((size.width - margin * 2) / img.width, (size.height - margin * 2) / img.height, 1.5);
      const w = img.width * scale;
      const h = img.height * scale;
      return { content: `q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} ${((size.width - w) / 2).toFixed(2)} ${((size.height - h) / 2).toFixed(2)} cm /Im0 Do Q`, images: [img], size };
    }),
    title,
  );
}

// ── Base64 ───────────────────────────────────────────────────────────────────

export function toBase64(data: Uint8Array): string {
  let out = "";
  for (let i = 0; i < data.length; i += 0x8000) out += String.fromCharCode.apply(null, Array.from(data.subarray(i, i + 0x8000)));
  return btoa(out);
}

export function fromBase64(text: string): Uint8Array {
  const clean = text.replace(/^data:[^,]*,/, "").replace(/[\s]/g, "").replace(/-/g, "+").replace(/_/g, "/");
  let raw: string;
  try {
    raw = atob(clean + "=".repeat((4 - (clean.length % 4)) % 4));
  } catch {
    throw fail("bad_base64", 400, "That isn't Base64 text.", "Base64 is letters, digits, + and / (or - and _), maybe ending in =.");
  }
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/** What kind of file some bytes are, from how they start (for naming a decoded file). */
export function sniff(data: Uint8Array): { ext: string; type: string } {
  const starts = (...bytes: number[]) => bytes.every((b, i) => data[i] === b);
  if (starts(0x89, 0x50, 0x4e, 0x47)) return { ext: "png", type: "image/png" };
  if (starts(0xff, 0xd8, 0xff)) return { ext: "jpg", type: "image/jpeg" };
  if (starts(0x47, 0x49, 0x46, 0x38)) return { ext: "gif", type: "image/gif" };
  if (starts(0x25, 0x50, 0x44, 0x46)) return { ext: "pdf", type: "application/pdf" };
  if (starts(0x50, 0x4b, 0x03, 0x04)) return { ext: "zip", type: "application/zip" };
  if (starts(0x52, 0x49, 0x46, 0x46) && data[8] === 0x57 && data[9] === 0x45) return { ext: "webp", type: "image/webp" };
  if (starts(0x1a, 0x45, 0xdf, 0xa3)) return { ext: "webm", type: "video/webm" };
  if (starts(0x4f, 0x67, 0x67, 0x53)) return { ext: "ogg", type: "audio/ogg" };
  if (data[4] === 0x66 && data[5] === 0x74 && data[6] === 0x79 && data[7] === 0x70) return { ext: "mp4", type: "video/mp4" };
  return { ext: "bin", type: "application/octet-stream" };
}
