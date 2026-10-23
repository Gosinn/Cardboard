import type { Box } from "../sdk/index.ts";
import { isPlainObject, sortableId, type Item } from "../shared/data.ts";
import { fail } from "../shared/errors.ts";
import { formatBytes } from "../shared/size.ts";
import { fromB64u, sha256 } from "./crypto.ts";

/**
 * Your personal box, as the dashboard keeps it: notes, passwords, links and
 * files. Each kind is a collection ("notes/<id>"), so the CLI and your own
 * scripts can read them too. A file's bytes sit apart, in parts of just under
 * 1 MB ("file-data/<id>/<n>"), so listing the box never downloads them, any
 * size of file can be sent or read a piece at a time, and a video can play
 * from the middle without fetching the start.
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
export interface FileValue extends Sent {
  title: string;
  name: string;
  type: string;
  size: number;
  parts: number;
  /** Bytes per part (the last can be shorter). Files saved before 0.6 have none: 512 KiB parts, kept as base64 text. */
  partSize?: number;
  /**
   * Checked when the whole file is read. With hashOf "parts", it's the SHA-256
   * of the parts' own SHA-256s, so it can be worked out a part at a time.
   * Before 0.6, it was the SHA-256 of the whole file.
   */
  sha256: string;
  hashOf?: "parts";
  notes: string;
}

/** Set on something you sent yourself from another device, until you keep it or clear it. */
export interface Sent {
  inbox?: true;
  /** The device it came from, as you named it. */
  from?: string;
}

export interface Thing<V = (NoteValue | PasswordValue | LinkValue | FileValue) & Sent> {
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
/** Bytes per part, stored as they are: just under the 1 MB an item may hold once sealed. */
export const FILE_PART_BYTES = 960 * 1024;
const LEGACY_PART_BYTES = 512 * 1024;
export const MAX_FILE_BYTES = 20 * 1024 ** 3;
/** Parts per request while sending or reading a whole file (about 7.5 MB). */
const PARTS_PER_REQUEST = 8;
const MAX_TEXT = 200_000;
/** Your personal box has no small limit of its own: only your account's limit applies. */
export const PERSONAL_SETTINGS = { quotaBytes: 1024 ** 4 };
/** In a friend box: its title and who it's from, for the people opening its link. */
export const FRIEND_ABOUT = "friend/about";
/** The limit every box got before 0.6, raised for a personal box made back then. */
export const OLD_BOX_QUOTA = 512 * 1024 * 1024;

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
    if (typeof raw.partSize === "number") value.partSize = raw.partSize;
    if (raw.hashOf === "parts") value.hashOf = "parts";
  }
  if (!value.title) value.title = `Untitled ${KINDS[kind].one}`;
  const raw = item.value as Record<string, unknown>;
  if (raw.inbox === true) Object.assign(value, { inbox: true, from: text(raw.from, 100) });
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

/**
 * Sends something to your other devices: a link, a bit of text, or a file. It
 * lands in your personal box marked as just arrived, so every device you're
 * signed in on shows it, live, until you keep it or clear it.
 */
export async function sendText(box: Box, text: string, from: string): Promise<Thing> {
  const trimmed = text.trim();
  if (!trimmed) throw fail("nothing_to_send", 400, "There's nothing to send.", "Type or paste something first, or pick a file.");
  // A lone web address becomes a link you can open; anything else, a note you can copy.
  const url = /^\S+$/.test(trimmed) && /^(https?:\/\/|www\.)/i.test(trimmed) ? safeUrl(trimmed) : null;
  const kind = url ? "link" : "note";
  const value = { ...cleanValue(kind, url ? { url } : { text: trimmed }), inbox: true, from: from.slice(0, 100) };
  const key = thingKey(kind, sortableId(Date.now()));
  await box.put(key, value, { ifVersion: 0 });
  return toThing((await box.getItem(key))!)!;
}

export function sendFile(box: Box, file: Blob, from: string, options: Omit<Parameters<typeof addFile>[2] & {}, "sentFrom"> = {}) {
  return addFile(box, file, { ...options, sentFrom: from });
}

