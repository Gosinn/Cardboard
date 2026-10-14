/**
 * Cardboard SDK: one import, zero dependencies, works in Node and the browser.
 *
 *   import { open } from "cardboard";
 *   const box = open();                       // reads CARDBOARD_URL + CARDBOARD_TAPE (env or .env)
 *   await box.put("settings/theme", "dark");
 *   const notes = box.collection<Note>("notes");
 *   await notes.add({ title: "Buy milk", done: false });
 *   await notes.find({ where: { done: false }, sort: "-$createdAt" });
 */
import { CardboardError } from "../shared/errors.ts";
import type { Duration } from "../shared/duration.ts";

export { CardboardError };
export type { Duration };

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
}

export interface Item<T = unknown> {
  key: string;
  value: T;
  version: number;
  size: number;
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null;
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

export type Where = Record<string, unknown>;

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
  | { op: "patch"; key: string; value: Record<string, unknown>; ttl?: Duration | null; ifVersion?: number }
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

export type Doc<T> = T & { id: string };

interface MaybeProcess {
  env?: Record<string, string | undefined>;
  cwd?: () => string;
  getBuiltinModule?: (id: string) => unknown;
}

const proc = (globalThis as { process?: MaybeProcess }).process;
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

export function open(options: OpenOptions = {}): Box {
  return new Box(options);
}

export class Box {
  readonly url: string;
  private readonly tape: string;
  private readonly fetchImpl: typeof fetch;
  private readonly onNotice: ((notice: string, key: string) => void) | false;
  private readonly seenNotices = new Set<string>();

  constructor(options: OpenOptions = {}) {
    const dotenv = options.url && options.tape ? {} : readDotEnv();
    const url = options.url ?? proc?.env?.["CARDBOARD_URL"] ?? dotenv["CARDBOARD_URL"] ?? "http://127.0.0.1:8787";
    const tape = options.tape ?? proc?.env?.["CARDBOARD_TAPE"] ?? dotenv["CARDBOARD_TAPE"];
    if (!tape) {
      throw new CardboardError(
        "no_tape",
        0,
        "No tape found for Cardboard.",
        "Run `cardboard connect <app-name>` in your app's folder, or pass { tape } to open().",
      );
    }
    this.url = url.replace(/\/+$/, "");
    this.tape = tape;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.onNotice = options.onNotice ?? ((notice) => console.warn(`[cardboard] ${notice}`));
    if (typeof (globalThis as { document?: unknown }).document !== "undefined" && !warnedBrowser) {
      warnedBrowser = true;
      console.warn(
        "[cardboard] This tape is being used in a browser, where anyone using the page can read it. " +
          "Prefer a read-only tape limited to a prefix, or call Cardboard from your server.",
      );
    }
  }

