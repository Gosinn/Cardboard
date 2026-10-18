/**
 * Cardboard SDK: one import, zero dependencies, works in Node and the browser.
 *
 *   import { open } from "cardboard";
 *   const box = open();                       // reads CARDBOARD_URL + CARDBOARD_TAPE (env or .env)
 *   await box.put("settings/theme", "dark");
 *   const notes = box.collection<Note>("notes");
 *   await notes.add({ title: "Buy milk", done: false });
 *   await notes.find({ where: { done: false }, sort: "-$createdAt" });
 *
 * Everything is sealed right here, before it leaves your app: the Cardboard
 * server only ever stores what it can't open. Key names, values, parcels:
 * all of it. The smart parts (spotting secrets, queries, customs at docks)
 * run here too, on the opened data.
 */
import { CardboardError, fail } from "../shared/errors.ts";
import type { Duration } from "../shared/duration.ts";
import { ctx } from "../shared/contexts.ts";
import { inspect, type CustomsPolicy } from "../shared/customs.ts";
import { isPlainObject, mergePatch, sortableId, validateKey, type Item } from "../shared/data.ts";
import { notice, scan, SECRET_KINDS, type Finding } from "../shared/detect.ts";
import { matches, sortItems, type Where } from "../shared/query.ts";
import { fromB64u, open as openSealed, openJson, openText, seal, sealJson, toB64u } from "../client/crypto.ts";
import { boxKeys, dockIndex, dockKeys, itemIndex, namesKeys, newClientId, readBundle, type BoxKeys, type DockKeys, type NamesKeys } from "../client/keys.ts";
import { Rpc, toError, type ErrorBody } from "../client/rpc.ts";

export { CardboardError };
export type { Duration, Item, Where };

export interface OpenOptions {
  /** Defaults to CARDBOARD_URL, then http://127.0.0.1:8787. */
  url?: string;
  /** Defaults to CARDBOARD_TAPE. */
  tape?: string;
  fetch?: typeof fetch;
  /**
   * Called when Cardboard spots something sensitive you just stored (an API
   * key, a plain-text password…). Defaults to console.warn, once per message.
   * Pass false to silence.
   */
  onNotice?: ((notice: string, key: string) => void) | false;
  /** Gets a fresh access token when this one expires (used by Sign in with Cardboard sessions). */
  refresh?: () => Promise<string>;
  /** The box key itself, for Sign in with Cardboard sessions (which get it sealed to the app). */
  keys?: { boxId: string; box: Uint8Array; names: Uint8Array };
}

export interface ListEntry {
  key: string;
  size: number;
  version: number;
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null;
}

export interface WriteOptions {
  /** "30d", "12h", seconds as a number, or null for "keep forever". */
  ttl?: Duration | null;
  /** Only write if the item is still at this version (0 = only if it doesn't exist yet). */
  ifVersion?: number;
}

export interface WriteResult {
  key: string;
  version: number;
  notices: string[];
}

export interface QueryOptions {
  prefix?: string;
  where?: Where;
  /** "title", "-stars", ["-stars", "title"]; "$createdAt" / "$updatedAt" / "$key" sort by metadata. */
  sort?: string | string[];
  limit?: number;
  offset?: number;
}

export interface Change<T = unknown> {
  type: "put" | "delete";
  key: string;
  version: number | null;
  at: number;
  value?: T;
  reason?: "expired" | "purged";
}

export interface Version<T = unknown> {
  version: number;
  at: number;
  deleted: boolean;
  value?: T;
  size: number;
  actor: string;
}

export type BatchOp =
  | { op: "put"; key: string; value: unknown; ttl?: Duration | null; ifVersion?: number }
  | { op: "patch"; key: string; value: Record<string, unknown>; ttl?: Duration | null }
  | { op: "add"; collection: string; value: Record<string, unknown>; ttl?: Duration | null }
  | { op: "delete"; key: string; purge?: boolean };

export interface Watcher {
  close(): void;
}

export interface WatchOptions {
  onReady?: () => void;
  /** Connection problems are retried automatically; this hears about them. */
  onError?: (error: Error) => void;
}

export interface AppProfile {
  title?: string;
  description?: string;
  url?: string;
  version?: string;
}

export interface BoxSettings {
  origins: string[];
  quotaBytes: number;
  maxItemBytes: number;
  historyDays: number;
  secrets: "warn" | "block";
  defaultTtlMs: number | null;
}

export type Doc<T> = T & { id: string };

interface WireItem {
  idx: string;
  name: string;
  value?: string;
  version: number;
  size: number;
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null;
}

interface Opened {
  boxId: string;
  keys: BoxKeys;
  names: NamesKeys;
  settings: BoxSettings | null;
}

interface MaybeProcess {
  env?: Record<string, string | undefined>;
  cwd?: () => string;
  getBuiltinModule?: (id: string) => unknown;
}

const proc = (globalThis as { process?: MaybeProcess }).process;
const TAPE = /^cbt_([A-Za-z0-9_-]{86})$/;
const MAX_PATCH_RETRIES = 5;
let warnedBrowser = false;