/** Keeps something you sent yourself: it stays in your personal box as an ordinary note, link or file. */
export async function keepThing(box: Box, thing: Thing): Promise<Thing> {
  const { inbox: _inbox, from: _from, ...value } = thing.value as unknown as Record<string, unknown>;
  await box.put(thing.key, value, { ifVersion: thing.version });
  return toThing((await box.getItem(thing.key))!)!;
}

/** Renames a file or changes its notes; the bytes stay as they are. */
export async function saveFileDetails(box: Box, file: Thing<FileValue>, input: { title?: string; notes?: string }, options: { version?: number } = {}): Promise<Thing> {
  const value = { ...file.value, title: text(input.title ?? file.value.title, 500).trim() || file.value.name, notes: text(input.notes ?? file.value.notes) };
  await box.put(file.key, value, { ifVersion: options.version });
  return toThing((await box.getItem(file.key))!)!;
}

/** Moves it out (with its file parts). Kept in history, so `restoreThing` brings it back, and `purgeKeys(box, keysOf(thing))` frees the space now. */
export async function removeThing(box: Box, thing: Thing): Promise<void> {
  // The thing first, so a half-done delete never leaves a file without its bytes.
  await box.delete(thing.key);
  const parts = keysOf(thing).slice(1);
  for (let i = 0; i < parts.length; i += 200) await box.batch(parts.slice(i, i + 200).map((key) => ({ op: "delete" as const, key })));
}

export async function restoreThing(box: Box, thing: Thing): Promise<void> {
  for (const key of keysOf(thing).slice(1)) await box.undo(key);
  await box.undo(thing.key);
}

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

/** A connection that dropped, or a server that's busy or restarting: worth trying again. */
function passing(err: unknown): boolean {
  const e = err as { code?: string; status?: number };
  return e.code === "unreachable" || e.code === "slow_down" || (typeof e.status === "number" && e.status >= 500);
}

const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(timer), reject(signal.reason)), { once: true });
  });

/** Runs `fn`, trying again a few times (waiting longer each time) when the connection drops. */
async function patiently<T>(fn: () => Promise<T>, signal?: AbortSignal, firstWaitMs = 1000, tries = 5): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= tries || !passing(err) || signal?.aborted) throw err;
      await wait(firstWaitMs * 3 ** (attempt - 1), signal);
    }
  }
}

/** Why an upload stopped part way, and what's needed to carry on from there. */
export interface UploadStopped {
  /** The file's id: pass it back as `continueId` with the same file to send only what's missing. */
  id: string;
  /** How much of it the box already has. */
  sentBytes: number;
}

/**
 * Seals a file into the box a part at a time (so it never has to fit in
 * memory), then writes the entry that lists it, so a file never shows up half
 * sent. A dropped connection is tried again a few times. If it still fails,
 * the parts already sent are removed, unless `keepPartsOnError`: then the
 * error carries `stopped` ({ id, sentBytes }), and calling again with the same
 * file and `continueId: id` sends only the parts that are missing. Stopping it
 * (the signal) always removes what was sent.
 */