  /** @internal Sends one operation. Used by collections; you shouldn't need it. */
  async request<T>(op: string, body: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.url}/v1/${op}`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.tape}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch {
      throw new CardboardError(
        "unreachable",
        0,
        `Couldn't reach Cardboard at ${this.url}.`,
        "Is it running? Start it with: cardboard start",
      );
    }
    const data = (await res.json().catch(() => null)) as ErrorBody;
    if (!res.ok) throw toError(res.status, data);
    return data as T;
  }

  private notify(result: { key: string; notices?: string[] }) {
    if (!this.onNotice) return;
    for (const notice of result.notices ?? []) {
      const id = `${result.key}\u0000${notice}`;
      if (this.seenNotices.has(id)) continue;
      this.seenNotices.add(id);
      this.onNotice(notice, result.key);
    }
  }

  /** Who am I? The box name, this tape's permissions, and how much is stored. */
  whoami(): Promise<{ box: string; items: number; bytes: number; tape: Record<string, unknown> }> {
    return this.request("whoami", {});
  }

  /** The value at `key`, or null if there's nothing there. */
  async get<T = unknown>(key: string): Promise<T | null> {
    const item = await this.getItem<T>(key);
    return item ? item.value : null;
  }

  /** Like get, but with version and timestamps. */
  async getItem<T = unknown>(key: string): Promise<Item<T> | null> {
    const { item } = await this.request<{ item: Item<T> | null }>("get", { key });
    return item;
  }

  async has(key: string): Promise<boolean> {
    return (await this.getItem(key)) !== null;
  }

  async put<T>(key: string, value: T, options: WriteOptions = {}): Promise<WriteResult> {
    const result = await this.request<WriteResult>("put", { key, value, ...writeBody(options) });
    this.notify(result);
    return result;
  }

  /** Merges `changes` into the object at `key` (null removes a field). Returns the merged object. */
  async patch<T extends Record<string, unknown>>(
    key: string,
    changes: Partial<{ [K in keyof T]: T[K] | null }>,
    options: WriteOptions = {},
  ): Promise<T> {
    const result = await this.request<WriteResult & { value: T }>("patch", { key, value: changes, ...writeBody(options) });
    this.notify(result);
    return result.value;
  }

  /** Deletes `key`. It stays in history (undo brings it back) unless `purge` is set. */
  async delete(key: string, options: { purge?: boolean } = {}): Promise<boolean> {
    const { deleted } = await this.request<{ deleted: boolean }>("delete", { key, purge: options.purge });
    return deleted;
  }

  /** Every key under `prefix`, with metadata. Pages through automatically. */
  async list(prefix = "", options: { limit?: number } = {}): Promise<ListEntry[]> {
    const wanted = options.limit ?? 10_000;
    const out: ListEntry[] = [];
    let after: string | undefined;
    while (out.length < wanted) {
      const page = await this.request<{ items: ListEntry[]; next: string | null }>("list", {
        prefix,
        after,
        limit: Math.min(1000, wanted - out.length),
      });
      out.push(...page.items);
      if (!page.next) break;
      after = page.next;
    }
    return out;
  }

  async keys(prefix = ""): Promise<string[]> {
    return (await this.list(prefix)).map((e) => e.key);
  }

  /** Search values: { where: { done: false, stars: { $gte: 4 } }, sort: "-stars", limit: 20 }. */
  query<T = unknown>(options: QueryOptions = {}): Promise<{ items: Item<T>[]; total: number }> {
    return this.request("query", options);
  }

  /** Past versions of `key`, newest first. */
  async history<T = unknown>(key: string): Promise<Version<T>[]> {
    const { versions } = await this.request<{ versions: Version<T>[] }>("history", { key });
    return versions;
  }

  /** Puts `key` back to its previous version (or version `to`). Undo again to redo. */
  undo(key: string, options: { to?: number } = {}): Promise<{ key: string; version: number; restored: number; deleted: boolean }> {
    return this.request("undo", { key, to: options.to });
  }

  /** Several writes that all happen, or none do. */
  async batch(ops: BatchOp[]): Promise<Array<Record<string, unknown>>> {
    const { results } = await this.request<{ results: Array<{ key: string; notices?: string[] }> }>("batch", { ops });
    for (const r of results) this.notify(r);
    return results;
  }

  /** Adds a document under `collection/` with a generated, time-ordered id (or its own `id`). */
  async add<T extends object>(
    collection: string,
    doc: T & { id?: string },
    options: { ttl?: Duration | null } = {},
  ): Promise<WriteResult & { id: string }> {
    const result = await this.request<WriteResult & { id: string }>("add", { collection, value: doc, ...writeBody(options) });
    this.notify(result);
    return result;
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
  watch<T = unknown>(
    a: string | ((change: Change<T>) => void),
    b?: ((change: Change<T>) => void) | WatchOptions,
    c?: WatchOptions,
  ): Watcher {
    const prefix = typeof a === "string" ? a : "";
    const onChange = (typeof a === "function" ? a : b) as (change: Change<T>) => void;
    const options = (typeof a === "function" ? b : c) as WatchOptions | undefined;
    return this.stream("watch", { prefix }, {
      onReady: () => options?.onReady?.(),
      onError: options?.onError,
      onEvent: (type, data) => {
        if (type === "change") onChange(JSON.parse(data) as Change<T>);
      },
    });
  }

  /** A dock: swap data with other apps without either side learning who the other is. */
  dock(name: string): Dock {
    return new Dock(this, name);
  }

  /** Tell Cardboard who this app is, so you recognise it on your shelf. */
  introduce(profile: AppProfile): Promise<{ profile: AppProfile }> {
    return this.request("introduce", profile);
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
      while (!closed) {
        try {
          const res = await this.fetchImpl(`${this.url}/v1/${op}`, {
            method: "POST",
            headers: { authorization: `Bearer ${this.tape}`, "content-type": "application/json" },
            body: JSON.stringify(body),
            signal: controller.signal,
          });
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

export interface AppProfile {
  title?: string;
  description?: string;
  url?: string;
  version?: string;
}

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
  /** Called once while the owner hasn't approved this app yet. Listening starts by itself once they do. */
  onWaiting?: (message: string) => void;
}

/**
 * A dock is a meeting point between apps. Cardboard carries parcels between
 * them, checks every parcel at customs, and never tells anyone who sent what.
 * The first time an app uses a dock, Cardboard asks you to approve it.
 */
export class Dock {
  readonly name: string;
  private readonly box: Box;

  constructor(box: Box, name: string) {
    this.box = box;
    this.name = name;
  }

  /** Sends a parcel to every app receiving at this dock, or to one pseudonym with `to`. */
  send<T>(body: T, options: { to?: string } = {}): Promise<SendResult> {
    return this.box.request("dock.send", { dock: this.name, body, to: options.to });
  }

  /** Answers a parcel. Only its sender gets the reply, and still doesn't learn who you are. */
  reply<T>(parcel: Parcel, body: T): Promise<SendResult> {
    return this.send(body, { to: parcel.from });
  }

  /** Parcels waiting for this app, oldest first. With `ack: true` they're marked as picked up. */
  async receive<T = unknown>(options: { limit?: number; ack?: boolean; after?: number } = {}): Promise<Parcel<T>[]> {
    const { parcels } = await this.box.request<{ parcels: Parcel<T>[] }>("dock.receive", { dock: this.name, ...options });
    return parcels;
  }

  /** Marks everything up to this parcel as picked up. Delivered parcels are deleted. */
  async ack(parcel: Parcel | number): Promise<void> {
    await this.box.request("dock.ack", { dock: this.name, seq: typeof parcel === "number" ? parcel : parcel.seq });
  }

  status(): Promise<DockStatus> {
    return this.box.request("dock.status", { dock: this.name });
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
    let buffered: Parcel<T>[] = [];
    let saidWaiting = false;
    const report = (err: unknown) => {
      const error = err instanceof Error ? err : new Error(String(err));
      if (options.onError) options.onError(error);
      else console.warn(`[cardboard] dock ${this.name}: ${error.message}`);
    };
    const handle = (parcel: Parcel<T>) => {
      if (parcel.seq <= lastSeq) return;
      lastSeq = parcel.seq;
      queue = queue.then(async () => {
        try {
          await handler(parcel);
          await this.ack(parcel.seq);
        } catch (err) {
          report(err);
        }
      });
    };
    const catchUp = async () => {
      try {
        for (;;) {
          const batch = await this.receive<T>({ limit: 100, after: lastSeq || undefined });
          batch.forEach(handle);
          if (batch.length < 100) break;
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

    return this.box.stream("dock.watch", { dock: this.name }, {
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
        const parcel = JSON.parse(data) as Parcel<T>;
        if (catchingUp) buffered.push(parcel);
        else handle(parcel);
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
    const out: Doc<T>[] = [];
    for (;;) {
      const { items, total } = await this.box.query<Doc<T>>({ prefix: `${this.name}/`, limit: 1000, offset: out.length });
      out.push(...items.map((i) => i.value));
      if (items.length === 0 || out.length >= total) return out;
    }
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

type ErrorBody = { error?: { code?: string; message?: string; hint?: string } } | null;

function toError(status: number, data: ErrorBody) {
  const e = data?.error;
  return new CardboardError(e?.code ?? `http_${status}`, status, e?.message ?? `Cardboard answered with HTTP ${status}.`, e?.hint);
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
