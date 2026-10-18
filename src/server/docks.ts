import { fail } from "../shared/errors.ts";
import { parseDuration } from "../shared/duration.ts";
import { formatBytes, parseSize } from "../shared/size.ts";
import { validateShape, type DockShape } from "../shared/customs.ts";
import { hmac } from "./crypto.ts";
import { transaction, type DB } from "./db.ts";

/**
 * Docks: meeting points where your apps swap parcels without learning who's who.
 *
 * At each dock an app is known only by a pseudonym (a keyed hash of its box id,
 * different at every dock, so apps can't link sightings across docks). Parcels
 * are sealed by the sending app with the dock key, which only apps you approved
 * have; the server carries them, enforces size and rate limits, and deletes
 * each one as soon as everyone it was meant for has picked it up. Customs
 * (secrets, personal data, manifest, booby traps) runs inside the SDK, at both
 * ends, because the server can't see inside a parcel.
 */

const DAY = 24 * 60 * 60 * 1000;
/** An app can have at most this many unapproved requests open. */
const MAX_OPEN_REQUESTS = 10;
const MAX_SEALED_OVERHEAD = 1024;

export interface DockSettings {
  ttlMs: number;
  maxParcelBytes: number;
  secrets: "block" | "allow";
  personal: "redact" | "block" | "allow";
  shape: DockShape | null;
  ratePerMinute: number;
  /** Keep parcels until they expire, even after everyone has picked them up. */
  keepAfterDelivery: boolean;
}

export const DEFAULT_DOCK_SETTINGS: DockSettings = {
  ttlMs: 7 * DAY,
  maxParcelBytes: 256 * 1024,
  secrets: "block",
  personal: "redact",
  shape: null,
  ratePerMinute: 120,
  keepAfterDelivery: false,
};

export interface Dock {
  id: string;
  accountId: string;
  idx: Buffer;
  /** Sealed by the account key. null while an app has asked for a dock you haven't made yet. */
  name: Buffer | null;
  key: Buffer | null;
  settings: DockSettings;
  createdAt: number;
}

export interface Berth {
  dockId: string;
  boxId: string;
  tag: string;
  send: boolean;
  receive: boolean;
  wantSend: boolean;
  wantReceive: boolean;
  denied: boolean;
  requestedAt: number | null;
  approvedAt: number | null;
  cursor: number;
  /** The dock key sealed by this box's key. */
  key: Buffer | null;
  /** The dock's name sealed by the asking app's box key. */
  ask: Buffer | null;
}

/** What a receiving app gets. `from` and `to` are pseudonyms; `body` is sealed. */
export interface Parcel {
  id: string;
  seq: number;
  from: string;
  to: string | null;
  body: string;
  sentAt: number;
  expiresAt: number;
}

export interface ParcelEvent {
  dockId: string;
  parcel: Parcel;
}

interface DockRow {
  id: string;
  account_id: string;
  idx: Uint8Array;
  name: Uint8Array | null;
  key: Uint8Array | null;
  settings: string;
  created_at: number;
}

interface BerthRow {
  dock_id: string;
  box_id: string;
  tag: string;
  can_send: number;
  can_receive: number;
  want_send: number;
  want_receive: number;
  denied: number;
  requested_at: number | null;
  approved_at: number | null;
  cursor: number;
  key: Uint8Array | null;
  ask: Uint8Array | null;
}

interface ParcelRow {
  id: string;
  dock_id: string;
  seq: number;
  sender_tag: string;
  sender_box: string;
  to_tag: string | null;
  body: Uint8Array;
  size: number;
  sent_at: number;
  expires_at: number;
}

export class Docks {
  private readonly db: DB;
  private readonly now: () => number;
  private readonly tagKey: Buffer;
  private readonly sends = new Map<string, number[]>();
  private readonly listeners = new Set<(event: ParcelEvent) => void>();

