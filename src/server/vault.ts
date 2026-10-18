import { fail } from "../shared/errors.ts";
import { formatBytes, parseSize } from "../shared/size.ts";
import { describeDuration, parseDuration } from "../shared/duration.ts";
import {
  blindIndex,
  derive,
  deriveBoxKeys,
  newId,
  randomKey,
  seal,
  sortableId,
  unseal,
  type BoxKeys,
} from "./crypto.ts";
import { getMeta, setMeta, transaction, type DB } from "./db.ts";
import { notice, scan, SECRET_KINDS, type Finding } from "./detect.ts";
import { matches, sortItems, type Where } from "./query.ts";

const DAY = 24 * 60 * 60 * 1000;

export interface BoxSettings {
  /** Browser origins allowed to call this box directly, e.g. "https://notes.example.com". */
  origins: string[];
  quotaBytes: number;
  maxItemBytes: number;
  /** How long old versions are kept for undo and rewind. */
  historyDays: number;
  /** "warn": store secrets but flag them. "block": refuse to store them. */
  secrets: "warn" | "block";
  /** Applied to writes that don't set their own TTL. null = keep forever. */
  defaultTtlMs: number | null;
}

export const DEFAULT_SETTINGS: BoxSettings = {
  origins: [],
  quotaBytes: 512 * 1024 * 1024,
  maxItemBytes: 1024 * 1024,
  historyDays: 30,
  secrets: "warn",
  defaultTtlMs: null,
};

export interface Box {
  id: string;
  name: string;
  settings: BoxSettings;
  createdAt: number;
  system: boolean;
  profile: AppProfile;
}

/** What an app has told Cardboard about itself, so you recognise it on the shelf. */
export interface AppProfile {
  title?: string;
  description?: string;
  url?: string;
  version?: string;
}

export interface Entry {
  key: string;
  keyId: Buffer;
  size: number;
  version: number;
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null;
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

export interface Change {
  boxId: string;
  type: "put" | "delete";
  key: string;
  version: number | null;
  at: number;
  value?: unknown;
  reason?: "expired" | "purged";
}

export interface WriteOptions {
  /** Milliseconds until the item expires. null = never. undefined = box default (put) or unchanged (patch). */
  ttlMs?: number | null;
  /** Optimistic concurrency: only write if the current version is this (0 = must not exist). */
  ifVersion?: number;
}

export interface WriteResult {
  key: string;
  version: number;
  notices: string[];
  findings: Finding[];
}

export interface VersionInfo {
  version: number;
  at: number;
  deleted: boolean;
  value?: unknown;
  size: number;
  actor: string;
}

const BOX_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const MAX_KEY = 1024;

const ctxBoxKey = (boxId: string) => `box-key|${boxId}`;
const ctxItemKey = (boxId: string, keyId: Buffer) => `item-key|${boxId}|${keyId.toString("hex")}`;
const ctxItemValue = (boxId: string, keyId: Buffer) => `item-value|${boxId}|${keyId.toString("hex")}`;

interface BoxRow {
  id: string;
  name: string;
  wrapped_key: Uint8Array;
  settings: string;
  created_at: number;
  system: number;
  profile: string;
}

interface HistoryRow {
  key_id: Uint8Array;
  version: number;
  key_enc: Uint8Array;
  value_enc: Uint8Array | null;
  size: number;
  at: number;
  actor: string;
}

/**
 * The vault owns all reads and writes of box data. Everything that touches the
 * database goes through here, encrypted with that box's own key.
 */
export class Vault {
  readonly db: DB;
  readonly now: () => number;
  private readonly wrapKey: Buffer;
  private readonly systemKey: Buffer;
  private readonly keys = new Map<string, BoxKeys>();
  /** Decrypted key names per box, so listing doesn't decrypt every row every time. */
  private readonly index = new Map<string, Map<string, Entry>>();
  private readonly listeners = new Set<(change: Change) => void>();
  private events: Change[] | null = null;

  constructor(db: DB, masterKey: Buffer, now: () => number = Date.now) {
    this.db = db;
    this.now = now;
    this.wrapKey = derive(masterKey, "wrap");
    this.systemKey = derive(masterKey, "system");
    this.verifyMasterKey(derive(masterKey, "check"));
  }

