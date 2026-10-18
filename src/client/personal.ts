import type { Box } from "../sdk/index.ts";
import { isPlainObject, sortableId, type Item } from "../shared/data.ts";
import { fail } from "../shared/errors.ts";
import { formatBytes } from "../shared/size.ts";
import { fromB64u, sha256, toB64u } from "./crypto.ts";

/**
 * Your personal box, as the dashboard keeps it: notes, passwords, links and
 * files. Each kind is a collection ("notes/<id>"), so the CLI and your own
 * scripts can read them too. A file's bytes sit apart, in parts
 * ("file-data/<id>/<n>"), so listing the box never downloads them.
 */

export type ThingKind = "note" | "password" | "link" | "file";

export interface NoteValue {
  title: string;
  text: string;
}
export interface PasswordValue {
  title: string;
  username: string;
  password: string;
  url: string;
  notes: string;
}
export interface LinkValue {
  title: string;
  url: string;
  notes: string;
}
export interface FileValue {
  title: string;
  name: string;
  type: string;
  size: number;
  parts: number;
  /** SHA-256 of the bytes, checked when the file is read back. */
  sha256: string;
  notes: string;
}

export interface Thing<V = NoteValue | PasswordValue | LinkValue | FileValue> {
  kind: ThingKind;
  id: string;
  key: string;
  value: V;
  version: number;
  createdAt: number;
  updatedAt: number;
}

export const KINDS: Record<ThingKind, { collection: string; one: string; many: string }> = {
  note: { collection: "notes", one: "note", many: "notes" },
  password: { collection: "passwords", one: "password", many: "passwords" },
  link: { collection: "links", one: "link", many: "links" },
  file: { collection: "files", one: "file", many: "files" },
};

const FIELDS: Record<ThingKind, string[]> = {
  note: ["title", "text"],
  password: ["title", "username", "password", "url", "notes"],
  link: ["title", "url", "notes"],
  file: ["title", "notes"],
};

export const FILE_DATA = "file-data/";
/** Raw bytes per part: about 700 KB once sealed, under the 1 MB an item may hold. */
export const FILE_PART_BYTES = 512 * 1024;
export const MAX_FILE_BYTES = 100 * 1024 * 1024;
/** Parts sent per request while uploading (about 5.5 MB). */
const PARTS_PER_REQUEST = 8;
const MAX_TEXT = 200_000;

export function thingKey(kind: ThingKind, id: string): string {
  return `${KINDS[kind].collection}/${id}`;
}

export function kindOfKey(key: string): ThingKind | null {
  const slash = key.indexOf("/");
  if (slash < 1 || key.indexOf("/", slash + 1) !== -1 || slash === key.length - 1) return null;
  const collection = key.slice(0, slash);
  for (const [kind, info] of Object.entries(KINDS)) if (info.collection === collection) return kind as ThingKind;
  return null;
}

export function isFileData(key: string): boolean {
  return key.startsWith(FILE_DATA);
}

export function filePartKey(id: string, part: number): string {
  return `${FILE_DATA}${id}/${part}`;
}