export async function addFile(
  box: Box,
  file: Blob,
  options: {
    name?: string;
    type?: string;
    title?: string;
    notes?: string;
    sentFrom?: string;
    signal?: AbortSignal;
    onProgress?: (fraction: number, bytes: number) => void;
    continueId?: string;
    keepPartsOnError?: boolean;
    /** How long to wait before the first try again (then three times longer each time). */
    retryMs?: number;
  } = {},
): Promise<Thing<FileValue>> {
  const name = (options.name ?? (file as File).name ?? "file").slice(0, 500) || "file";
  const size = file.size;
  if (size > MAX_FILE_BYTES) {
    throw fail("file_too_big", 413, `${name} is ${formatBytes(size)}; a file can be at most ${formatBytes(MAX_FILE_BYTES)}.`, "Split it, or keep a smaller copy.");
  }
  const id = options.continueId && /^[\w-]{8,40}$/.test(options.continueId) ? options.continueId : sortableId(Date.now());
  const parts = Math.max(1, Math.ceil(size / FILE_PART_BYTES));
  const hashes = new Uint8Array(parts * 32);
  // Carrying on: the parts the box already has (from the same file, cut off before) aren't sent again.
  const have = new Set<number>();
  if (options.continueId) {
    for (const key of await patiently(() => box.keys(`${FILE_DATA}${id}/`), options.signal, options.retryMs)) {
      const n = Number(key.slice(`${FILE_DATA}${id}/`.length));
      if (Number.isInteger(n) && n < parts) have.add(n);
    }
  }
  const sent: string[] = [...have].map((n) => filePartKey(id, n));
  let done = have.size;
  try {
    for (let first = 0; first < parts; first += PARTS_PER_REQUEST) {
      options.signal?.throwIfAborted();
      const ops: Array<{ op: "put"; key: string; value: Uint8Array }> = [];
      for (let n = first; n < Math.min(parts, first + PARTS_PER_REQUEST); n++) {
        const bytes = new Uint8Array(await file.slice(n * FILE_PART_BYTES, (n + 1) * FILE_PART_BYTES).arrayBuffer());
        hashes.set(await sha256(bytes), n * 32);
        if (!have.has(n)) ops.push({ op: "put" as const, key: filePartKey(id, n), value: bytes });
      }
      if (ops.length) {
        await patiently(() => box.batch(ops), options.signal, options.retryMs);
        sent.push(...ops.map((o) => o.key));
        done += ops.length;
      }
      options.onProgress?.(done / parts, Math.min(size, done * FILE_PART_BYTES));
    }
    options.signal?.throwIfAborted();
    const value: FileValue = {
      title: text(options.title, 500).trim() || name,
      name,
      type: (options.type ?? file.type ?? "").slice(0, 200),
      size,
      parts,
      partSize: FILE_PART_BYTES,
      sha256: hex(await sha256(hashes)),
      hashOf: "parts",
      notes: text(options.notes),
      ...(options.sentFrom !== undefined ? { inbox: true as const, from: options.sentFrom.slice(0, 100) } : {}),
    };
    const key = thingKey("file", id);
    await patiently(() => box.put(key, value, { ifVersion: 0 }), options.signal, options.retryMs);
    // A link that may only add (a collection box) can't read it back: what it wrote is what's there.
    const item = await box.getItem(key).catch((err) => {
      if ((err as { code?: string }).code === "write_only") return null;
      throw err;
    });
    if (!item) return { kind: "file", id, key, value, version: 1, createdAt: Date.now(), updatedAt: Date.now() };
    return toThing(item)! as Thing<FileValue>;
  } catch (err) {
    if (options.keepPartsOnError && !options.signal?.aborted && passing(err)) {
      (err as { stopped?: UploadStopped }).stopped = { id, sentBytes: Math.min(size, done * FILE_PART_BYTES) };
      throw err;
    }
    for (let i = 0; i < sent.length; i += 200) {
      const chunk = sent.slice(i, i + 200);
      // Gone for good when allowed; an app or link may only delete (history then lets them go in time).
      await box.batch(chunk.map((key) => ({ op: "delete" as const, key, purge: true }))).catch(() => box.batch(chunk.map((key) => ({ op: "delete" as const, key }))).catch(() => {}));
    }
    throw err;
  }
}

function layout(file: FileValue) {
  const partSize = file.partSize ?? LEGACY_PART_BYTES;
  if (!(partSize > 0) || file.parts !== Math.max(1, Math.ceil(file.size / partSize))) throw damaged(file);
  return { partSize, length: (n: number) => (n < file.parts - 1 ? partSize : file.size - (file.parts - 1) * partSize) };
}

const damaged = (file: FileValue) => fail("file_damaged", 422, `${file.name} doesn't match what was saved.`, "Upload it again.");

/** Parts first..last of a file, opened and checked for their length. */
async function readParts(box: Box, file: Thing<FileValue>, first: number, last: number): Promise<Uint8Array[]> {
  const { length } = layout(file.value);
  const keys = Array.from({ length: last - first + 1 }, (_, i) => filePartKey(file.id, first + i));
  const found = new Map((await box.getMany(keys)).map((item) => [item.key, item.value]));
  return keys.map((key, i) => {
    const raw = found.get(key);
    if (raw === undefined) throw fail("file_incomplete", 404, `Part of ${file.value.name} is missing.`, "Undo its last change, or upload it again.");
    const bytes = raw instanceof Uint8Array ? raw : typeof raw === "string" ? fromB64u(raw) : null;
    if (!bytes || bytes.length !== length(first + i)) throw damaged(file.value);
    return bytes;
  });
}