  private verifyMasterKey(checkKey: Buffer) {
    const stored = getMeta(this.db, "key_check");
    if (!stored) {
      setMeta(this.db, "key_check", seal(checkKey, "cardboard", "key-check").toString("base64"));
      return;
    }
    try {
      unseal(checkKey, Buffer.from(stored, "base64"), "key-check");
    } catch {
      throw fail(
        "wrong_key",
        500,
        "This master key doesn't belong to this database.",
        "Point CARDBOARD_KEY_FILE at the master.key that was created together with this data folder.",
      );
    }
  }

  onChange(listener: (change: Change) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ── Boxes ────────────────────────────────────────────────────────────────

  createBox(name: string, options: { system?: boolean } = {}): Box {
    if (!options.system && !BOX_NAME.test(name)) {
      throw fail(
        "bad_box_name",
        400,
        `"${name}" can't be used as a box name.`,
        "Use lowercase letters, numbers and dashes, like recipe-app.",
      );
    }
    if (this.findBox(name)) {
      throw fail("box_exists", 409, `There's already a box called ${name}.`);
    }
    const id = newId("box");
    const boxKey = randomKey();
    const wrapped = seal(this.wrapKey, boxKey, ctxBoxKey(id));
    boxKey.fill(0);
    const createdAt = this.now();
    this.db
      .prepare("INSERT INTO boxes (id, name, wrapped_key, settings, created_at, system) VALUES (?, ?, ?, '{}', ?, ?)")
      .run(id, name, wrapped, createdAt, options.system ? 1 : 0);
    return { id, name, settings: { ...DEFAULT_SETTINGS }, createdAt, system: Boolean(options.system), profile: {} };
  }

  findBox(name: string): Box | undefined {
    const row = this.db.prepare("SELECT * FROM boxes WHERE name = ?").get(name) as BoxRow | undefined;
    return row && toBox(row);
  }

  getBox(id: string): Box | undefined {
    const row = this.db.prepare("SELECT * FROM boxes WHERE id = ?").get(id) as BoxRow | undefined;
    return row && toBox(row);
  }

  requireBox(name: string): Box {
    const box = this.findBox(name);
    if (!box || box.system) {
      throw fail("no_such_box", 404, `There's no box called ${name}.`, `Create it with: cardboard connect ${name}`);
    }
    return box;
  }

  private requireBoxById(id: string): Box {
    const box = this.getBox(id);
    if (!box) throw fail("no_such_box", 404, "That box no longer exists.");
    return box;
  }

  listBoxes(options: { includeSystem?: boolean } = {}): Box[] {
    const rows = this.db.prepare("SELECT * FROM boxes ORDER BY name").all() as unknown as BoxRow[];
    return rows.map(toBox).filter((b) => options.includeSystem || !b.system);
  }

  updateSettings(boxId: string, patch: Record<string, unknown>): Box {
    const box = this.requireBoxById(boxId);
    const next: BoxSettings = { ...box.settings, ...validateSettings(patch) };
    this.db.prepare("UPDATE boxes SET settings = ? WHERE id = ?").run(JSON.stringify(next), boxId);
    return { ...box, settings: next };
  }

  updateProfile(boxId: string, patch: Record<string, unknown>): Box {
    const box = this.requireBoxById(boxId);
    const limits: Record<keyof AppProfile, number> = { title: 60, description: 200, url: 200, version: 40 };
    const next: AppProfile = { ...box.profile };
    for (const [field, value] of Object.entries(patch)) {
      if (!(field in limits)) {
        throw fail("bad_profile", 400, `Unknown profile field "${field}". Use title, description, url and version.`);
      }
      const key = field as keyof AppProfile;
      if (value === null || value === "") {
        delete next[key];
        continue;
      }
      if (typeof value !== "string" || value.length > limits[key]) {
        throw fail("bad_profile", 400, `\`${field}\` must be text of at most ${limits[key]} characters.`);
      }
      if (key === "url" && !/^https?:\/\//.test(value)) throw fail("bad_profile", 400, "`url` must start with http:// or https://.");
      next[key] = value;
    }
    this.db.prepare("UPDATE boxes SET profile = ? WHERE id = ?").run(JSON.stringify(next), boxId);
    return { ...box, profile: next };
  }

  /** Wraps a key with the master key, e.g. for docks. Bound to `context`. */
  wrap(key: Buffer, context: string): Buffer {
    return seal(this.wrapKey, key, context);
  }

  unwrap(sealed: Uint8Array, context: string): Buffer {
    return unseal(this.wrapKey, sealed, context);
  }

  /**
   * Crypto-shredding: the box key, every item, every version, every tape and
   * every log line go. SQLite's secure_delete overwrites the freed pages and the
   * WAL is checkpointed, so nothing readable is left on disk.
   */
  shredBox(boxId: string) {
    transaction(this.db, () => {
      this.db.prepare("DELETE FROM boxes WHERE id = ?").run(boxId);
    });
    const keys = this.keys.get(boxId);
    keys?.enc.fill(0);
    keys?.idx.fill(0);
    this.keys.delete(boxId);
    this.index.delete(boxId);
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }

  // ── Keys ─────────────────────────────────────────────────────────────────

  private boxKeys(boxId: string): BoxKeys {
    let keys = this.keys.get(boxId);
    if (!keys) {
      const row = this.db.prepare("SELECT wrapped_key FROM boxes WHERE id = ?").get(boxId) as
        | { wrapped_key: Uint8Array }
        | undefined;
      if (!row) throw fail("no_such_box", 404, "That box no longer exists.");
      const boxKey = unseal(this.wrapKey, row.wrapped_key, ctxBoxKey(boxId));
      keys = deriveBoxKeys(boxKey);
      boxKey.fill(0);
      this.keys.set(boxId, keys);
    }
    return keys;
  }

  /** A key for one purpose, derived from the master key (stable across restarts). */
  systemSubkey(purpose: string): Buffer {
    return derive(this.systemKey, purpose);
  }

  /** Encrypts audit details: with the box key (so shredding a box shreds its log) or the system key. */
  sealDetail(boxId: string | null, detail: unknown): Buffer {
    const key = boxId ? this.boxKeys(boxId).enc : this.systemKey;
    return seal(key, JSON.stringify(detail), `log|${boxId ?? "system"}`);
  }

  openDetail(boxId: string | null, sealed: Uint8Array): unknown {
    const key = boxId ? this.boxKeys(boxId).enc : this.systemKey;
    return JSON.parse(unseal(key, sealed, `log|${boxId ?? "system"}`).toString());
  }

  private keyId(boxId: string, key: string): Buffer {
    return blindIndex(this.boxKeys(boxId).idx, key);
  }

  private entries(boxId: string): Map<string, Entry> {
    let map = this.index.get(boxId);
    if (!map) {
      const keys = this.boxKeys(boxId);
      map = new Map();
      const rows = this.db
        .prepare(
          "SELECT key_id, key_enc, size, version, created_at, updated_at, expires_at FROM items WHERE box_id = ?",
        )
        .all(boxId) as Array<{
        key_id: Uint8Array;
        key_enc: Uint8Array;
        size: number;
        version: number;
        created_at: number;
        updated_at: number;
        expires_at: number | null;
      }>;
      for (const row of rows) {
        const keyId = Buffer.from(row.key_id);
        const key = unseal(keys.enc, row.key_enc, ctxItemKey(boxId, keyId)).toString();
        map.set(key, {
          key,
          keyId,
          size: row.size,
          version: row.version,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          expiresAt: row.expires_at,
        });
      }
      this.index.set(boxId, map);
    }
    return map;
  }

  /** Live (non-expired) entries, sorted by key, optionally under a prefix. */
  listEntries(boxId: string, prefix = ""): Entry[] {
    const now = this.now();
    return [...this.entries(boxId).values()]
      .filter((e) => e.key.startsWith(prefix) && !isExpired(e.expiresAt, now))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  // ── Transactions & events ────────────────────────────────────────────────

  /**
   * Runs `fn` in one SQLite transaction. Change events are only delivered after
   * COMMIT; on rollback the key-name cache is dropped and rebuilt lazily.
   */
  private tx<T>(fn: () => T): T {
    if (this.events) return fn();
    const events: Change[] = [];
    this.events = events;
    let result: T;
    try {
      result = transaction(this.db, fn);
    } catch (err) {
      this.index.clear();
      throw err;
    } finally {
      this.events = null;
    }
    for (const event of events) {
      for (const listener of this.listeners) {
        try {
          listener(event);
        } catch {
          // A broken watcher must never break a write.
        }
      }
    }
    return result;
  }

  private emit(change: Change) {
    this.events?.push(change);
  }

  /** Runs several operations atomically: all of them happen, or none do. */
  batch<T>(fn: () => T): T {
    return this.tx(fn);
  }

  // ── Items ────────────────────────────────────────────────────────────────

  get(boxId: string, key: string): Item | null {
    validateKey(key);
    const keyId = this.keyId(boxId, key);
    const row = this.db
      .prepare(
        "SELECT value_enc, size, version, created_at, updated_at, expires_at FROM items WHERE box_id = ? AND key_id = ?",
      )
      .get(boxId, keyId) as
      | {
          value_enc: Uint8Array;
          size: number;
          version: number;
          created_at: number;
          updated_at: number;
          expires_at: number | null;
        }
      | undefined;
    if (!row || isExpired(row.expires_at, this.now())) return null;
    return {
      key,
      value: this.decryptValue(boxId, keyId, row.value_enc),
      version: row.version,
      size: row.size,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      expiresAt: row.expires_at,
    };
  }

  private decryptValue(boxId: string, keyId: Buffer, valueEnc: Uint8Array): unknown {
    return JSON.parse(unseal(this.boxKeys(boxId).enc, valueEnc, ctxItemValue(boxId, keyId)).toString());
  }

  put(boxId: string, key: string, value: unknown, options: WriteOptions, actor: string): WriteResult {
    validateKey(key);
    return this.tx(() => {
      const box = this.requireBoxById(boxId);
      const ttl = options.ttlMs === undefined ? box.settings.defaultTtlMs : options.ttlMs;
      return this.store(box, key, value, {
        expiresAt: ttl ? this.now() + ttl : null,
        ifVersion: options.ifVersion,
        actor,
      });
    });
  }

  /** JSON Merge Patch (RFC 7386): nested objects merge, `null` removes a field. */
  patch(boxId: string, key: string, changes: unknown, options: WriteOptions, actor: string): WriteResult & { value: unknown } {
    validateKey(key);
    if (!isPlainObject(changes)) {
      throw fail("bad_patch", 400, "A patch must be an object, like { done: true }.");
    }
    return this.tx(() => {
      const box = this.requireBoxById(boxId);
      const current = this.get(boxId, key);
      if (current && !isPlainObject(current.value)) {
        throw fail("not_an_object", 409, `"${key}" isn't an object, so it can't be patched.`, "Use put to replace it.");
      }
      const defaultExpiry = box.settings.defaultTtlMs ? this.now() + box.settings.defaultTtlMs : null;
      const expiresAt =
        options.ttlMs === undefined
          ? current
            ? current.expiresAt
            : defaultExpiry
          : options.ttlMs
            ? this.now() + options.ttlMs
            : null;
      const value = mergePatch(current?.value ?? {}, changes);
      return { ...this.store(box, key, value, { expiresAt, ifVersion: options.ifVersion, actor }), value };
    });
  }

  /** Adds a document to a collection with a time-sortable id (or the `id` it already has). */
  add(boxId: string, collection: string, doc: unknown, options: WriteOptions, actor: string): WriteResult & { id: string } {
    if (typeof collection !== "string" || !/^[^/\s][^\s]*$/.test(collection) || collection.endsWith("/")) {
      throw fail("bad_collection", 400, "Collection names can't be empty, contain spaces, or end with '/'.");
    }
    if (!isPlainObject(doc)) throw fail("bad_document", 400, "Documents added to a collection must be objects.");
    let id = doc["id"];
    if (id === undefined) id = sortableId(this.now());
    if (typeof id !== "string" || !id || id.includes("/")) {
      throw fail("bad_id", 400, "A document `id` must be a non-empty string without '/'.");
    }
    const result = this.put(
      boxId,
      `${collection}/${id}`,
      { id, ...doc },
      { ttlMs: options.ttlMs, ifVersion: 0 },
      actor,
    );
    return { ...result, id };
  }

  private store(
    box: Box,
    key: string,
    value: unknown,
    options: { expiresAt: number | null; ifVersion: number | undefined; actor: string; restore?: boolean },
  ): WriteResult {
    if (value === undefined) {
      throw fail("missing_value", 400, "Nothing to store: `value` is missing.", "Send JSON like { key, value }.");
    }
    const json = JSON.stringify(value);
    const size = Buffer.byteLength(json);
    if (size > box.settings.maxItemBytes) {
      throw fail(
        "too_large",
        413,
        `That value is ${formatBytes(size)}; this box allows up to ${formatBytes(box.settings.maxItemBytes)} per item.`,
        "Split it into smaller items, or raise maxItemBytes in the box settings.",
      );
    }
    const findings = scan(value);
    if (box.settings.secrets === "block" && !options.restore) {
      const secret = findings.find((f) => SECRET_KINDS.has(f.kind));
      if (secret) {
        throw fail(
          "secret_blocked",
          422,
          notice(secret),
          "This box is set to refuse secrets. Store a hash instead, or keep the key out of app data.",
        );
      }
    }

    const now = this.now();
    const entries = this.entries(box.id);
    let existing = entries.get(key);
    if (existing && isExpired(existing.expiresAt, now)) {
      this.purge(box.id, existing.keyId, key);
      existing = undefined;
    }
    if (options.ifVersion === 0 && existing) {
      throw fail("already_exists", 409, `"${key}" already exists.`, "Use put or patch to change it.");
    }
    if (options.ifVersion !== undefined && (existing?.version ?? 0) !== options.ifVersion) {
      throw fail(
        "version_conflict",
        409,
        existing
          ? `"${key}" changed since you read it (it's at version ${existing.version}, you expected ${options.ifVersion}).`
          : `"${key}" doesn't exist any more.`,
        "Read it again and retry.",
      );
    }
    let used = 0;
    for (const e of entries.values()) used += e.size;
    if (used - (existing?.size ?? 0) + size > box.settings.quotaBytes) {
      throw fail(
        "quota_exceeded",
        507,
        `${box.name} is full (${formatBytes(used)} of ${formatBytes(box.settings.quotaBytes)}).`,
        "Delete things you don't need, or raise quotaBytes in the box settings.",
      );
    }

    const version = this.writeVersion(box.id, key, { value, json, size }, options.expiresAt, options.actor);
    return { key, version, findings, notices: findings.filter(isNoticeWorthy).map(notice) };
  }

  /** Writes one version (or a deletion) to items + history and updates the cache. */
  private writeVersion(
    boxId: string,
    key: string,
    payload: { value: unknown; json: string; size: number } | null,
    expiresAt: number | null,
    actor: string,
  ): number {
    const now = this.now();
    const keys = this.boxKeys(boxId);
    const keyId = blindIndex(keys.idx, key);
    const entries = this.entries(boxId);
    const existing = entries.get(key);
    const last = this.db
      .prepare("SELECT MAX(version) AS v FROM history WHERE box_id = ? AND key_id = ?")
      .get(boxId, keyId) as { v: number | null };
    const version = Math.max(last.v ?? 0, existing?.version ?? 0) + 1;
    const keyEnc = seal(keys.enc, key, ctxItemKey(boxId, keyId));
    let valueEnc: Buffer | null = null;

    if (payload) {
      valueEnc = seal(keys.enc, payload.json, ctxItemValue(boxId, keyId));
      const createdAt = existing?.createdAt ?? now;
      this.db
        .prepare(
          `INSERT INTO items (box_id, key_id, key_enc, value_enc, size, version, created_at, updated_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (box_id, key_id) DO UPDATE SET
             key_enc = excluded.key_enc, value_enc = excluded.value_enc, size = excluded.size,
             version = excluded.version, updated_at = excluded.updated_at, expires_at = excluded.expires_at`,
        )
        .run(boxId, keyId, keyEnc, valueEnc, payload.size, version, createdAt, now, expiresAt);
      entries.set(key, { key, keyId, size: payload.size, version, createdAt, updatedAt: now, expiresAt });
      this.emit({ boxId, type: "put", key, version, at: now, value: payload.value });
    } else {
      this.db.prepare("DELETE FROM items WHERE box_id = ? AND key_id = ?").run(boxId, keyId);
      entries.delete(key);
      this.emit({ boxId, type: "delete", key, version, at: now });
    }
    this.db
      .prepare(
        "INSERT INTO history (box_id, key_id, version, key_enc, value_enc, size, at, actor) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(boxId, keyId, version, keyEnc, valueEnc, payload?.size ?? 0, now, actor);
    return version;
  }

  /** Removes an item and all of its history. Used for expiry and `purge: true`. */
  private purge(boxId: string, keyId: Buffer, key: string, reason: Change["reason"] = "expired") {
    this.db.prepare("DELETE FROM items WHERE box_id = ? AND key_id = ?").run(boxId, keyId);
    const { changes } = this.db.prepare("DELETE FROM history WHERE box_id = ? AND key_id = ?").run(boxId, keyId);
    const had = this.entries(boxId).delete(key);
    if (had || Number(changes) > 0) this.emit({ boxId, type: "delete", key, version: null, at: this.now(), reason });
  }

  /** Deletes an item. It stays in history (so it can be undone) unless `purge` is set. */
  delete(boxId: string, key: string, options: { purge?: boolean }, actor: string): boolean {
    validateKey(key);
    return this.tx(() => {
      const keyId = this.keyId(boxId, key);
      const existing = this.entries(boxId).get(key);
      if (options.purge) {
        const hadHistory = this.db
          .prepare("SELECT 1 FROM history WHERE box_id = ? AND key_id = ? LIMIT 1")
          .get(boxId, keyId);
        this.purge(boxId, keyId, key, "purged");
        return Boolean(existing || hadHistory);
      }
      if (!existing) return false;
      if (isExpired(existing.expiresAt, this.now())) {
        this.purge(boxId, keyId, key);
        return false;
      }
      this.writeVersion(boxId, key, null, null, actor);
      return true;
    });
  }

  list(boxId: string, options: { prefix?: string; limit?: number; after?: string }) {
    const limit = clampLimit(options.limit);
    const all = this.listEntries(boxId, options.prefix ?? "").filter((e) => !options.after || e.key > options.after);
    const page = all.slice(0, limit);
    return {
      items: page.map(({ key, size, version, createdAt, updatedAt, expiresAt }) => ({
        key,
        size,
        version,
        createdAt,
        updatedAt,
        expiresAt,
      })),
      next: all.length > limit ? page.at(-1)!.key : null,
    };
  }

  /** Decrypts every live item under `prefix`. Fine at personal scale (tens of thousands of items). */
  items(boxId: string, prefix = ""): Item[] {
    const out: Item[] = [];
    for (const entry of this.listEntries(boxId, prefix)) {
      const item = this.get(boxId, entry.key);
      if (item) out.push(item);
    }
    return out;
  }

  query(
    boxId: string,
    options: { prefix?: string; where?: Where; sort?: string | string[]; limit?: number; offset?: number },
  ) {
    const found = this.items(boxId, options.prefix ?? "").filter((item) => matches(item.value, options.where));
    const sorted = sortItems(found, options.sort);
    const offset = Math.max(0, Math.floor(options.offset ?? 0));
    return { items: sorted.slice(offset, offset + clampLimit(options.limit)), total: sorted.length };
  }

  history(boxId: string, key: string, limit = 50): VersionInfo[] {
    validateKey(key);
    const keyId = this.keyId(boxId, key);
    const rows = this.db
      .prepare("SELECT * FROM history WHERE box_id = ? AND key_id = ? ORDER BY version DESC LIMIT ?")
      .all(boxId, keyId, clampLimit(limit)) as unknown as HistoryRow[];
    return rows.map((row) => ({
      version: row.version,
      at: row.at,
      deleted: row.value_enc === null,
      ...(row.value_enc ? { value: this.decryptValue(boxId, keyId, row.value_enc) } : {}),
      size: row.size,
      actor: row.actor,
    }));
  }

  /**
   * Restores the previous version of a key (or version `to`). The restore is a
   * new version, so undoing twice is a redo.
   */
  undo(boxId: string, key: string, options: { to?: number }, actor: string) {
    validateKey(key);
    return this.tx(() => {
      const box = this.requireBoxById(boxId);
      const keyId = this.keyId(boxId, key);
      const rows = this.db
        .prepare("SELECT * FROM history WHERE box_id = ? AND key_id = ? ORDER BY version DESC")
        .all(boxId, keyId) as unknown as HistoryRow[];
      if (rows.length === 0) {
        throw fail("nothing_to_undo", 404, `There's no history for "${key}".`);
      }
      const target = options.to === undefined ? rows[1] : rows.find((r) => r.version === options.to);
      if (options.to !== undefined && !target) {
        throw fail(
          "no_such_version",
          404,
          `"${key}" has no version ${options.to}.`,
          `Versions kept: ${rows.map((r) => r.version).join(", ")}.`,
        );
      }
      const current = this.entries(boxId).get(key);
      if (!target || target.value_enc === null) {
        // Undoing a create, or going back to "didn't exist".
        if (!current) throw fail("nothing_to_undo", 404, `"${key}" is already gone.`);
        const version = this.writeVersion(boxId, key, null, null, actor);
        return { key, version, restored: target?.version ?? 0, deleted: true };
      }
      const value = this.decryptValue(boxId, keyId, target.value_enc);
      const ttl = box.settings.defaultTtlMs;
      const result = this.store(box, key, value, {
        expiresAt: ttl ? this.now() + ttl : null,
        ifVersion: undefined,
        actor,
        restore: true,
      });
      return { key, version: result.version, restored: target.version, deleted: false };
    });
  }

  /** Puts every key in the box back the way it was at time `to`. */
  rewind(boxId: string, to: number, actor: string) {
    const box = this.requireBoxById(boxId);
    const now = this.now();
    if (to > now) throw fail("bad_time", 400, "You can only rewind to a moment in the past.");
    if (to < now - box.settings.historyDays * DAY) {
      throw fail(
        "too_far_back",
        400,
        `${box.name} keeps ${box.settings.historyDays} days of history, so it can't rewind ${describeDuration(now - to)}.`,
        "Raise historyDays in the box settings to keep more.",
      );
    }
    return this.tx(() => {
      const rows = this.db
        .prepare("SELECT * FROM history WHERE box_id = ? ORDER BY key_id, version")
        .all(boxId) as unknown as HistoryRow[];
      const byKey = new Map<string, HistoryRow[]>();
      for (const row of rows) {
        const id = Buffer.from(row.key_id).toString("hex");
        let list = byKey.get(id);
        if (!list) byKey.set(id, (list = []));
        list.push(row);
      }
      const keys = this.boxKeys(boxId);
      let changed = 0;
      for (const list of byKey.values()) {
        const latest = list.at(-1)!;
        const keyId = Buffer.from(latest.key_id);
        const key = unseal(keys.enc, latest.key_enc, ctxItemKey(boxId, keyId)).toString();
        const target = list.filter((r) => r.at <= to).at(-1);
        const current = this.entries(boxId).get(key);
        const live = current && !isExpired(current.expiresAt, now) ? current : undefined;
        if (!target || target.value_enc === null) {
          if (live) {
            this.writeVersion(boxId, key, null, null, actor);
            changed++;
          }
        } else if (!live || live.version !== target.version) {
          const value = this.decryptValue(boxId, keyId, target.value_enc);
          this.store(box, key, value, { expiresAt: null, ifVersion: undefined, actor, restore: true });
          changed++;
        }
      }
      return { changed };
    });
  }

  exportBox(boxId: string) {
    const box = this.requireBoxById(boxId);
    return {
      format: "cardboard-export",
      formatVersion: 1,
      box: box.name,
      exportedAt: new Date(this.now()).toISOString(),
      items: this.items(boxId).map(({ key, value, version, createdAt, updatedAt, expiresAt }) => ({
        key,
        value,
        version,
        createdAt,
        updatedAt,
        expiresAt,
      })),
    };
  }

  importItems(boxId: string, items: unknown, actor: string) {
    if (!Array.isArray(items)) {
      throw fail("bad_import", 400, "Import expects a list of { key, value } items, like a Cardboard export.");
    }
    return this.tx(() => {
      const box = this.requireBoxById(boxId);
      const now = this.now();
      let imported = 0;
      let skipped = 0;
      for (const raw of items) {
        if (!isPlainObject(raw) || typeof raw["key"] !== "string" || raw["value"] === undefined) {
          throw fail("bad_import", 400, "Every imported item needs a string `key` and a `value`.");
        }
        const expiresAt = typeof raw["expiresAt"] === "number" ? raw["expiresAt"] : null;
        if (expiresAt !== null && expiresAt <= now) {
          skipped++;
          continue;
        }
        validateKey(raw["key"]);
        this.store(box, raw["key"], raw["value"], { expiresAt, ifVersion: undefined, actor, restore: true });
        imported++;
      }
      return { imported, skipped };
    });
  }

  stats(boxId: string) {
    const entries = this.listEntries(boxId);
    return { items: entries.length, bytes: entries.reduce((sum, e) => sum + e.size, 0) };
  }

  /**
   * Housekeeping, run every minute: deletes expired items (with their history,
   * so expired data can't be undone back into existence) and prunes old versions.
   */
  sweep(): { expired: Map<string, number> } {
    const now = this.now();
    const expired = new Map<string, number>();
    const rows = this.db
      .prepare("SELECT box_id, key_id, key_enc FROM items WHERE expires_at IS NOT NULL AND expires_at <= ?")
      .all(now) as Array<{ box_id: string; key_id: Uint8Array; key_enc: Uint8Array }>;
    if (rows.length > 0) {
      this.tx(() => {
        for (const row of rows) {
          const keyId = Buffer.from(row.key_id);
          const key = unseal(this.boxKeys(row.box_id).enc, row.key_enc, ctxItemKey(row.box_id, keyId)).toString();
          this.purge(row.box_id, keyId, key);
          expired.set(row.box_id, (expired.get(row.box_id) ?? 0) + 1);
        }
      });
    }
    for (const box of this.listBoxes({ includeSystem: true })) {
      const cutoff = now - box.settings.historyDays * DAY;
      this.db
        .prepare(
          `DELETE FROM history WHERE box_id = ? AND at < ? AND version < (
             SELECT MAX(h.version) FROM history h WHERE h.box_id = history.box_id AND h.key_id = history.key_id)`,
        )
        .run(box.id, cutoff);
      this.db
        .prepare(
          `DELETE FROM history WHERE box_id = ? AND at < ? AND value_enc IS NULL AND NOT EXISTS (
             SELECT 1 FROM items i WHERE i.box_id = history.box_id AND i.key_id = history.key_id)`,
        )
        .run(box.id, cutoff);
    }
    return { expired };
  }
}

function toBox(row: BoxRow): Box {
  return {
    id: row.id,
    name: row.name,
    settings: { ...DEFAULT_SETTINGS, ...(JSON.parse(row.settings) as Partial<BoxSettings>) },
    createdAt: row.created_at,
    system: row.system === 1,
    profile: JSON.parse(row.profile || "{}") as AppProfile,
  };
}

function isExpired(expiresAt: number | null, now: number): boolean {
  return expiresAt !== null && expiresAt <= now;
}

function isNoticeWorthy(f: Finding): boolean {
  return f.kind !== "email" && f.kind !== "phone";
}

export function validateKey(key: unknown): asserts key is string {
  if (typeof key !== "string" || key.length === 0) {
    throw fail("bad_key", 400, "Every item needs a key: a non-empty string like \"notes/groceries\".");
  }
  if (key.length > MAX_KEY) throw fail("bad_key", 400, `Keys can be at most ${MAX_KEY} characters long.`);
  if (/[\x00-\x1f\x7f]/.test(key)) throw fail("bad_key", 400, "Keys can't contain control characters.");
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return 100;
  return Math.min(1000, Math.max(1, Math.floor(limit)));
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function mergePatch(target: unknown, patch: unknown): unknown {
  if (!isPlainObject(patch)) return patch;
  const result: Record<string, unknown> = isPlainObject(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key];
    // defineProperty, not assignment: a "__proto__" key must stay plain data.
    else Object.defineProperty(result, key, { value: mergePatch(result[key], value), enumerable: true, writable: true, configurable: true });
  }
  return result;
}

function validateSettings(patch: Record<string, unknown>): Partial<BoxSettings> {
  const out: Partial<BoxSettings> = {};
  for (const [field, value] of Object.entries(patch)) {
    switch (field) {
      case "origins": {
        if (!Array.isArray(value)) throw badSetting("origins must be a list, like [\"https://notes.example.com\"].");
        out.origins = value.map((origin) => {
          let parsed: URL | undefined;
          try {
            parsed = new URL(String(origin));
          } catch {
            parsed = undefined;
          }
          if (!parsed || parsed.origin !== origin || !/^https?:$/.test(parsed.protocol)) {
            throw badSetting(`"${origin}" isn't an origin. Use the exact scheme + host, like https://notes.example.com.`);
          }
          return parsed.origin;
        });
        break;
      }
      case "quotaBytes":
      case "maxItemBytes":
        out[field] = parseSize(value as string | number);
        break;
      case "historyDays": {
        const days = Number(value);
        if (!Number.isInteger(days) || days < 0 || days > 3650) throw badSetting("historyDays must be 0–3650.");
        out.historyDays = days;
        break;
      }
      case "secrets":
        if (value !== "warn" && value !== "block") throw badSetting('secrets must be "warn" or "block".');
        out.secrets = value;
        break;
      case "defaultTtl":
        out.defaultTtlMs = value === null || value === "never" ? null : parseDuration(value as string | number);
        break;
      default:
        throw badSetting(
          `Unknown setting "${field}". Settings are origins, quotaBytes, maxItemBytes, historyDays, secrets and defaultTtl.`,
        );
    }
  }
  return out;
}

function badSetting(message: string) {
  return fail("bad_setting", 400, message);
}