  constructor(db: DB, now: () => number, tagKey: Buffer) {
    this.db = db;
    this.now = now;
    this.tagKey = tagKey;
  }

  onParcel(listener: (event: ParcelEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ── Docks ────────────────────────────────────────────────────────────────

  /** You open a dock. If an app already asked for one with this name, this is that dock. */
  create(accountId: string, input: { id: string; idx: Buffer; name: Buffer; key: Buffer; settings?: Record<string, unknown> }): Dock {
    return transaction(this.db, () => {
      const existing = this.find(accountId, input.idx);
      if (existing?.key) throw fail("dock_exists", 409, "You already have a dock with that name.");
      const settings = { ...DEFAULT_DOCK_SETTINGS, ...(input.settings ? validateDockSettings(input.settings) : {}) };
      if (existing) {
        this.db.prepare("UPDATE docks SET name = ?, key = ?, settings = ? WHERE id = ?").run(input.name, input.key, JSON.stringify(settings), existing.id);
        return this.get(existing.id)!;
      }
      if (this.get(input.id)) throw fail("dock_exists", 409, "A dock with that id already exists.");
      this.db
        .prepare("INSERT INTO docks (id, account_id, idx, name, key, settings, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(input.id, accountId, input.idx, input.name, input.key, JSON.stringify(settings), this.now());
      return this.get(input.id)!;
    });
  }

  get(id: string): Dock | undefined {
    const row = this.db.prepare("SELECT * FROM docks WHERE id = ?").get(id) as DockRow | undefined;
    return row && toDock(row);
  }

  find(accountId: string, idx: Buffer): Dock | undefined {
    const row = this.db.prepare("SELECT * FROM docks WHERE account_id = ? AND idx = ?").get(accountId, idx) as DockRow | undefined;
    return row && toDock(row);
  }

  /** A dock, only if it belongs to this account. */
  own(accountId: string, id: string): Dock {
    const dock = this.get(id);
    if (!dock || dock.accountId !== accountId) throw fail("no_such_dock", 404, "You don't have that dock.", "List your docks with: cardboard docks");
    return dock;
  }

  list(accountId: string): Dock[] {
    return (this.db.prepare("SELECT * FROM docks WHERE account_id = ? ORDER BY created_at").all(accountId) as unknown as DockRow[]).map(toDock);
  }

  updateSettings(dockId: string, patch: Record<string, unknown>): DockSettings {
    const dock = this.get(dockId);
    if (!dock) throw fail("no_such_dock", 404, "That dock no longer exists.");
    const next = { ...dock.settings, ...validateDockSettings(patch) };
    this.db.prepare("UPDATE docks SET settings = ? WHERE id = ?").run(JSON.stringify(next), dockId);
    return next;
  }

  rename(dockId: string, idx: Buffer, name: Buffer) {
    const dock = this.get(dockId);
    if (!dock) throw fail("no_such_dock", 404, "That dock no longer exists.");
    const clash = this.find(dock.accountId, idx);
    if (clash && clash.id !== dockId) throw fail("dock_exists", 409, "You already have a dock with that name.");
    this.db.prepare("UPDATE docks SET idx = ?, name = ? WHERE id = ?").run(idx, name, dockId);
  }

  /** Deletes the dock, its sealed key, its berths and every parcel in flight. */
  shred(dockId: string) {
    transaction(this.db, () => this.db.prepare("DELETE FROM docks WHERE id = ?").run(dockId));
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }

  /** An app's pseudonym at a dock. Stable at that dock, unrelated to its name at any other. */
  tagFor(dockId: string, boxId: string): string {
    return `berth-${hmac(this.tagKey, `${dockId}|${boxId}`).toString("hex").slice(0, 12)}`;
  }

  // ── Berths ───────────────────────────────────────────────────────────────

  berth(dockId: string, boxId: string): Berth | undefined {
    const row = this.db.prepare("SELECT * FROM berths WHERE dock_id = ? AND box_id = ?").get(dockId, boxId) as BerthRow | undefined;
    return row && toBerth(row);
  }

  berths(dockId: string): Berth[] {
    return (this.db.prepare("SELECT * FROM berths WHERE dock_id = ? ORDER BY approved_at, requested_at").all(dockId) as unknown as BerthRow[]).map(toBerth);
  }

  berthsOf(boxId: string): Berth[] {
    return (this.db.prepare("SELECT * FROM berths WHERE box_id = ?").all(boxId) as unknown as BerthRow[]).map(toBerth);
  }

  /**
   * You give an app a berth or change what it may do. Neither send nor receive
   * takes it off the dock. `key` is the dock key sealed for that app's box,
   * needed the first time an app is let on.
   */
  grant(dockId: string, boxId: string, can: { send?: boolean; receive?: boolean }, key: Buffer | null): Berth | null {
    const existing = this.berth(dockId, boxId);
    const send = can.send ?? existing?.send ?? false;
    const receive = can.receive ?? existing?.receive ?? false;
    if (!send && !receive) {
      this.remove(dockId, boxId);
      return null;
    }
    const sealedKey = key ?? existing?.key ?? null;
    if (!sealedKey) throw fail("bad_request", 400, "Letting an app onto a dock needs the dock key sealed for it.", "The CLI and dashboard do this for you.");
    this.db
      .prepare(
        `INSERT INTO berths (dock_id, box_id, tag, can_send, can_receive, want_send, want_receive, denied, approved_at, key)
         VALUES (?, ?, ?, ?, ?, 0, 0, 0, ?, ?)
         ON CONFLICT (dock_id, box_id) DO UPDATE SET can_send = excluded.can_send, can_receive = excluded.can_receive,
           want_send = 0, want_receive = 0, denied = 0, approved_at = excluded.approved_at, key = excluded.key`,
      )
      .run(dockId, boxId, this.tagFor(dockId, boxId), send ? 1 : 0, receive ? 1 : 0, this.now(), sealedKey);
    return this.berth(dockId, boxId)!;
  }

  /**
   * An app asks to dock. If you haven't made the dock yet, a placeholder holds
   * its place (no name, no key) until you do. `ask` is the dock's name sealed
   * by the app, so you can read the request. Refused requests stay refused.
   */
  request(accountId: string, input: { id: string; idx: Buffer; ask: Buffer | null }, boxId: string, want: { send?: boolean; receive?: boolean }): { dock: Dock; berth: Berth } {
    return transaction(this.db, () => {
      let dock = this.find(accountId, input.idx);
      if (!dock) {
        const open = this.db
          .prepare("SELECT COUNT(*) AS n FROM berths WHERE box_id = ? AND (want_send > can_send OR want_receive > can_receive)")
          .get(boxId) as { n: number };
        if (open.n >= MAX_OPEN_REQUESTS) {
          throw fail("too_many_requests", 429, "This app already has a lot of docking requests waiting.", "Approve or deny them in the dashboard first.");
        }
        this.db.prepare("INSERT INTO docks (id, account_id, idx, created_at) VALUES (?, ?, ?, ?)").run(input.id, accountId, input.idx, this.now());
        dock = this.get(input.id)!;
      }
      const existing = this.berth(dock.id, boxId);
      if (existing?.denied) return { dock, berth: existing };
      this.db
        .prepare(
          `INSERT INTO berths (dock_id, box_id, tag, want_send, want_receive, requested_at, ask)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (dock_id, box_id) DO UPDATE SET
             want_send = MAX(berths.want_send, excluded.want_send),
             want_receive = MAX(berths.want_receive, excluded.want_receive),
             requested_at = COALESCE(berths.requested_at, excluded.requested_at),
             ask = COALESCE(excluded.ask, berths.ask)`,
        )
        .run(dock.id, boxId, this.tagFor(dock.id, boxId), want.send ? 1 : 0, want.receive ? 1 : 0, this.now(), input.ask);
      return { dock, berth: this.berth(dock.id, boxId)! };
    });
  }

  approve(dockId: string, boxId: string, key: Buffer | null): Berth {
    const berth = this.berth(dockId, boxId);
    if (!berth || (!berth.wantSend && !berth.wantReceive && !berth.send && !berth.receive)) {
      throw fail("no_request", 404, "That app hasn't asked to dock there.");
    }
    return this.grant(dockId, boxId, { send: berth.send || berth.wantSend, receive: berth.receive || berth.wantReceive }, key)!;
  }

  /** Says no: takes away anything already granted (including its copy of the key), and stops the app asking again. */
  deny(dockId: string, boxId: string) {
    const berth = this.berth(dockId, boxId);
    if (!berth) throw fail("no_request", 404, "That app hasn't asked to dock there.");
    this.db
      .prepare("UPDATE berths SET can_send = 0, can_receive = 0, want_send = 0, want_receive = 0, denied = 1, key = NULL WHERE dock_id = ? AND box_id = ?")
      .run(dockId, boxId);
    this.collect(dockId);
  }

  remove(dockId: string, boxId: string): boolean {
    const { changes } = this.db.prepare("DELETE FROM berths WHERE dock_id = ? AND box_id = ?").run(dockId, boxId);
    if (Number(changes) > 0) this.collect(dockId);
    return Number(changes) > 0;
  }

  /** Requests waiting for you. */
  pending(accountId: string): Array<{ dock: Dock; berth: Berth }> {
    const rows = this.db
      .prepare(
        `SELECT b.* FROM berths b JOIN docks d ON d.id = b.dock_id
         WHERE d.account_id = ? AND b.denied = 0 AND (b.want_send > b.can_send OR b.want_receive > b.can_receive)
         ORDER BY b.requested_at`,
      )
      .all(accountId) as unknown as BerthRow[];
    return rows.map((r) => ({ dock: this.get(r.dock_id)!, berth: toBerth(r) }));
  }

  // ── Parcels ──────────────────────────────────────────────────────────────

  send(dock: Dock, from: Berth, parcel: { id: string; body: Buffer }, to?: string): { id: string; seq: number; recipients: number } {
    const now = this.now();
    const rateKey = `${dock.id}|${from.boxId}`;
    const recent = (this.sends.get(rateKey) ?? []).filter((t) => t > now - 60_000);
    if (recent.length >= dock.settings.ratePerMinute) {
      throw fail("dock_rate", 429, `That's more than ${dock.settings.ratePerMinute} parcels a minute on this dock.`, "Batch them into fewer, bigger parcels.");
    }
    if (parcel.body.length > dock.settings.maxParcelBytes + MAX_SEALED_OVERHEAD) {
      throw fail(
        "parcel_too_large",
        413,
        `That parcel is ${formatBytes(parcel.body.length)} sealed; this dock carries up to ${formatBytes(dock.settings.maxParcelBytes)}.`,
        "Split it up, or raise maxParcelBytes in the dock settings.",
      );
    }
    const receivers = this.berths(dock.id).filter((b) => b.receive && b.tag !== from.tag);
    if (to !== undefined && !receivers.some((r) => r.tag === to)) {
      throw fail("no_such_berth", 404, `Nobody on this dock who can receive goes by ${to}.`, "Reply to the `from` of a parcel you received.");
    }
    if (this.db.prepare("SELECT 1 FROM parcels WHERE id = ?").get(parcel.id)) throw fail("parcel_exists", 409, "A parcel with that id was already sent.");
    const expiresAt = now + dock.settings.ttlMs;
    const seq = transaction(this.db, () => {
      const { last_seq } = this.db.prepare("UPDATE docks SET last_seq = last_seq + 1 WHERE id = ? RETURNING last_seq").get(dock.id) as { last_seq: number };
      this.db
        .prepare(
          `INSERT INTO parcels (id, dock_id, seq, sender_tag, sender_box, to_tag, body, size, sent_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(parcel.id, dock.id, last_seq, from.tag, from.boxId, to ?? null, parcel.body, parcel.body.length, now, expiresAt);
      return last_seq;
    });
    recent.push(now);
    this.sends.set(rateKey, recent);

    const event: Parcel = { id: parcel.id, seq, from: from.tag, to: to ?? null, body: parcel.body.toString("base64url"), sentAt: now, expiresAt };
    for (const listener of this.listeners) {
      try {
        listener({ dockId: dock.id, parcel: event });
      } catch {
        // A broken watcher must never break a send.
      }
    }
    return { id: parcel.id, seq, recipients: to ? 1 : receivers.length };
  }

  /** Parcels waiting for `berth`: addressed to everyone or to it, not sent by it, not expired. */
  receive(dock: Dock, berth: Berth, options: { after?: number; limit?: number } = {}): Parcel[] {
    const after = options.after ?? berth.cursor;
    const limit = Math.min(500, Math.max(1, Math.floor(options.limit ?? 100)));
    const rows = this.db
      .prepare(
        `SELECT * FROM parcels WHERE dock_id = ? AND seq > ? AND sender_tag != ? AND (to_tag IS NULL OR to_tag = ?)
           AND expires_at > ? ORDER BY seq LIMIT ?`,
      )
      .all(dock.id, after, berth.tag, berth.tag, this.now(), limit) as unknown as ParcelRow[];
    return rows.map(toParcel);
  }

  /** Marks everything up to `seq` as picked up, and clears out fully delivered parcels. */
  ack(dock: Dock, berth: Berth, seq: number): number {
    const cursor = Math.max(berth.cursor, Math.floor(seq));
    this.db.prepare("UPDATE berths SET cursor = ? WHERE dock_id = ? AND box_id = ?").run(cursor, dock.id, berth.boxId);
    this.collect(dock.id);
    return cursor;
  }

  /**
   * Deletes parcels that every intended receiver has picked up. Parcels nobody
   * can receive yet stay until they expire, so an app that docks later still
   * finds its deposits.
   */
  collect(dockId: string) {
    const dock = this.get(dockId);
    if (!dock || dock.settings.keepAfterDelivery) return;
    const receivers = this.berths(dockId).filter((b) => b.receive);
    const maxCursor = Math.max(0, ...receivers.map((r) => r.cursor));
    if (maxCursor === 0) return;
    const rows = this.db.prepare("SELECT seq, sender_tag, to_tag FROM parcels WHERE dock_id = ? AND seq <= ?").all(dockId, maxCursor) as Array<{
      seq: number;
      sender_tag: string;
      to_tag: string | null;
    }>;
    const done = rows.filter((p) => {
      const intended = receivers.filter((r) => r.tag !== p.sender_tag && (p.to_tag === null || p.to_tag === r.tag));
      return intended.length > 0 && intended.every((r) => r.cursor >= p.seq);
    });
    if (done.length === 0) return;
    const del = this.db.prepare("DELETE FROM parcels WHERE dock_id = ? AND seq = ?");
    transaction(this.db, () => {
      for (const p of done) del.run(dockId, p.seq);
    });
  }

  inFlight(dockId: string): { count: number; bytes: number; unclaimed: number } {
    const all = this.db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS b FROM parcels WHERE dock_id = ?").get(dockId) as { n: number; b: number };
    const receivers = this.berths(dockId).filter((b) => b.receive);
    const rows = this.db.prepare("SELECT sender_tag, to_tag FROM parcels WHERE dock_id = ?").all(dockId) as Array<{ sender_tag: string; to_tag: string | null }>;
    const unclaimed = rows.filter((p) => !receivers.some((r) => r.tag !== p.sender_tag && (p.to_tag === null || p.to_tag === r.tag))).length;
    return { count: all.n, bytes: all.b, unclaimed };
  }

  /** Your view: what's in flight (still sealed; your device opens it) and which of your boxes sent it. */
  peek(dockId: string, limit = 50): Array<Parcel & { senderBox: string }> {
    const rows = this.db.prepare("SELECT * FROM parcels WHERE dock_id = ? ORDER BY seq DESC LIMIT ?").all(dockId, limit) as unknown as ParcelRow[];
    return rows.map((row) => ({ ...toParcel(row), senderBox: row.sender_box }));
  }

  /** Expires old parcels and clears delivered ones. */
  sweep() {
    this.db.prepare("DELETE FROM parcels WHERE expires_at <= ?").run(this.now());
    for (const row of this.db.prepare("SELECT DISTINCT dock_id FROM parcels").all() as Array<{ dock_id: string }>) this.collect(row.dock_id);
    for (const [key, times] of this.sends) {
      if (times.every((t) => t <= this.now() - 60_000)) this.sends.delete(key);
    }
  }
}

function toDock(row: DockRow): Dock {
  return {
    id: row.id,
    accountId: row.account_id,
    idx: Buffer.from(row.idx),
    name: row.name ? Buffer.from(row.name) : null,
    key: row.key ? Buffer.from(row.key) : null,
    settings: { ...DEFAULT_DOCK_SETTINGS, ...(JSON.parse(row.settings) as Partial<DockSettings>) },
    createdAt: row.created_at,
  };
}

function toBerth(row: BerthRow): Berth {
  return {
    dockId: row.dock_id,
    boxId: row.box_id,
    tag: row.tag,
    send: row.can_send === 1,
    receive: row.can_receive === 1,
    wantSend: row.want_send === 1,
    wantReceive: row.want_receive === 1,
    denied: row.denied === 1,
    requestedAt: row.requested_at,
    approvedAt: row.approved_at,
    cursor: row.cursor,
    key: row.key ? Buffer.from(row.key) : null,
    ask: row.ask ? Buffer.from(row.ask) : null,
  };
}

function toParcel(row: ParcelRow): Parcel {
  return {
    id: row.id,
    seq: row.seq,
    from: row.sender_tag,
    to: row.to_tag,
    body: Buffer.from(row.body).toString("base64url"),
    sentAt: row.sent_at,
    expiresAt: row.expires_at,
  };
}

export function validateDockSettings(patch: Record<string, unknown>): Partial<DockSettings> {
  const out: Partial<DockSettings> = {};
  const bad = (message: string) => fail("bad_setting", 400, message);
  for (const [field, value] of Object.entries(patch)) {
    switch (field) {
      case "ttl":
        out.ttlMs = parseDuration(value as string | number);
        break;
      case "maxParcelBytes":
        out.maxParcelBytes = parseSize(value as string | number);
        break;
      case "secrets":
        if (value !== "block" && value !== "allow") throw bad('secrets must be "block" or "allow".');
        out.secrets = value;
        break;
      case "personal":
        if (value !== "redact" && value !== "block" && value !== "allow") throw bad('personal must be "redact", "block" or "allow".');
        out.personal = value;
        break;
      case "shape":
        out.shape = validateShape(typeof value === "string" ? parseJson(value) : value);
        break;
      case "ratePerMinute": {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1 || n > 100_000) throw bad("ratePerMinute must be a whole number from 1 to 100000.");
        out.ratePerMinute = n;
        break;
      }
      case "keepAfterDelivery":
        out.keepAfterDelivery = value === true || value === "true";
        break;
      default:
        throw bad(`Unknown dock setting "${field}". Settings are ttl, maxParcelBytes, secrets, personal, shape, ratePerMinute and keepAfterDelivery.`);
    }
  }
  return out;
}

function parseJson(text: string): unknown {
  if (text === "" || text === "null" || text === "none") return null;
  try {
    return JSON.parse(text);
  } catch {
    throw fail("bad_shape", 400, 'The manifest must be JSON, like {"item":"string","qty":"number?"}.');
  }
}