/** Reads only CARDBOARD_URL and CARDBOARD_TAPE from ./.env, without touching process.env. */
function readDotEnv(): Record<string, string> {
  if (typeof proc?.getBuiltinModule !== "function" || typeof proc.cwd !== "function") return {};
  try {
    const fs = proc.getBuiltinModule("node:fs") as { readFileSync(path: string, enc: "utf8"): string };
    const text = fs.readFileSync(`${proc.cwd()}/.env`, "utf8");
    const out: Record<string, string> = {};
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?(CARDBOARD_URL|CARDBOARD_TAPE)\s*=\s*(.*?)\s*$/.exec(line);
      if (match) out[match[1]!] = match[2]!.replace(/^(['"])(.*)\1$/, "$2");
    }
    return out;
  } catch {
    return {};
  }
}

/** A tape is two halves: the token the server checks, and the key that never leaves your app. */
export function splitTape(tape: string): { token: string; key: Uint8Array } {
  const match = TAPE.exec(tape.trim());
  if (!match) {
    throw new CardboardError(
      "bad_tape",
      0,
      "That doesn't look like a Cardboard tape.",
      "Tapes start with cbt_ and have 86 more characters. Make one with: cardboard connect <app>",
    );
  }
  const bytes = fromB64u(match[1]!);
  return { token: `cbt_${toB64u(bytes.subarray(0, 32))}`, key: bytes.slice(32) };
}

export function open(options: OpenOptions = {}): Box {
  return new Box(options);
}

type KeySource =
  | { kind: "tape"; key: Uint8Array }
  | { kind: "bundle"; boxId: string; box: Uint8Array; names: Uint8Array }
  | { kind: "owned"; opened: Opened };

interface InternalOptions extends OpenOptions {
  /** Your own device opening one of your boxes (the CLI and dashboard). */
  owned?: { rpc: Rpc; opened: Opened };
}

export class Box {
  readonly url: string;
  private readonly rpc: Rpc;
  /** Added to every request: devices name the box, an app's tape already implies it. */
  private readonly scope: Record<string, unknown>;
  private readonly source: KeySource;
  private readonly refreshToken: (() => Promise<string>) | undefined;
  private readonly onNotice: ((notice: string, key: string) => void) | false;
  private readonly seenNotices = new Set<string>();
  private opened: Promise<Opened> | null = null;

  constructor(options: OpenOptions = {}) {
    const owned = (options as InternalOptions).owned;
    this.refreshToken = options.refresh;
    this.onNotice = options.onNotice ?? ((message) => console.warn(`[cardboard] ${message}`));
    if (owned) {
      this.url = owned.rpc.url;
      this.rpc = owned.rpc;
      this.scope = { box: owned.opened.boxId };
      this.source = { kind: "owned", opened: owned.opened };
      return;
    }
    const dotenv = options.url && (options.tape || options.keys) ? {} : readDotEnv();
    const url = options.url ?? proc?.env?.["CARDBOARD_URL"] ?? dotenv["CARDBOARD_URL"] ?? "http://127.0.0.1:8787";
    const tape = options.tape ?? proc?.env?.["CARDBOARD_TAPE"] ?? dotenv["CARDBOARD_TAPE"];
    if (!tape) {
      throw new CardboardError("no_tape", 0, "No tape found for Cardboard.", "Run `cardboard connect <app-name>` in your app's folder, or pass { tape } to open().");
    }
    this.url = url.replace(/\/+$/, "");
    this.scope = {};
    if (options.keys) {
      // A Sign in with Cardboard session: the token is an access token, the keys came sealed to the app.
      this.rpc = new Rpc(this.url, tape, options.fetch);
      this.source = { kind: "bundle", ...options.keys };
    } else {
      const { token, key } = splitTape(tape);
      this.rpc = new Rpc(this.url, token, options.fetch);
      this.source = { kind: "tape", key };
      if (typeof (globalThis as { document?: unknown }).document !== "undefined" && !warnedBrowser) {
        warnedBrowser = true;
        console.warn(
          "[cardboard] This tape is being used in a browser, where anyone using the page can read it, key half included. " +
            "Prefer Sign in with Cardboard, a read-only tape, or calling Cardboard from your server.",
        );
      }
    }
  }

  /** @internal Your own device opening one of your boxes (the CLI and dashboard use this). */
  static owned(rpc: Rpc, boxId: string, keys: BoxKeys, names: NamesKeys, settings: BoxSettings): Box {
    return new Box({ owned: { rpc, opened: { boxId, keys, names, settings } } } as InternalOptions);
  }

  /** @internal Sends one operation (with a fresh token, if this one expired). */
  async request<T>(op: string, body: Record<string, unknown> = {}): Promise<T> {
    try {
      return await this.rpc.call<T>(op, { ...body, ...this.scope });
    } catch (err) {
      if (err instanceof CardboardError && err.status === 401 && this.refreshToken) {
        this.rpc.token = await this.refreshToken();
        return this.rpc.call<T>(op, { ...body, ...this.scope });
      }
      throw err;
    }
  }

  /** @internal The box's keys, opened from the tape (once). */
  ready(): Promise<Opened> {
    this.opened ??= this.openKeys();
    this.opened.catch(() => {
      this.opened = null;
    });
    return this.opened;
  }

  private async openKeys(): Promise<Opened> {
    const source = this.source;
    if (source.kind === "owned") return source.opened;
    const who = await this.request<{ box: { id: string; settings: BoxSettings }; bundle: string | null }>("whoami");
    if (source.kind === "bundle") {
      if (who.box.id !== source.boxId) throw new CardboardError("wrong_box", 0, "This sign-in's token belongs to a different box than its keys.");
      return { boxId: source.boxId, keys: await boxKeys(source.box), names: await namesKeys(source.names), settings: who.box.settings };
    }
    if (!who.bundle) throw new CardboardError("no_keys", 0, "This tape doesn't carry the box key.", "Make a new tape with: cardboard tape <box>");
    const bundle = readBundle(await openJson(source.key, fromB64u(who.bundle), ctx.tapeBundle(who.box.id)));
    if (bundle.boxId !== who.box.id) throw new CardboardError("locked", 0, "This tape's key doesn't belong to this box.");
    return { boxId: who.box.id, keys: await boxKeys(bundle.box), names: await namesKeys(bundle.names), settings: who.box.settings };
  }

  // ── Sealing ──────────────────────────────────────────────────────────────

  private async sealItem(o: Opened, key: string, value: unknown) {
    validateKey(key);
    if (value === undefined) throw fail("missing_value", 400, "Nothing to store: the value is undefined.");
    const idx = await itemIndex(o.keys, key);
    const [name, sealedValue] = await Promise.all([
      seal(o.keys.seal, key, ctx.itemName(o.boxId, idx)),
      seal(o.keys.seal, JSON.stringify(value), ctx.itemValue(o.boxId, idx)),
    ]);
    return { idx, name: toB64u(name), value: toB64u(sealedValue) };
  }

  private async openItem<T>(o: Opened, wire: WireItem): Promise<Item<T>> {
    const key = await openText(o.keys.seal, fromB64u(wire.name), ctx.itemName(o.boxId, wire.idx));
    const value = wire.value !== undefined ? (JSON.parse(await openText(o.keys.seal, fromB64u(wire.value), ctx.itemValue(o.boxId, wire.idx))) as T) : (undefined as T);
    return { key, value, version: wire.version, size: wire.size, createdAt: wire.createdAt, updatedAt: wire.updatedAt, expiresAt: wire.expiresAt };
  }

  /** Looks for secrets before anything is sealed, and refuses them if the box says so. */
  private check(o: Opened, key: string, value: unknown): { findings: Finding[]; notices: string[] } {
    const findings = scan(value);
    if (o.settings?.secrets === "block") {
      const secret = findings.find((f) => SECRET_KINDS.has(f.kind));
      if (secret) throw fail("secret_blocked", 422, notice(secret), "This box is set to refuse secrets. Store a hash instead, or keep the key out of app data.");
    }
    return { findings, notices: findings.filter((f) => f.kind !== "email" && f.kind !== "phone").map(notice) };
  }

  private async detail(o: Opened, notices: string[]): Promise<string | undefined> {
    if (notices.length === 0) return undefined;
    return toB64u(await sealJson(o.keys.seal, { notices: notices.slice(0, 5) }, ctx.logNote(o.boxId)));
  }

  private notify(key: string, notices: string[]) {
    if (!this.onNotice) return;
    for (const message of notices) {
      const id = `${key}\u0000${message}`;
      if (this.seenNotices.has(id)) continue;
      this.seenNotices.add(id);
      this.onNotice(message, key);
    }
  }

  // ── Items ────────────────────────────────────────────────────────────────

  /** Which box this is, this tape's permissions, and how much is stored. */
  async whoami(): Promise<{ box: string; items: number; bytes: number; tape: Record<string, unknown> }> {
    const who = await this.request<{ box: { id: string }; items: number; bytes: number; tape: Record<string, unknown> }>("whoami");
    return { box: who.box.id, items: who.items, bytes: who.bytes, tape: who.tape };
  }

  /** The value at `key`, or null if there's nothing there. */
  async get<T = unknown>(key: string): Promise<T | null> {
    const item = await this.getItem<T>(key);
    return item ? item.value : null;
  }

  /** Like get, but with version and timestamps. */
  async getItem<T = unknown>(key: string): Promise<Item<T> | null> {
    validateKey(key);
    const o = await this.ready();
    const { item } = await this.request<{ item: WireItem | null }>("get", { idx: await itemIndex(o.keys, key) });
    return item ? this.openItem<T>(o, item) : null;
  }

  async has(key: string): Promise<boolean> {
    return (await this.getItem(key)) !== null;
  }

  async put<T>(key: string, value: T, options: WriteOptions = {}): Promise<WriteResult> {
    const o = await this.ready();
    const { notices } = this.check(o, key, value);
    const sealed = await this.sealItem(o, key, value);
    const result = await this.request<{ version: number }>("put", { ...sealed, ...writeBody(options), detail: await this.detail(o, notices) });
    this.notify(key, notices);
    return { key, version: result.version, notices };
  }

  /** Merges `changes` into the object at `key` (null removes a field). Returns the merged object. */
  async patch<T extends Record<string, unknown>>(key: string, changes: Partial<{ [K in keyof T]: T[K] | null }>, options: WriteOptions = {}): Promise<T> {
    if (!isPlainObject(changes)) throw fail("bad_patch", 400, "A patch must be an object, like { done: true }.");
    for (let attempt = 0; ; attempt++) {
      const current = await this.getItem(key);
      if (current && !isPlainObject(current.value)) throw fail("not_an_object", 409, `"${key}" isn't an object, so it can't be patched.`, "Use put to replace it.");
      if (options.ifVersion !== undefined && (current?.version ?? 0) !== options.ifVersion) {
        throw fail("version_conflict", 409, `"${key}" changed since you read it.`, "Read it again and retry.");
      }
      const value = mergePatch(current?.value ?? {}, changes) as T;
      const ttl = options.ttl !== undefined ? options.ttl : current?.expiresAt ? Math.max(1, Math.ceil((current.expiresAt - Date.now()) / 1000)) : undefined;
      try {
        await this.put(key, value, { ttl, ifVersion: current?.version ?? 0 });
        return value;
      } catch (err) {
        // Someone else wrote in between: read again and merge again.
        if (!(err instanceof CardboardError) || (err.code !== "version_conflict" && err.code !== "already_exists") || attempt >= MAX_PATCH_RETRIES) throw err;
      }
    }
  }

  /** Deletes `key`. It stays in history (undo brings it back) unless `purge` is set. */
  async delete(key: string, options: { purge?: boolean } = {}): Promise<boolean> {
    validateKey(key);
    const o = await this.ready();
    const { deleted } = await this.request<{ deleted: boolean }>("delete", { idx: await itemIndex(o.keys, key), purge: options.purge });
    return deleted;
  }

  /** @internal Every live item, opened. */
  private async fetchAll(withValues: boolean): Promise<Item[]> {
    const o = await this.ready();
    const out: Item[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await this.request<{ items: WireItem[]; next: string | null }>("list", { after, limit: 1000, values: withValues });
      out.push(...(await Promise.all(page.items.map((i) => this.openItem(o, i)))));
      if (!page.next) break;
      after = page.next;
    }
    return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  /** Every item under `prefix`, opened, sorted by key. Fine at personal scale (tens of thousands of items). */
  async items<T = unknown>(prefix = ""): Promise<Item<T>[]> {
    return (await this.fetchAll(true)).filter((i) => i.key.startsWith(prefix)) as Item<T>[];
  }

  /** Every key under `prefix`, with metadata. */
  async list(prefix = "", options: { limit?: number } = {}): Promise<ListEntry[]> {
    const all = (await this.fetchAll(false)).filter((i) => i.key.startsWith(prefix));
    return all.slice(0, options.limit ?? 10_000).map(({ key, size, version, createdAt, updatedAt, expiresAt }) => ({ key, size, version, createdAt, updatedAt, expiresAt }));
  }

  async keys(prefix = ""): Promise<string[]> {
    return (await this.list(prefix)).map((e) => e.key);
  }

  /** Search values: { where: { done: false, stars: { $gte: 4 } }, sort: "-stars", limit: 20 }. Runs here, on opened data. */
  async query<T = unknown>(options: QueryOptions = {}): Promise<{ items: Item<T>[]; total: number }> {
    if (options.where !== undefined && !isPlainObject(options.where)) throw fail("bad_query", 400, "`where` must be an object, like { done: false }.");
    const found = (await this.items<T>(options.prefix ?? "")).filter((item) => matches(item.value, options.where));
    const sorted = sortItems(found, options.sort);
    const offset = Math.max(0, Math.floor(options.offset ?? 0));
    const limit = Math.min(10_000, Math.max(1, Math.floor(options.limit ?? 100)));
    return { items: sorted.slice(offset, offset + limit), total: sorted.length };
  }

  /** Past versions of `key`, newest first. */
  async history<T = unknown>(key: string): Promise<Version<T>[]> {
    validateKey(key);
    const o = await this.ready();
    const idx = await itemIndex(o.keys, key);
    const { versions } = await this.request<{ versions: Array<{ version: number; at: number; deleted: boolean; value: string | null; size: number; actor: string }> }>("history", { idx });
    return Promise.all(
      versions.map(async (v) => ({
        version: v.version,
        at: v.at,
        deleted: v.deleted,
        ...(v.value ? { value: JSON.parse(await openText(o.keys.seal, fromB64u(v.value), ctx.itemValue(o.boxId, idx))) as T } : {}),
        size: v.size,
        actor: v.actor,
      })),
    );
  }

  /** Puts `key` back to its previous version (or version `to`). Undo again to redo. */
  async undo(key: string, options: { to?: number } = {}): Promise<{ key: string; version: number; restored: number; deleted: boolean }> {
    validateKey(key);
    const o = await this.ready();
    const result = await this.request<{ version: number; restored: number; deleted: boolean }>("undo", { idx: await itemIndex(o.keys, key), to: options.to });
    return { key, ...result };
  }

  /** Several writes that all happen, or none do. */
  async batch(ops: BatchOp[]): Promise<Array<Record<string, unknown>>> {
    const o = await this.ready();
    const allNotices: string[] = [];
    const planned = await Promise.all(
      ops.map(async (op) => {
        switch (op.op) {
          case "put": {
            const { notices } = this.check(o, op.key, op.value);
            allNotices.push(...notices);
            return { wire: { op: "put", ...(await this.sealItem(o, op.key, op.value)), ...writeBody(op) }, out: { op: "put", key: op.key, notices } };
          }
          case "patch": {
            const current = await this.getItem(op.key);
            const value = mergePatch(current?.value ?? {}, op.value);
            const { notices } = this.check(o, op.key, value);
            allNotices.push(...notices);
            return { wire: { op: "put", ...(await this.sealItem(o, op.key, value)), ...writeBody(op), ifVersion: current?.version ?? 0 }, out: { op: "patch", key: op.key, notices } };
          }
          case "add": {
            const { key, id, doc } = collectionDoc(op.collection, op.value);
            const { notices } = this.check(o, key, doc);
            allNotices.push(...notices);
            return { wire: { op: "put", ...(await this.sealItem(o, key, doc)), ...writeBody(op), ifVersion: 0 }, out: { op: "add", key, id, notices } };
          }
          case "delete":
            validateKey(op.key);
            return { wire: { op: "delete", idx: await itemIndex(o.keys, op.key), purge: op.purge }, out: { op: "delete", key: op.key } };
          default:
            throw fail("bad_batch", 400, `Unknown batch op "${String((op as { op: unknown }).op)}". Use put, patch, add or delete.`);
        }
      }),
    );
    const { results } = await this.request<{ results: Array<Record<string, unknown>> }>("batch", { ops: planned.map((p) => p.wire), detail: await this.detail(o, allNotices) });
    return results.map((r, i) => {
      const out = planned[i]!.out as Record<string, unknown> & { key: string; notices?: string[] };
      if (out.notices) this.notify(out.key, out.notices);
      const { op: _op, idx: _idx, ...rest } = r;
      return { ...out, ...rest };
    });
  }

  /** Adds a document under `collection/` with a generated, time-ordered id (or its own `id`). */
  async add<T extends object>(collection: string, doc: T & { id?: string }, options: { ttl?: Duration | null } = {}): Promise<WriteResult & { id: string }> {
    const { key, id, doc: full } = collectionDoc(collection, doc as Record<string, unknown>);
    const result = await this.put(key, full, { ttl: options.ttl, ifVersion: 0 });
    return { ...result, id };
  }

  /** A collection of documents under `name/`, with generated, time-ordered ids. */
  collection<T extends object = Record<string, unknown>>(name: string): Collection<T> {
    return new Collection<T>(this, name);
  }

  /**
   * Live changes under `prefix` (or the whole box). Reconnects by itself;
   * stops for good if the tape is revoked or not allowed to read.
   */
  watch<T = unknown>(prefix: string, onChange: (change: Change<T>) => void, options?: WatchOptions): Watcher;
  watch<T = unknown>(onChange: (change: Change<T>) => void, options?: WatchOptions): Watcher;
  watch<T = unknown>(a: string | ((change: Change<T>) => void), b?: ((change: Change<T>) => void) | WatchOptions, c?: WatchOptions): Watcher {
    const prefix = typeof a === "string" ? a : "";
    const onChange = (typeof a === "function" ? a : b) as (change: Change<T>) => void;
    const options = (typeof a === "function" ? b : c) as WatchOptions | undefined;
    let queue = Promise.resolve();
    return this.stream("watch", {}, {
      onReady: () => options?.onReady?.(),
      onError: options?.onError,
      onEvent: (type, data) => {
        if (type !== "change") return;
        // Opening is async; a queue keeps changes in the order they happened.
        queue = queue.then(async () => {
          const o = await this.ready();
          const raw = JSON.parse(data) as { type: "put" | "delete"; idx: string; name: string | null; value?: string; version: number | null; at: number; reason?: "expired" | "purged" };
          if (!raw.name) return;
          const key = await openText(o.keys.seal, fromB64u(raw.name), ctx.itemName(o.boxId, raw.idx));
          if (!key.startsWith(prefix)) return;
          const change: Change<T> = { type: raw.type, key, version: raw.version, at: raw.at };
          if (raw.value) change.value = JSON.parse(await openText(o.keys.seal, fromB64u(raw.value), ctx.itemValue(o.boxId, raw.idx))) as T;
          if (raw.reason) change.reason = raw.reason;
          onChange(change);
        }).catch((err) => (options?.onError ? options.onError(err as Error) : console.warn(`[cardboard] watch: ${(err as Error).message}`)));
      },
    });
  }

  /** A dock: swap data with other apps without either side learning who the other is. */
  dock(name: string): Dock {
    return new Dock(this, name);
  }

  /** Tell Cardboard who this app is, so you recognise it on your shelf. Sealed, like everything else. */
  async introduce(profile: AppProfile): Promise<{ profile: AppProfile }> {
    const limits: Record<keyof AppProfile, number> = { title: 60, description: 200, url: 200, version: 40 };
    const clean: AppProfile = {};
    for (const [field, value] of Object.entries(profile)) {
      if (!(field in limits)) throw fail("bad_profile", 400, `Unknown profile field "${field}". Use title, description, url and version.`);
      const k = field as keyof AppProfile;
      if (value === undefined || value === null || value === "") continue;
      if (typeof value !== "string" || value.length > limits[k]) throw fail("bad_profile", 400, `\`${field}\` must be text of at most ${limits[k]} characters.`);
      if (k === "url" && !/^https?:\/\//.test(value)) throw fail("bad_profile", 400, "`url` must start with http:// or https://.");
      clean[k] = value;
    }
    const o = await this.ready();
    await this.request("introduce", { profile: toB64u(await sealJson(o.keys.seal, clean, ctx.boxProfile(o.boxId))) });
    return { profile: clean };
  }

  /**
   * @internal Opens a server-sent event stream that reconnects by itself.
   * Client errors stop it, unless `keepTrying` says the error is worth waiting out.
   */
  stream(
    op: string,
    body: unknown,
    handlers: {
      onEvent: (type: string, data: string) => void;
      onReady?: (data: string) => void;
      onError?: ((error: Error) => void) | undefined;
      keepTrying?: (error: CardboardError) => boolean;
      maxDelayMs?: number;
    },
  ): Watcher {
    const controller = new AbortController();
    let closed = false;
    const report = (err: unknown) => {
      if (closed) return;
      const error = err instanceof Error ? err : new Error(String(err));
      if (handlers.onError) handlers.onError(error);
      else console.warn(`[cardboard] ${op}: ${error.message}`);
    };

    const run = async () => {
      let delay = 1000;
      let justRefreshed = false;
      while (!closed) {
        try {
          const res = await this.rpc.fetchImpl(`${this.url}/v1/${op}`, {
            method: "POST",
            headers: { authorization: `Bearer ${this.rpc.token}`, "content-type": "application/json" },
            body: JSON.stringify(typeof body === "function" ? await (body as () => Promise<unknown>)() : body),
            signal: controller.signal,
          });
          if (res.status === 401 && this.refreshToken && !justRefreshed) {
            justRefreshed = true;
            try {
              this.rpc.token = await this.refreshToken();
            } catch (err) {
              report(err);
              closed = true;
              return;
            }
            continue;
          }
          justRefreshed = false;
          if (!res.ok || !res.body) {
            const error = toError(res.status, (await res.json().catch(() => null)) as ErrorBody);
            const transient = res.status >= 500 || res.status === 429;
            if (!transient && !handlers.keepTrying?.(error)) {
              report(error);
              closed = true;
              return;
            }
            if (transient) throw error;
          } else {
            delay = 1000;
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              let end: number;
              while ((end = buffer.indexOf("\n\n")) >= 0) {
                const event = parseEvent(buffer.slice(0, end));
                buffer = buffer.slice(end + 2);
                try {
                  if (event.type === "ready") handlers.onReady?.(event.data);
                  else handlers.onEvent(event.type, event.data);
                } catch (err) {
                  report(err);
                }
              }
            }
          }
        } catch (err) {
          if (closed) return;
          report(err);
        }
        if (closed) return;
        await sleep(delay, controller.signal);
        delay = Math.min(delay * 2, handlers.maxDelayMs ?? 30_000);
      }
    };
    void run();
    return {
      close() {
        closed = true;
        controller.abort();
      },
    };
  }
}

function collectionDoc(collection: string, doc: Record<string, unknown>): { key: string; id: string; doc: Record<string, unknown> } {
  if (typeof collection !== "string" || !/^[^/\s][^\s]*$/.test(collection) || collection.endsWith("/")) {
    throw fail("bad_collection", 400, "Collection names can't be empty, contain spaces, or end with '/'.");
  }
  if (!isPlainObject(doc)) throw fail("bad_document", 400, "Documents added to a collection must be objects.");
  const id = doc["id"] === undefined ? sortableId(Date.now()) : doc["id"];
  if (typeof id !== "string" || !id || id.includes("/")) throw fail("bad_id", 400, "A document `id` must be a non-empty string without '/'.");
  return { key: `${collection}/${id}`, id, doc: { id, ...doc } };
}

// ── Docks ──────────────────────────────────────────────────────────────────

/** A parcel as a receiving app sees it. `from` is a pseudonym, never a name. */
export interface Parcel<T = unknown> {
  id: string;
  seq: number;
  from: string;
  to: string | null;
  body: T;
  sentAt: number;
  expiresAt: number;
  /** Fields customs replaced because they held personal data. */
  redacted: string[];
}

export interface SendResult {
  id: string;
  seq: number;
  /** Your pseudonym at this dock. */
  from: string;
  /** How many apps will get it (never who). */
  recipients: number;
  redacted: string[];
  /** Fields customs removed because they aren't on the dock's manifest. Only you are told. */
  stripped: string[];
}

export interface DockStatus {
  dock: string;
  exists: boolean;
  me: string | null;
  send: boolean;
  receive: boolean;
  waiting: { send: boolean; receive: boolean };
  denied: boolean;
  /** How many other apps receive / send here. Only told to apps that are docked. */
  receivers: number | null;
  senders: number | null;
}

export interface DockListenOptions extends WatchOptions {
  /** Called once while you haven't approved this app yet. Listening starts by itself once you do. */
  onWaiting?: (message: string) => void;
  /** Called when customs refuses a parcel (it's never handed to you). */
  onRefused?: (reason: string, parcel: { id: string; seq: number; from: string }) => void;
}

interface RawStatus {
  exists: boolean;
  id: string | null;
  me: string | null;
  send: boolean;
  receive: boolean;
  waiting: { send: boolean; receive: boolean };
  denied: boolean;
  receivers: number | null;
  senders: number | null;
  key: string | null;
  settings: (CustomsPolicy & { ttlMs: number }) | null;
}

interface RawParcel {
  id: string;
  seq: number;
  from: string;
  to: string | null;
  body: string;
  sentAt: number;
  expiresAt: number;
}

const REFUSALS: Record<string, string> = {
  secret_at_customs: "secret",
  personal_at_customs: "personal",
  shape_mismatch: "shape",
  unsafe_parcel: "unsafe",
  parcel_too_large: "unsafe",
  locked: "sealed",
};

/**
 * A dock is a meeting point between apps. Parcels are sealed with a key that
 * only apps you approved hold, so Cardboard carries them without being able to
 * look inside, and never tells anyone who sent what. Customs runs here, in the
 * SDK, at both ends: the sender's checks what leaves, the receiver's checks
 * what arrives, so a careless (or hostile) app on the other side can't infect
 * or leak through you. The first time an app uses a dock, Cardboard asks you.
 */
export class Dock {
  readonly name: string;
  private readonly box: Box;
  private docked: { id: string; key: DockKeys; policy: CustomsPolicy; me: string } | null = null;

  constructor(box: Box, name: string) {
    this.box = box;
    this.name = name;
  }

  private async idx(): Promise<string> {
    return dockIndex((await this.box.ready()).names, this.name);
  }

  /** The dock's name, sealed so that only you (not the server) can read this app's request. */
  private async ask(): Promise<string> {
    const o = await this.box.ready();
    return toB64u(await seal(o.keys.seal, this.name, ctx.dockAsk(o.boxId, await this.idx())));
  }

  private async raw(): Promise<RawStatus> {
    const s = await this.box.request<RawStatus>("dock.status", { dock: await this.idx() });
    if (s.key && s.id && s.settings) {
      const o = await this.box.ready();
      const root = await openSealed(o.keys.wrap, fromB64u(s.key), ctx.berthKey(s.id, o.boxId));
      this.docked = { id: s.id, key: await dockKeys(root), policy: s.settings, me: s.me! };
    } else {
      this.docked = null;
    }
    return s;
  }

  /** Opens the dock key, or files a request with you and throws "waiting for approval". */
  private async ensure(want: "send" | "receive"): Promise<NonNullable<Dock["docked"]>> {
    const s = await this.raw();
    if (this.docked && (want === "send" ? s.send : s.receive)) return this.docked;
    await this.box.request(want === "send" ? "dock.send" : "dock.receive", { dock: await this.idx(), ask: await this.ask() });
    throw new CardboardError("dock_pending", 403, `Asked to ${want} on dock “${this.name}”. Waiting for approval.`);
  }

  /** Sends a parcel to every app receiving at this dock, or to one pseudonym with `to`. */
  async send<T>(body: T, options: { to?: string } = {}): Promise<SendResult> {
    const docked = this.docked ?? (await this.ensure("send"));
    const cleared = inspect(body, docked.policy);
    const id = newClientId("pcl");
    const sealed = await sealJson(docked.key.seal, { body: cleared.body, redacted: cleared.redacted }, ctx.parcel(docked.id, id));
    let result: { id: string; seq: number; recipients: number; from: string };
    try {
      result = await this.box.request("dock.send", { dock: await this.idx(), ask: await this.ask(), parcel: { id, body: toB64u(sealed) }, to: options.to });
    } catch (err) {
      // Taken off the dock (or the key changed) since we last looked: check again next time.
      if (err instanceof CardboardError && (err.code === "dock_pending" || err.code === "dock_denied")) this.docked = null;
      throw err;
    }
    return { ...result, redacted: cleared.redacted, stripped: cleared.stripped };
  }

  /** Answers a parcel. Only its sender gets the reply, and still doesn't learn who you are. */
  reply<T>(parcel: Parcel, body: T): Promise<SendResult> {
    return this.send(body, { to: parcel.from });
  }

  /** Opens a parcel and runs it through customs. Refused parcels are reported (the kind, never the content) and never handed over. */
  private async unpack<T>(docked: NonNullable<Dock["docked"]>, raw: RawParcel, onRefused?: DockListenOptions["onRefused"]): Promise<Parcel<T> | null> {
    try {
      const envelope = await openJson<{ body: unknown; redacted: string[] }>(docked.key.seal, fromB64u(raw.body), ctx.parcel(docked.id, raw.id));
      const cleared = inspect(envelope.body, docked.policy);
      return {
        id: raw.id,
        seq: raw.seq,
        from: raw.from,
        to: raw.to,
        body: cleared.body as T,
        sentAt: raw.sentAt,
        expiresAt: raw.expiresAt,
        redacted: [...new Set([...(envelope.redacted ?? []), ...cleared.redacted])],
      };
    } catch (err) {
      const reason = err instanceof CardboardError ? REFUSALS[err.code] : err instanceof SyntaxError ? "sealed" : undefined;
      if (!reason) throw err;
      await this.box.request("dock.refuse", { dock: await this.idx(), reason }).catch(() => undefined);
      onRefused?.(reason, { id: raw.id, seq: raw.seq, from: raw.from });
      return null;
    }
  }

  /** Parcels waiting for this app, oldest first. With `ack: true` they're marked as picked up. */
  async receive<T = unknown>(options: { limit?: number; ack?: boolean; after?: number } = {}): Promise<Parcel<T>[]> {
    const docked = this.docked ?? (await this.ensure("receive"));
    const { parcels } = await this.box.request<{ parcels: RawParcel[] }>("dock.receive", { dock: await this.idx(), ...options });
    const out: Parcel<T>[] = [];
    for (const raw of parcels) {
      const parcel = await this.unpack<T>(docked, raw);
      if (parcel) out.push(parcel);
    }
    return out;
  }

  /** Marks everything up to this parcel as picked up. Delivered parcels are deleted. */
  async ack(parcel: Parcel | number): Promise<void> {
    await this.box.request("dock.ack", { dock: await this.idx(), seq: typeof parcel === "number" ? parcel : parcel.seq });
  }

  async status(): Promise<DockStatus> {
    const s = await this.raw();
    return { dock: this.name, exists: s.exists, me: s.me, send: s.send, receive: s.receive, waiting: s.waiting, denied: s.denied, receivers: s.receivers, senders: s.senders };
  }

  /**
   * Handles every parcel for this app, live, one at a time, and acks each one
   * after the handler finishes. Catches up on anything that arrived while it was
   * away. If the dock isn't approved yet, it waits and starts once you approve.
   */
  on<T = unknown>(handler: (parcel: Parcel<T>) => void | Promise<void>, options: DockListenOptions = {}): Watcher {
    let lastSeq = 0;
    let queue: Promise<void> = Promise.resolve();
    let catchingUp = true;
    let buffered: RawParcel[] = [];
    let saidWaiting = false;
    const report = (err: unknown) => {
      const error = err instanceof Error ? err : new Error(String(err));
      if (options.onError) options.onError(error);
      else console.warn(`[cardboard] dock ${this.name}: ${error.message}`);
    };
    const handle = (raw: RawParcel) => {
      if (raw.seq <= lastSeq) return;
      lastSeq = raw.seq;
      queue = queue.then(async () => {
        try {
          const docked = this.docked ?? (await this.ensure("receive"));
          const parcel = await this.unpack<T>(docked, raw, options.onRefused);
          if (parcel) await handler(parcel);
          await this.ack(raw.seq);
        } catch (err) {
          report(err);
        }
      });
    };
    const catchUp = async () => {
      try {
        await this.raw();
        for (;;) {
          const { parcels } = await this.box.request<{ parcels: RawParcel[] }>("dock.receive", { dock: await this.idx(), limit: 100, after: lastSeq || undefined });
          parcels.forEach(handle);
          if (parcels.length < 100) break;
        }
      } catch (err) {
        report(err);
      } finally {
        catchingUp = false;
        const later = buffered.sort((a, b) => a.seq - b.seq);
        buffered = [];
        later.forEach(handle);
      }
    };

    return this.box.stream("dock.watch", async () => ({ dock: await this.idx(), ask: await this.ask() }), {
      maxDelayMs: 10_000,
      onError: options.onError,
      onReady: () => {
        saidWaiting = false;
        catchingUp = true;
        options.onReady?.();
        void catchUp();
      },
      onEvent: (type, data) => {
        if (type !== "parcel") return;
        const raw = JSON.parse(data) as RawParcel;
        if (catchingUp) buffered.push(raw);
        else handle(raw);
      },
      keepTrying: (error) => {
        if (error.code !== "dock_pending") return false;
        if (!saidWaiting) {
          saidWaiting = true;
          if (options.onWaiting) options.onWaiting(error.message);
          else console.info(`[cardboard] ${error.message}`);
        }
        return true;
      },
    });
  }
}

// ── Collections ────────────────────────────────────────────────────────────

export class Collection<T extends object = Record<string, unknown>> {
  readonly name: string;
  private readonly box: Box;

  constructor(box: Box, name: string) {
    this.box = box;
    this.name = name.replace(/\/+$/, "");
  }

  key(id: string): string {
    return `${this.name}/${id}`;
  }

  /** Adds a document. It gets a time-ordered `id` unless it already has one. */
  async add(doc: T & { id?: string }, options: { ttl?: Duration | null } = {}): Promise<Doc<T>> {
    const result = await this.box.add(this.name, doc, options);
    return { ...doc, id: result.id } as Doc<T>;
  }

  get(id: string): Promise<Doc<T> | null> {
    return this.box.get<Doc<T>>(this.key(id));
  }

  /** Replaces the whole document. */
  async set(id: string, doc: T, options: WriteOptions = {}): Promise<Doc<T>> {
    const full = { ...doc, id } as Doc<T>;
    await this.box.put(this.key(id), full, options);
    return full;
  }

  /** Merges changes into the document and returns the result. */
  update(id: string, changes: Partial<{ [K in keyof T]: T[K] | null }>, options: WriteOptions = {}): Promise<Doc<T>> {
    return this.box.patch(this.key(id), changes as Record<string, unknown>, options) as Promise<Doc<T>>;
  }

  remove(id: string, options: { purge?: boolean } = {}): Promise<boolean> {
    return this.box.delete(this.key(id), options);
  }

  async find(options: Omit<QueryOptions, "prefix"> = {}): Promise<Doc<T>[]> {
    const { items } = await this.box.query<Doc<T>>({ ...options, prefix: `${this.name}/` });
    return items.map((i) => i.value);
  }

  async findOne(where: Where): Promise<Doc<T> | null> {
    return (await this.find({ where, limit: 1 }))[0] ?? null;
  }

  async count(where?: Where): Promise<number> {
    const { total } = await this.box.query({ prefix: `${this.name}/`, where, limit: 1 });
    return total;
  }

  /** Every document, oldest first. */
  async all(): Promise<Doc<T>[]> {
    return (await this.box.items<Doc<T>>(`${this.name}/`)).map((i) => i.value);
  }

  history(id: string) {
    return this.box.history<Doc<T>>(this.key(id));
  }

  undo(id: string, options: { to?: number } = {}) {
    return this.box.undo(this.key(id), options);
  }

  watch(onChange: (change: Change<Doc<T>>) => void, options?: WatchOptions): Watcher {
    return this.box.watch<Doc<T>>(`${this.name}/`, onChange, options);
  }
}

function writeBody(options: { ttl?: Duration | null; ifVersion?: number }) {
  const body: Record<string, unknown> = {};
  if (options.ttl !== undefined) body["ttl"] = options.ttl;
  if ("ifVersion" in options && options.ifVersion !== undefined) body["ifVersion"] = options.ifVersion;
  return body;
}

function parseEvent(raw: string): { type: string; data: string } {
  let type = "message";
  const data: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) type = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  return { type, data: data.join("\n") };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done);
  });
}


export {
  finishSignIn,
  registerApp,
  resumeSession,
  startSignIn,
  type CardboardSession,
  type CardboardUser,
  type PendingSignIn,
  type SignInConfig,
  type SignInScope,
} from "./login.ts";