/** Only http(s) links are ever opened: anything else (javascript:, data:…) is refused. */
export function safeUrl(text: unknown): string | null {
  if (typeof text !== "string" || !text.trim()) return null;
  const raw = text.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(withScheme);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

const text = (v: unknown, max = MAX_TEXT) => (typeof v === "string" ? v.slice(0, max) : "");

/** A thing's value as stored, cleaned up, with a title worked out if you left it empty. */
export function cleanValue(kind: ThingKind, input: Record<string, unknown>): NoteValue | PasswordValue | LinkValue {
  const v = Object.fromEntries(FIELDS[kind].map((f) => [f, text(input[f])])) as Record<string, string>;
  for (const f of ["title", "username", "url"]) if (f in v) v[f] = v[f]!.trim().slice(0, 500);
  if (kind === "link" || (kind === "password" && v.url)) {
    const url = safeUrl(v.url);
    if (!url) throw fail("bad_link", 400, `"${v.url}" isn't a web address.`, "Use an address like example.com or https://example.com.");
    v.url = url;
  }
  if (!v.title) {
    if (kind === "note") v.title = (v.text ?? "").trim().split("\n")[0]!.slice(0, 80).trim();
    else if (v.url) v.title = hostOf(v.url);
    else if (kind === "password") v.title = v.username ?? "";
  }
  if (kind === "password" && !v.password) throw fail("empty_password", 400, "There's no password to keep.", "Type one, or tap Make one.");
  if (kind === "note" && !v.title && !v.text) throw fail("empty_note", 400, "The note is empty.", "Write something first.");
  if (!v.title) v.title = `Untitled ${KINDS[kind].one}`;
  return v as unknown as NoteValue | PasswordValue | LinkValue;
}

function toThing(item: Item): Thing | null {
  const kind = kindOfKey(item.key);
  if (!kind || !isPlainObject(item.value)) return null;
  const value = Object.fromEntries(FIELDS[kind].map((f) => [f, text((item.value as Record<string, unknown>)[f])])) as Record<string, unknown>;
  if (kind === "file") {
    const raw = item.value as Record<string, unknown>;
    if (typeof raw.size !== "number" || typeof raw.parts !== "number") return null;
    Object.assign(value, { name: text(raw.name, 500), type: text(raw.type, 200), size: raw.size, parts: raw.parts, sha256: text(raw.sha256, 64) });
  }
  if (!value.title) value.title = `Untitled ${KINDS[kind].one}`;
  return { kind, id: item.key.slice(item.key.indexOf("/") + 1), key: item.key, value: value as unknown as Thing["value"], version: item.version, createdAt: item.createdAt, updatedAt: item.updatedAt };
}

/** Everything in the box that's a note, password, link or file, newest change first. */
export async function listThings(box: Box): Promise<{ things: Thing[]; other: number }> {
  let other = 0;
  const items = await box.items("", {
    skip: (key) => {
      if (isFileData(key)) return true;
      if (kindOfKey(key)) return false;
      other++;
      return true;
    },
  });
  const things = items.map(toThing).filter((t) => t !== null);
  return { things: things.sort((a, b) => b.updatedAt - a.updatedAt), other };
}

/** Saves a note, password or link (new without `id`). Pass the version you opened, to catch edits from another device. */
export async function saveThing(box: Box, kind: Exclude<ThingKind, "file">, input: Record<string, unknown>, options: { id?: string; version?: number } = {}): Promise<Thing> {
  const id = options.id ?? sortableId(Date.now());
  const key = thingKey(kind, id);
  const value = cleanValue(kind, input);
  await box.put(key, value, { ifVersion: options.id ? options.version : 0 });
  return toThing((await box.getItem(key))!)!;
}

/** Renames a file or changes its notes; the bytes stay as they are. */
export async function saveFileDetails(box: Box, file: Thing<FileValue>, input: { title?: string; notes?: string }, options: { version?: number } = {}): Promise<Thing> {
  const value = { ...file.value, title: text(input.title ?? file.value.title, 500).trim() || file.value.name, notes: text(input.notes ?? file.value.notes) };
  await box.put(file.key, value, { ifVersion: options.version });
  return toThing((await box.getItem(file.key))!)!;
}

/** Moves it out (with its file parts). Kept in history, so `restoreThing` brings it back. */
export async function removeThing(box: Box, thing: Thing): Promise<void> {
  const parts = thing.kind === "file" ? Array.from({ length: (thing.value as FileValue).parts }, (_, i) => filePartKey(thing.id, i)) : [];
  // The thing first, so a half-done delete never leaves a file without its bytes.
  await box.delete(thing.key);
  for (let i = 0; i < parts.length; i += 200) await box.batch(parts.slice(i, i + 200).map((key) => ({ op: "delete" as const, key })));
}

export async function restoreThing(box: Box, thing: Thing): Promise<void> {
  if (thing.kind === "file") for (let i = 0; i < (thing.value as FileValue).parts; i++) await box.undo(filePartKey(thing.id, i));
  await box.undo(thing.key);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return [...(await sha256(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Seals a file into the box: its bytes in parts first, then the entry that
 * lists it, so a file never shows up half uploaded. If it fails part way, the
 * parts already sent are removed.
 */
export async function addFile(
  box: Box,
  file: { name: string; type: string; bytes: Uint8Array },
  options: { title?: string; notes?: string; onProgress?: (fraction: number) => void } = {},
): Promise<Thing<FileValue>> {
  const { bytes } = file;
  if (bytes.length > MAX_FILE_BYTES) {
    throw fail("file_too_big", 413, `${file.name} is ${Math.round(bytes.length / 1024 / 1024)} MB; a file can be at most ${MAX_FILE_BYTES / 1024 / 1024} MB.`, "Split it, or keep a smaller copy.");
  }
  const id = sortableId(Date.now());
  const parts = Math.max(1, Math.ceil(bytes.length / FILE_PART_BYTES));
  const sent: string[] = [];
  try {
    for (let first = 0; first < parts; first += PARTS_PER_REQUEST) {
      const ops = [];
      for (let n = first; n < Math.min(parts, first + PARTS_PER_REQUEST); n++) {
        ops.push({ op: "put" as const, key: filePartKey(id, n), value: toB64u(bytes.subarray(n * FILE_PART_BYTES, (n + 1) * FILE_PART_BYTES)) });
      }
      await box.batch(ops);
      sent.push(...ops.map((o) => o.key));
      options.onProgress?.(sent.length / parts);
    }
    const value: FileValue = {
      title: text(options.title, 500).trim() || file.name.slice(0, 500),
      name: file.name.slice(0, 500),
      type: file.type.slice(0, 200),
      size: bytes.length,
      parts,
      sha256: await sha256Hex(bytes),
      notes: text(options.notes),
    };
    const key = thingKey("file", id);
    await box.put(key, value, { ifVersion: 0 });
    return toThing((await box.getItem(key))!)! as Thing<FileValue>;
  } catch (err) {
    for (let i = 0; i < sent.length; i += 200) await box.batch(sent.slice(i, i + 200).map((key) => ({ op: "delete" as const, key, purge: true }))).catch(() => {});
    throw err;
  }
}

/** A file's bytes, put back together and checked against the hash it was saved with. */
export async function readFile(box: Box, file: Thing<FileValue>, onProgress?: (fraction: number) => void): Promise<Uint8Array> {
  const { size, parts, sha256 } = file.value;
  const out = new Uint8Array(size);
  let at = 0;
  for (let first = 0; first < parts; first += PARTS_PER_REQUEST) {
    const keys = Array.from({ length: Math.min(PARTS_PER_REQUEST, parts - first) }, (_, i) => filePartKey(file.id, first + i));
    const items = await box.getMany<string>(keys);
    if (items.length !== keys.length) throw fail("file_incomplete", 404, `Part of ${file.value.name} is missing.`, "Undo its last change, or upload it again.");
    for (const item of items) {
      const chunk = fromB64u(item.value);
      if (at + chunk.length > size) throw fail("file_damaged", 422, `${file.value.name} doesn't match what was saved.`, "Upload it again.");
      out.set(chunk, at);
      at += chunk.length;
    }
    onProgress?.(Math.min(1, (first + keys.length) / parts));
  }
  if (at !== size || (sha256 && (await sha256Hex(out)) !== sha256)) throw fail("file_damaged", 422, `${file.value.name} doesn't match what was saved.`, "Upload it again.");
  return out;
}

/** What search may look at: never a password, never a file's bytes. */
export function searchText(value: unknown): string {
  if (!isPlainObject(value)) return "";
  const v = value;
  return ["title", "text", "username", "url", "notes", "name"].map((f) => (typeof v[f] === "string" ? v[f] : "")).filter(Boolean).join("\n");
}

/** One line under the title in a list. */
export function subtitle(thing: Thing): string {
  const v = thing.value as unknown as Record<string, string>;
  switch (thing.kind) {
    case "note": {
      // When the title is the note's first line, the line under it starts with the second.
      const lines = (v.text ?? "").trim().split("\n");
      const rest = lines[0]!.trim() === v.title ? lines.slice(1) : lines;
      return rest.join(" ").replace(/\s+/g, " ").trim().slice(0, 120);
    }
    case "password":
      return [v.username, v.url ? hostOf(v.url) : ""].filter(Boolean).join(" · ");
    case "link":
      return hostOf(v.url ?? "");
    case "file": {
      const file = thing.value as FileValue;
      return [file.name !== file.title ? file.name : "", formatBytes(file.size)].filter(Boolean).join(" · ");
    }
  }
}

const LOWER = "abcdefghijkmnpqrstuvwxyz";
const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const DIGITS = "23456789";
const SYMBOLS = "!#$%*+-=?@^_";

function pick(alphabet: string): string {
  // Rejection sampling, so every character is equally likely.
  const limit = 256 - (256 % alphabet.length);
  for (;;) {
    const [b] = crypto.getRandomValues(new Uint8Array(1));
    if (b! < limit) return alphabet[b! % alphabet.length]!;
  }
}

/** A strong random password: no look-alike characters (l, 1, O, 0), and one of each kind. */
export function strongPassword(length = 20): string {
  const all = LOWER + UPPER + DIGITS + SYMBOLS;
  for (;;) {
    const out = Array.from({ length: Math.max(12, length) }, () => pick(all)).join("");
    if ([LOWER, UPPER, DIGITS, SYMBOLS].every((set) => [...out].some((c) => set.includes(c)))) return out;
  }
}
