import { fail } from "../shared/errors.ts";
import { describeDuration, parseDuration } from "../shared/duration.ts";
import { formatBytes, parseSize } from "../shared/size.ts";
import { transaction, type DB } from "./db.ts";
import { b64 } from "./wire.ts";

/**
 * The vault stores boxes and items it cannot read. Every item arrives already
 * sealed by the app (or your device) with the box key, and is found by `idx`,
 * a keyed hash of its name. The vault does everything that doesn't need the
 * content: versions, history, undo, rewind, expiry, quotas, live change events.
 */

const DAY = 24 * 60 * 60 * 1000;
export const DEFAULT_ACCOUNT_QUOTA = 10 * 1024 ** 3;
/** Cardboard stops taking new data before the disk under it gets this full, so it can't fill the computer it runs on. */
export const MIN_FREE_DISK = 1024 ** 3;
const MAX_NAME_BYTES = 4096;

export interface BoxSettings {
  /** Browser origins allowed to call this box directly, e.g. "https://notes.example.com". */
  origins: string[];
  quotaBytes: number;
  maxItemBytes: number;
  /** How long old versions are kept for undo and rewind. */
  historyDays: number;
  /** "warn": store secrets but flag them. "block": refuse them. Enforced by the SDK, before sealing. */
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
  accountId: string;
  idx: Buffer;
  /** Sealed by the account key. */
  name: Buffer;
  /** The box key, sealed by the account key. */
  key: Buffer;
  /** Sealed by the box key. */
  profile: Buffer | null;
  settings: BoxSettings;
  createdAt: number;
}

export interface StoredItem {
  idx: Buffer;
  name: Buffer;
  value: Buffer;
  version: number;
  size: number;
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null;
}

export interface Sealed {
  idx: Buffer;
  name: Buffer;
  value: Buffer;
}

export interface Change {
  boxId: string;
  type: "put" | "delete";
  idx: string;
  name: string | null;
  value?: string;
  version: number | null;
  at: number;
  reason?: "expired" | "purged";
}

export interface WriteOptions {
  /** Milliseconds until the item expires. null = never. undefined = box default. */
  ttlMs?: number | null;
  /** Optimistic concurrency: only write if the current version is this (0 = must not exist). */
  ifVersion?: number;
}

export interface VersionInfo {
  version: number;
  at: number;
  deleted: boolean;
  name: Buffer;
  value: Buffer | null;
  size: number;
  actor: string;
}

interface BoxRow {
  id: string;
  account_id: string;
  idx: Uint8Array;
  name: Uint8Array;
  key: Uint8Array;
  profile: Uint8Array | null;
  settings: string;
  created_at: number;
}

interface ItemRow {
  idx: Uint8Array;
  name: Uint8Array;
  value: Uint8Array;
  size: number;
  version: number;
  created_at: number;
  updated_at: number;
  expires_at: number | null;
}

interface HistoryRow {
  idx: Uint8Array;
  version: number;
  name: Uint8Array;
  value: Uint8Array | null;
  size: number;
  at: number;
  actor: string;
}

export class Vault {
  readonly db: DB;
  readonly now: () => number;
  readonly defaultAccountQuota: number;
  private readonly listeners = new Set<(change: Change) => void>();
  private events: Change[] | null = null;

  /** Bytes free on the disk the database is on (null if unknown). Asked with the box being written to. */
  diskFree: (boxId?: string) => number | null = () => null;

  constructor(db: DB, now: () => number = Date.now, defaultAccountQuota = DEFAULT_ACCOUNT_QUOTA) {
    this.db = db;
    this.now = now;
    this.defaultAccountQuota = defaultAccountQuota;
  }