/** Bytes start..end (inclusive) of a file, fetching only the parts they're in: what playing from the middle of a video needs. */
export async function readRange(box: Box, file: Thing<FileValue>, start: number, end: number): Promise<Uint8Array> {
  const { size } = file.value;
  if (!(start >= 0 && end >= start && end < size)) throw fail("bad_range", 416, `Bytes ${start}–${end} aren't in ${file.value.name} (${size} bytes).`);
  const { partSize } = layout(file.value);
  const first = Math.floor(start / partSize);
  const last = Math.floor(end / partSize);
  const out = new Uint8Array(end - start + 1);
  let at = 0;
  const parts = await readParts(box, file, first, last);
  parts.forEach((part, i) => {
    const offset = (first + i) * partSize;
    const piece = part.subarray(Math.max(0, start - offset), Math.min(part.length, end - offset + 1));
    out.set(piece, at);
    at += piece.length;
  });
  return out;
}

/**
 * A whole file, a part at a time, checked against its hash at the end (the
 * last step throws if it doesn't match). Only a few parts are in memory at once.
 */
export async function* fileChunks(box: Box, file: Thing<FileValue>, onProgress?: (fraction: number) => void): AsyncGenerator<Uint8Array> {
  const { parts, sha256: expected, hashOf } = file.value;
  layout(file.value);
  const hashes = new Uint8Array(parts * 32);
  // Files from before 0.6 (100 MB at most) were hashed whole.
  const whole: Uint8Array[] = [];
  for (let first = 0; first < parts; first += PARTS_PER_REQUEST) {
    const chunk = await readParts(box, file, first, Math.min(parts, first + PARTS_PER_REQUEST) - 1);
    for (const [i, part] of chunk.entries()) {
      if (hashOf === "parts") hashes.set(await sha256(part), (first + i) * 32);
      else whole.push(part);
      yield part;
    }
    onProgress?.(Math.min(1, (first + chunk.length) / parts));
  }
  const actual = hashOf === "parts" ? await sha256(hashes) : await sha256(concat(whole));
  if (expected && hex(actual) !== expected) throw damaged(file.value);
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** A whole file in memory, checked against its hash: for previews, and for handing to the phone's share sheet. */
export async function readFile(box: Box, file: Thing<FileValue>, onProgress?: (fraction: number) => void): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of fileChunks(box, file, onProgress)) chunks.push(chunk);
  return concat(chunks);
}

/**
 * Parts left behind by an upload that never finished (the page was closed
 * part way): parts with no file listing them, untouched for 6 hours, so an
 * upload still running on another device is left alone.
 */
export async function strayParts(box: Box, things: Thing[], now = Date.now(), keep: Iterable<string> = []): Promise<string[]> {
  const files = new Set([...things.filter((t) => t.kind === "file").map((t) => t.id), ...keep]);
  const byId = new Map<string, { keys: string[]; newest: number }>();
  for (const entry of await box.list(FILE_DATA, { limit: Infinity })) {
    const id = entry.key.slice(FILE_DATA.length).split("/")[0]!;
    if (files.has(id)) continue;
    const group = byId.get(id) ?? { keys: [], newest: 0 };
    group.keys.push(entry.key);
    group.newest = Math.max(group.newest, entry.updatedAt);
    byId.set(id, group);
  }
  // Two days' grace: an upload cut off on another device may still be carried on.
  return [...byId.values()].filter((g) => g.newest < now - 2 * 24 * 60 * 60 * 1000).flatMap((g) => g.keys);
}

/** Removes things for good (no undo), with their file parts: frees the space now rather than when their history runs out. */
export async function purgeKeys(box: Box, keys: string[]): Promise<void> {
  for (let i = 0; i < keys.length; i += 200) await box.batch(keys.slice(i, i + 200).map((key) => ({ op: "delete" as const, key, purge: true })));
}

export function keysOf(thing: Thing): string[] {
  return [thing.key, ...(thing.kind === "file" ? Array.from({ length: (thing.value as FileValue).parts }, (_, i) => filePartKey(thing.id, i)) : [])];
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