  onChange(listener: (change: Change) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ── Boxes ────────────────────────────────────────────────────────────────

  createBox(accountId: string, input: { id: string; idx: Buffer; name: Buffer; key: Buffer; settings?: Record<string, unknown> }): Box {
    if (this.box(input.id)) throw fail("box_exists", 409, "A box with that id already exists.");
    if (this.boxByIdx(accountId, input.idx)) throw fail("box_exists", 409, "You already have a box with that name.");
    const settings = { ...DEFAULT_SETTINGS, ...(input.settings ? validateSettings(input.settings) : {}) };
    this.db
      .prepare("INSERT INTO boxes (id, account_id, idx, name, key, settings, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(input.id, accountId, input.idx, input.name, input.key, JSON.stringify(settings), this.now());
    return this.box(input.id)!;
  }

  box(id: string): Box | undefined {
    const row = this.db.prepare("SELECT * FROM boxes WHERE id = ?").get(id) as BoxRow | undefined;
    return row && toBox(row);
  }

  boxByIdx(accountId: string, idx: Buffer): Box | undefined {
    const row = this.db.prepare("SELECT * FROM boxes WHERE account_id = ? AND idx = ?").get(accountId, idx) as BoxRow | undefined;
    return row && toBox(row);
  }

  /** A box, only if it belongs to this account. Someone else's box looks exactly like no box. */
  ownBox(accountId: string, id: string): Box {
    const box = this.box(id);
    if (!box || box.accountId !== accountId) throw fail("no_such_box", 404, "You don't have that box.", "List your boxes with: cardboard boxes");
    return box;
  }

  boxes(accountId: string): Box[] {
    return (this.db.prepare("SELECT * FROM boxes WHERE account_id = ? ORDER BY created_at").all(accountId) as unknown as BoxRow[]).map(toBox);
  }

  updateSettings(boxId: string, patch: Record<string, unknown>): Box {
    const box = this.requireBox(boxId);
    const next: BoxSettings = { ...box.settings, ...validateSettings(patch) };
    this.db.prepare("UPDATE boxes SET settings = ? WHERE id = ?").run(JSON.stringify(next), boxId);
    return { ...box, settings: next };
  }

  setProfile(boxId: string, profile: Buffer | null) {
    this.db.prepare("UPDATE boxes SET profile = ? WHERE id = ?").run(profile, boxId);
  }

  rename(boxId: string, idx: Buffer, name: Buffer) {
    const box = this.requireBox(boxId);
    const clash = this.boxByIdx(box.accountId, idx);
    if (clash && clash.id !== boxId) throw fail("box_exists", 409, "You already have a box with that name.");
    this.db.prepare("UPDATE boxes SET idx = ?, name = ? WHERE id = ?").run(idx, name, boxId);
  }

  /**
   * Crypto-shredding: the sealed box key, every item, every version, every
   * tape and every log line go. secure_delete overwrites the freed pages and
   * the WAL is checkpointed, so nothing is left on disk, sealed or not.
   */
  shredBox(boxId: string) {
    transaction(this.db, () => this.db.prepare("DELETE FROM boxes WHERE id = ?").run(boxId));
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }

  private requireBox(id: string): Box {
    const box = this.box(id);
    if (!box) throw fail("no_such_box", 404, "That box no longer exists.");
    return box;
  }

  // ── Transactions & events ────────────────────────────────────────────────

  /** Runs `fn` in one SQLite transaction; change events go out only after COMMIT. */
  private tx<T>(fn: () => T): T {
    if (this.events) return fn();
    const events: Change[] = [];
    this.events = events;
    let result: T;
    try {
      result = transaction(this.db, fn);
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

  /** Several writes that all happen, or none do. */
  batch<T>(fn: () => T): T {
    return this.tx(fn);
  }

  // ── Items ────────────────────────────────────────────────────────────────

  get(boxId: string, idx: Buffer): StoredItem | null {
    const row = this.db.prepare("SELECT * FROM items WHERE box_id = ? AND idx = ?").get(boxId, idx) as ItemRow | undefined;
    if (!row || isExpired(row.expires_at, this.now())) return null;
    return toItem(row);
  }

  put(boxId: string, item: Sealed, options: WriteOptions, actor: string): { version: number; size: number } {
    return this.tx(() => {
      const box = this.requireBox(boxId);
      const ttl = options.ttlMs === undefined ? box.settings.defaultTtlMs : options.ttlMs;
      return this.store(box, item, { expiresAt: ttl ? this.now() + ttl : null, ifVersion: options.ifVersion, actor });
    });
  }

  private store(box: Box, item: Sealed, options: { expiresAt: number | null; ifVersion: number | undefined; actor: string }): { version: number; size: number } {
    if (item.name.length > MAX_NAME_BYTES) throw fail("bad_key", 400, "That key name is too long.");
    const size = item.value.length;
    if (size > box.settings.maxItemBytes) {
      throw fail(
        "too_large",
        413,
        `That value is ${formatBytes(size)} sealed; this box allows up to ${formatBytes(box.settings.maxItemBytes)} per item.`,
        "Split it into smaller items, or raise maxItemBytes in the box settings.",
      );
    }
    const now = this.now();
    let existing = this.db.prepare("SELECT version, size, expires_at FROM items WHERE box_id = ? AND idx = ?").get(box.id, item.idx) as
      | { version: number; size: number; expires_at: number | null }
      | undefined;
    if (existing && isExpired(existing.expires_at, now)) {
      this.purge(box.id, item.idx, "expired");
      existing = undefined;
    }
    if (options.ifVersion === 0 && existing) throw fail("already_exists", 409, "That key already exists.", "Use put or patch to change it.");
    if (options.ifVersion !== undefined && (existing?.version ?? 0) !== options.ifVersion) {
      throw fail(
        "version_conflict",
        409,
        existing
          ? `That item changed since you read it (it's at version ${existing.version}, you expected ${options.ifVersion}).`
          : "That item doesn't exist any more.",
        "Read it again and retry.",
      );
    }
    const used = this.stats(box.id).bytes - (existing?.size ?? 0);
    if (used + size > box.settings.quotaBytes) {
      throw fail(
        "quota_exceeded",
        507,
        `This box is full (${formatBytes(used)} of ${formatBytes(box.settings.quotaBytes)}).`,
        "Delete things you don't need, or raise quotaBytes in the box settings.",
      );
    }
    const accountQuota = this.accountQuota(box.accountId);
    const free = this.diskFree(box.id);
    if (free !== null && free - size < MIN_FREE_DISK) {
      throw fail(
        "disk_full",
        507,
        "The computer Cardboard runs on is nearly out of space, so it isn't taking new data.",
        `Free up space on that computer (Cardboard keeps ${formatBytes(MIN_FREE_DISK)} free), then try again.`,
      );
    }
    const accountUsed = this.accountBytes(box.accountId) - (existing?.size ?? 0);
    if (accountUsed + size > accountQuota) {
      throw fail(
        "account_full",
        507,
        `Your Cardboard is full (${formatBytes(accountUsed)} of ${formatBytes(accountQuota)}).`,
        "Delete things you don't need, or ask whoever runs this Cardboard for more room.",
      );
    }
    const version = this.writeVersion(box.id, item, options.expiresAt, options.actor);
    return { version, size };
  }

  /** Writes one version (or, with value null, a deletion) to items + history. */
  private writeVersion(boxId: string, item: { idx: Buffer; name: Buffer; value: Buffer | null }, expiresAt: number | null, actor: string): number {
    const now = this.now();
    const last = this.db
      .prepare("SELECT MAX(version) AS v FROM (SELECT version FROM history WHERE box_id = ? AND idx = ? UNION ALL SELECT version FROM items WHERE box_id = ? AND idx = ?)")
      .get(boxId, item.idx, boxId, item.idx) as { v: number | null };
    const version = (last.v ?? 0) + 1;
    const idx = b64(item.idx)!;
    // The version being replaced moves its value into history now; until then it was kept once, in items.
    this.db
      .prepare(
        `UPDATE history SET value = (SELECT i.value FROM items i WHERE i.box_id = history.box_id AND i.idx = history.idx)
          WHERE box_id = ? AND idx = ? AND value IS NULL
            AND version = (SELECT i.version FROM items i WHERE i.box_id = ? AND i.idx = ?)`,
      )
      .run(boxId, item.idx, boxId, item.idx);
    if (item.value) {
      this.db
        .prepare(
          `INSERT INTO items (box_id, idx, name, value, size, version, created_at, updated_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (box_id, idx) DO UPDATE SET
             name = excluded.name, value = excluded.value, size = excluded.size,
             version = excluded.version, updated_at = excluded.updated_at, expires_at = excluded.expires_at`,
        )
        .run(boxId, item.idx, item.name, item.value, item.value.length, version, now, now, expiresAt);
      this.events?.push({ boxId, type: "put", idx, name: b64(item.name), value: b64(item.value)!, version, at: now });
    } else {
      this.db.prepare("DELETE FROM items WHERE box_id = ? AND idx = ?").run(boxId, item.idx);
      this.events?.push({ boxId, type: "delete", idx, name: b64(item.name), version, at: now });
    }
    this.db
      .prepare("INSERT INTO history (box_id, idx, version, name, value, size, at, actor) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)")
      .run(boxId, item.idx, version, item.name, item.value?.length ?? 0, now, actor);
    return version;
  }

  /** History rows, newest first, with the live version's value filled in from items. */
  private historyRows(boxId: string, idx: Buffer, limit = -1): HistoryRow[] {
    const rows = this.db.prepare("SELECT * FROM history WHERE box_id = ? AND idx = ? ORDER BY version DESC LIMIT ?").all(boxId, idx, limit) as unknown as HistoryRow[];
    return this.withLiveValues(boxId, rows);
  }

  private withLiveValues(boxId: string, rows: HistoryRow[]): HistoryRow[] {
    const live = this.db.prepare("SELECT version, value FROM items WHERE box_id = ? AND idx = ?");
    return rows.map((row) => {
      if (row.value !== null) return row;
      const item = live.get(boxId, row.idx) as { version: number; value: Uint8Array } | undefined;
      return item && item.version === row.version ? { ...row, value: item.value } : row;
    });
  }

  /** Removes an item and all of its history (expiry, or `purge: true`). Returns its sealed name, if it had one. */
  private purge(boxId: string, idx: Buffer, reason: "expired" | "purged"): Buffer | null {
    const row = this.db.prepare("SELECT name FROM items WHERE box_id = ? AND idx = ?").get(boxId, idx) as { name: Uint8Array } | undefined;
    const hist = this.db.prepare("SELECT name FROM history WHERE box_id = ? AND idx = ? ORDER BY version DESC LIMIT 1").get(boxId, idx) as
      | { name: Uint8Array }
      | undefined;
    this.db.prepare("DELETE FROM items WHERE box_id = ? AND idx = ?").run(boxId, idx);
    this.db.prepare("DELETE FROM history WHERE box_id = ? AND idx = ?").run(boxId, idx);
    const name = row?.name ?? hist?.name;
    if (name) this.events?.push({ boxId, type: "delete", idx: b64(idx)!, name: b64(name), version: null, at: this.now(), reason });
    return name ? Buffer.from(name) : null;
  }

  /** Deletes an item. It stays in history (so it can be undone) unless `purge` is set. Returns its sealed name. */
  delete(boxId: string, idx: Buffer, options: { purge?: boolean }, actor: string): { deleted: boolean; name: Buffer | null } {
    return this.tx(() => {
      if (options.purge) {
        const name = this.purge(boxId, idx, "purged");
        return { deleted: name !== null, name };
      }
      const row = this.db.prepare("SELECT name, expires_at FROM items WHERE box_id = ? AND idx = ?").get(boxId, idx) as
        | { name: Uint8Array; expires_at: number | null }
        | undefined;
      if (!row) return { deleted: false, name: null };
      const name = Buffer.from(row.name);
      if (isExpired(row.expires_at, this.now())) {
        this.purge(boxId, idx, "expired");
        return { deleted: false, name };
      }
      this.writeVersion(boxId, { idx, name, value: null }, null, actor);
      return { deleted: true, name };
    });
  }

  /** Live items, in idx order (names are sealed, so the SDK sorts after opening them). */
  list(boxId: string, options: { after?: Buffer; limit?: number; values?: boolean }): { items: StoredItem[]; next: string | null } {
    const limit = clampLimit(options.limit);
    const rows = this.db
      .prepare(
        `SELECT idx, name, ${options.values ? "value" : "NULL AS value"}, size, version, created_at, updated_at, expires_at FROM items
         WHERE box_id = ? AND idx > ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY idx LIMIT ?`,
      )
      .all(boxId, options.after ?? Buffer.alloc(0), this.now(), limit + 1) as unknown as ItemRow[];
    const page = rows.slice(0, limit).map(toItem);
    return { items: page, next: rows.length > limit ? b64(page.at(-1)!.idx) : null };
  }

  history(boxId: string, idx: Buffer, limit = 50): VersionInfo[] {
    return this.historyRows(boxId, idx, clampLimit(limit)).map(toVersion);
  }

  /**
   * Restores the previous version of an item (or version `to`), exactly as it
   * was sealed. The restore is a new version, so undoing twice is a redo.
   */
  undo(boxId: string, idx: Buffer, options: { to?: number }, actor: string): { version: number; restored: number; deleted: boolean; name: Buffer } {
    return this.tx(() => {
      const box = this.requireBox(boxId);
      const rows = this.historyRows(boxId, idx);
      if (rows.length === 0) throw fail("nothing_to_undo", 404, "There's no history for that item.");
      const target = options.to === undefined ? rows[1] : rows.find((r) => r.version === options.to);
      if (options.to !== undefined && !target) {
        throw fail("no_such_version", 404, `That item has no version ${options.to}.`, `Versions kept: ${rows.map((r) => r.version).join(", ")}.`);
      }
      const current = this.get(boxId, idx);
      const name = Buffer.from(rows[0]!.name);
      if (!target || target.value === null) {
        if (!current) throw fail("nothing_to_undo", 404, "That item is already gone.");
        const version = this.writeVersion(boxId, { idx, name: current.name, value: null }, null, actor);
        return { version, restored: target?.version ?? 0, deleted: true, name: current.name };
      }
      const ttl = box.settings.defaultTtlMs;
      const result = this.store(
        box,
        { idx, name: Buffer.from(target.name), value: Buffer.from(target.value) },
        { expiresAt: ttl ? this.now() + ttl : null, ifVersion: undefined, actor },
      );
      return { version: result.version, restored: target.version, deleted: false, name };
    });
  }

  /** Puts every item in the box back the way it was at time `to`. */
  rewind(boxId: string, to: number, actor: string): { changed: number } {
    const box = this.requireBox(boxId);
    const now = this.now();
    if (to > now) throw fail("bad_time", 400, "You can only rewind to a moment in the past.");
    if (to < now - box.settings.historyDays * DAY) {
      throw fail(
        "too_far_back",
        400,
        `This box keeps ${box.settings.historyDays} days of history, so it can't rewind ${describeDuration(now - to)}.`,
        "Raise historyDays in the box settings to keep more.",
      );
    }
    return this.tx(() => {
      const rows = this.withLiveValues(boxId, this.db.prepare("SELECT * FROM history WHERE box_id = ? ORDER BY idx, version").all(boxId) as unknown as HistoryRow[]);
      const byIdx = new Map<string, HistoryRow[]>();
      for (const row of rows) {
        const key = b64(row.idx)!;
        let list = byIdx.get(key);
        if (!list) byIdx.set(key, (list = []));
        list.push(row);
      }
      let changed = 0;
      for (const list of byIdx.values()) {
        const idx = Buffer.from(list[0]!.idx);
        const target = list.filter((r) => r.at <= to).at(-1);
        const live = this.get(boxId, idx);
        if (!target || target.value === null) {
          if (live) {
            this.writeVersion(boxId, { idx, name: live.name, value: null }, null, actor);
            changed++;
          }
        } else if (!live || live.version !== target.version) {
          this.store(box, { idx, name: Buffer.from(target.name), value: Buffer.from(target.value) }, { expiresAt: null, ifVersion: undefined, actor });
          changed++;
        }
      }
      return { changed };
    });
  }

  stats(boxId: string): { items: number; bytes: number } {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS b FROM items WHERE box_id = ? AND (expires_at IS NULL OR expires_at > ?)")
      .get(boxId, this.now()) as { n: number; b: number };
    return { items: row.n, bytes: row.b };
  }

  accountBytes(accountId: string): number {
    const row = this.db
      .prepare("SELECT COALESCE(SUM(i.size), 0) AS b FROM items i JOIN boxes b ON b.id = i.box_id WHERE b.account_id = ?")
      .get(accountId) as { b: number };
    return row.b;
  }

  accountQuota(accountId: string): number {
    const row = this.db.prepare("SELECT quota_bytes FROM accounts WHERE id = ?").get(accountId) as { quota_bytes: number | null } | undefined;
    return row?.quota_bytes ?? this.defaultAccountQuota;
  }

  /**
   * Housekeeping, run every minute: deletes expired items (with their history,
   * so expired data can't be undone back into existence) and prunes old versions.
   */
  sweep(): { expired: Map<string, number> } {
    const now = this.now();
    const expired = new Map<string, number>();
    const rows = this.db.prepare("SELECT box_id, idx FROM items WHERE expires_at IS NOT NULL AND expires_at <= ?").all(now) as Array<{
      box_id: string;
      idx: Uint8Array;
    }>;
    if (rows.length > 0) {
      this.tx(() => {
        for (const row of rows) {
          this.purge(row.box_id, Buffer.from(row.idx), "expired");
          expired.set(row.box_id, (expired.get(row.box_id) ?? 0) + 1);
        }
      });
    }
    for (const box of this.db.prepare("SELECT id, settings FROM boxes").all() as Array<{ id: string; settings: string }>) {
      const days = { ...DEFAULT_SETTINGS, ...(JSON.parse(box.settings) as Partial<BoxSettings>) }.historyDays;
      const cutoff = now - days * DAY;
      this.db
        .prepare(
          `DELETE FROM history WHERE box_id = ? AND at < ? AND version < (
             SELECT MAX(h.version) FROM history h WHERE h.box_id = history.box_id AND h.idx = history.idx)`,
        )
        .run(box.id, cutoff);
      this.db
        .prepare(
          `DELETE FROM history WHERE box_id = ? AND at < ? AND value IS NULL AND NOT EXISTS (
             SELECT 1 FROM items i WHERE i.box_id = history.box_id AND i.idx = history.idx)`,
        )
        .run(box.id, cutoff);
    }
    return { expired };
  }
}

function toBox(row: BoxRow): Box {
  return {
    id: row.id,
    accountId: row.account_id,
    idx: Buffer.from(row.idx),
    name: Buffer.from(row.name),
    key: Buffer.from(row.key),
    profile: row.profile ? Buffer.from(row.profile) : null,
    settings: { ...DEFAULT_SETTINGS, ...(JSON.parse(row.settings) as Partial<BoxSettings>) },
    createdAt: row.created_at,
  };
}

function toItem(row: ItemRow): StoredItem {
  return {
    idx: Buffer.from(row.idx),
    name: Buffer.from(row.name),
    value: row.value ? Buffer.from(row.value) : Buffer.alloc(0),
    version: row.version,
    size: row.size,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
  };
}

function toVersion(row: HistoryRow): VersionInfo {
  return {
    version: row.version,
    at: row.at,
    deleted: row.value === null,
    name: Buffer.from(row.name),
    value: row.value ? Buffer.from(row.value) : null,
    size: row.size,
    actor: row.actor,
  };
}

function isExpired(expiresAt: number | null, now: number): boolean {
  return expiresAt !== null && expiresAt <= now;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return 100;
  return Math.min(1000, Math.max(1, Math.floor(limit)));
}

export function validateSettings(patch: Record<string, unknown>): Partial<BoxSettings> {
  const out: Partial<BoxSettings> = {};
  for (const [field, value] of Object.entries(patch)) {
    switch (field) {
      case "origins": {
        if (!Array.isArray(value)) throw badSetting('origins must be a list, like ["https://notes.example.com"].');
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
        throw badSetting(`Unknown setting "${field}". Settings are origins, quotaBytes, maxItemBytes, historyDays, secrets and defaultTtl.`);
    }
  }
  return out;
}

function badSetting(message: string) {
  return fail("bad_setting", 400, message);
}
