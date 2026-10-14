import { createHmac, randomBytes } from "node:crypto";
import { fail } from "../shared/errors.ts";
import { parseDuration } from "../shared/duration.ts";
import { parseSize } from "../shared/size.ts";
import { derive, newId, randomKey, seal, unseal } from "./crypto.ts";
import { inspect, validateShape, type DockShape } from "./customs.ts";
import { transaction, type DB } from "./db.ts";
import type { Vault } from "./vault.ts";

/**
 * Docks: named meeting points where apps swap data without learning who's who.
 *
 * An app takes a berth at a dock to send, receive, or both. At each dock it is
 * known only by a pseudonym (a keyed hash of its box id, different at every
 * dock, so apps can't link sightings across docks). Cardboard carries the
 * parcels, runs them through customs, and deletes each one as soon as everyone
 * it was meant for has picked it up.
 */

const DAY = 24 * 60 * 60 * 1000;
const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** An app can have at most this many unapproved requests open. */
const MAX_OPEN_REQUESTS = 10;

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
  name: string;
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
}

/** What a receiving app gets. `from` and `to` are pseudonyms, never names. */
export interface Parcel {
  id: string;
  seq: number;
  from: string;
  to: string | null;
  body: unknown;
  sentAt: number;
  expiresAt: number;
  redacted: string[];
}

/** The owner's view also says which fields customs stripped (receivers never learn their names). */
export interface FullParcel extends Parcel {
  stripped: string[];
}

export interface ParcelEvent {
  dockId: string;
  parcel: Parcel;
}

interface DockRow {
  id: string;
  name: string;
  wrapped_key: Uint8Array;
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
}

interface ParcelRow {
  seq: number;
  id: string;
  dock_id: string;
  sender_tag: string;
  to_tag: string | null;
  body_enc: Uint8Array;
  sender_enc: Uint8Array;
  size: number;
  sent_at: number;
  expires_at: number;
}

interface DockKeys {
  enc: Buffer;
  tag: Buffer;
}

export class Docks {
  private readonly db: DB;
  private readonly vault: Vault;
  private readonly keys = new Map<string, DockKeys>();
  private readonly sends = new Map<string, number[]>();
  private readonly listeners = new Set<(event: ParcelEvent) => void>();

  constructor(db: DB, vault: Vault) {
    this.db = db;
    this.vault = vault;
  }

  private now() {
    return this.vault.now();
  }

  onParcel(listener: (event: ParcelEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ── Docks ────────────────────────────────────────────────────────────────

  create(name: string, options: { internal?: boolean } = {}): Dock {
    if (!options.internal && !NAME.test(name)) {
      throw fail("bad_dock_name", 400, `"${name}" can't be used as a dock name.`, "Use lowercase letters, numbers and dashes, like shopping-list.");
    }
    if (this.find(name)) throw fail("dock_exists", 409, `There's already a dock called ${name}.`);
    const id = newId("dock");
    const key = randomKey();
    const wrapped = this.vault.wrap(key, `dock-key|${id}`);
    key.fill(0);
    const createdAt = this.now();
    this.db.prepare("INSERT INTO docks (id, name, wrapped_key, settings, created_at) VALUES (?, ?, ?, '{}', ?)").run(id, name, wrapped, createdAt);
    return { id, name, settings: { ...DEFAULT_DOCK_SETTINGS }, createdAt };
  }

  find(name: string): Dock | undefined {
    const row = this.db.prepare("SELECT * FROM docks WHERE name = ?").get(name) as DockRow | undefined;
    return row && toDock(row);
  }

  require(name: string): Dock {
    const dock = this.find(name);
    if (!dock) throw fail("no_such_dock", 404, `There's no dock called ${name}.`, `Make it with: cardboard dock create ${name}`);
    return dock;
  }

  /** Docks whose names start with "__" belong to Cardboard itself (the shake test) and are hidden. */
  list(options: { includeInternal?: boolean } = {}): Dock[] {
    const docks = (this.db.prepare("SELECT * FROM docks ORDER BY name").all() as unknown as DockRow[]).map(toDock);
    return options.includeInternal ? docks : docks.filter((d) => !d.name.startsWith("__"));
  }

  updateSettings(dockId: string, patch: Record<string, unknown>): DockSettings {
    const row = this.db.prepare("SELECT * FROM docks WHERE id = ?").get(dockId) as DockRow | undefined;
    if (!row) throw fail("no_such_dock", 404, "That dock no longer exists.");
    const next = { ...toDock(row).settings, ...validateDockSettings(patch) };
    this.db.prepare("UPDATE docks SET settings = ? WHERE id = ?").run(JSON.stringify(next), dockId);
    return next;
  }

  /** Deletes the dock, its key, its berths and every parcel in flight. */
  shred(dockId: string) {
    transaction(this.db, () => this.db.prepare("DELETE FROM docks WHERE id = ?").run(dockId));
    const keys = this.keys.get(dockId);
    keys?.enc.fill(0);
    keys?.tag.fill(0);
    this.keys.delete(dockId);
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }

  private dockKeys(dockId: string): DockKeys {
    let keys = this.keys.get(dockId);
    if (!keys) {
      const row = this.db.prepare("SELECT wrapped_key FROM docks WHERE id = ?").get(dockId) as { wrapped_key: Uint8Array } | undefined;
      if (!row) throw fail("no_such_dock", 404, "That dock no longer exists.");
      const key = this.vault.unwrap(row.wrapped_key, `dock-key|${dockId}`);
      keys = { enc: derive(key, "dock-enc"), tag: derive(key, "dock-tag") };
      key.fill(0);
      this.keys.set(dockId, keys);
    }
    return keys;
  }

  /** An app's pseudonym at a dock. Stable at that dock, unrelated to its name at any other. */
  tagFor(dockId: string, boxId: string): string {
    return `berth-${createHmac("sha256", this.dockKeys(dockId).tag).update(boxId).digest("hex").slice(0, 12)}`;
  }

  // ── Berths ───────────────────────────────────────────────────────────────

  berth(dockId: string, boxId: string): Berth | undefined {
    const row = this.db.prepare("SELECT * FROM berths WHERE dock_id = ? AND box_id = ?").get(dockId, boxId) as BerthRow | undefined;
    return row && toBerth(row);
  }

  berths(dockId: string): Berth[] {
    return (this.db.prepare("SELECT * FROM berths WHERE dock_id = ? ORDER BY approved_at, requested_at").all(dockId) as unknown as BerthRow[]).map(toBerth);
  }

  berthsOf(boxId: string): Array<Berth & { dock: string }> {
    const rows = this.db
      .prepare("SELECT b.*, d.name AS dock FROM berths b JOIN docks d ON d.id = b.dock_id WHERE b.box_id = ? ORDER BY d.name")
      .all(boxId) as unknown as Array<BerthRow & { dock: string }>;
    return rows.map((r) => ({ ...toBerth(r), dock: r.dock }));
  }

  /** The owner gives an app a berth or changes what it may do. Neither send nor receive = off the dock. */
  grant(dockId: string, boxId: string, can: { send?: boolean; receive?: boolean }): Berth | null {
    const existing = this.berth(dockId, boxId);
    const send = can.send ?? existing?.send ?? false;
    const receive = can.receive ?? existing?.receive ?? false;
    if (!send && !receive) {
      this.remove(dockId, boxId);
      return null;
    }
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO berths (dock_id, box_id, tag, can_send, can_receive, want_send, want_receive, denied, approved_at)
         VALUES (?, ?, ?, ?, ?, 0, 0, 0, ?)
         ON CONFLICT (dock_id, box_id) DO UPDATE SET can_send = excluded.can_send, can_receive = excluded.can_receive,
           want_send = 0, want_receive = 0, denied = 0, approved_at = excluded.approved_at`,
      )
      .run(dockId, boxId, this.tagFor(dockId, boxId), send ? 1 : 0, receive ? 1 : 0, now);
    return this.berth(dockId, boxId)!;
  }

  /**
   * An app asks to dock. Creates the dock if nobody has made it yet, and files a
   * request for the owner. Refused requests stay refused until the owner changes their mind.
   */
  request(dockName: string, boxId: string, want: { send?: boolean; receive?: boolean }): { dock: Dock; berth: Berth } {
    return transaction(this.db, () => {
      let dock = this.find(dockName);
      if (!dock) {
        const open = this.db
          .prepare("SELECT COUNT(*) AS n FROM berths WHERE box_id = ? AND (want_send > can_send OR want_receive > can_receive)")
          .get(boxId) as { n: number };
        if (open.n >= MAX_OPEN_REQUESTS) {
          throw fail("too_many_requests", 429, "This app already has a lot of docking requests waiting.", "Approve or deny them in the dashboard first.");
        }
        dock = this.create(dockName);
      }
      const existing = this.berth(dock.id, boxId);
      if (existing?.denied) return { dock, berth: existing };
      const wantSend = Boolean(want.send) || Boolean(existing?.wantSend);
      const wantReceive = Boolean(want.receive) || Boolean(existing?.wantReceive);
      this.db
        .prepare(
          `INSERT INTO berths (dock_id, box_id, tag, want_send, want_receive, requested_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (dock_id, box_id) DO UPDATE SET
             want_send = MAX(berths.want_send, excluded.want_send),
             want_receive = MAX(berths.want_receive, excluded.want_receive),
             requested_at = COALESCE(berths.requested_at, excluded.requested_at)`,
        )
        .run(dock.id, boxId, this.tagFor(dock.id, boxId), wantSend ? 1 : 0, wantReceive ? 1 : 0, this.now());
      return { dock, berth: this.berth(dock.id, boxId)! };
    });
  }

  approve(dockId: string, boxId: string): Berth {
    const berth = this.berth(dockId, boxId);
    if (!berth || (!berth.wantSend && !berth.wantReceive && !berth.send && !berth.receive)) {
      throw fail("no_request", 404, "That app hasn't asked to dock there.");
    }
    return this.grant(dockId, boxId, { send: berth.send || berth.wantSend, receive: berth.receive || berth.wantReceive })!;
  }

  /** Says no: takes away anything already granted, and stops the app from asking again. */
  deny(dockId: string, boxId: string) {
    const berth = this.berth(dockId, boxId);
    if (!berth) throw fail("no_request", 404, "That app hasn't asked to dock there.");
    this.db
      .prepare("UPDATE berths SET can_send = 0, can_receive = 0, want_send = 0, want_receive = 0, denied = 1 WHERE dock_id = ? AND box_id = ?")
      .run(dockId, boxId);
    this.collect(dockId);
  }

  remove(dockId: string, boxId: string): boolean {
    const { changes } = this.db.prepare("DELETE FROM berths WHERE dock_id = ? AND box_id = ?").run(dockId, boxId);
    if (Number(changes) > 0) this.collect(dockId);
    return Number(changes) > 0;
  }

  /** Requests waiting for the owner. */
  pending(): Array<{ dock: string; dockId: string; boxId: string; send: boolean; receive: boolean; requestedAt: number | null }> {
    const rows = this.db
      .prepare(
        `SELECT b.*, d.name AS dock FROM berths b JOIN docks d ON d.id = b.dock_id
         WHERE b.denied = 0 AND (b.want_send > b.can_send OR b.want_receive > b.can_receive)
         ORDER BY b.requested_at`,
      )
      .all() as unknown as Array<BerthRow & { dock: string }>;
    return rows.map((r) => ({
      dock: r.dock,
      dockId: r.dock_id,
      boxId: r.box_id,
      send: r.want_send > r.can_send,
      receive: r.want_receive > r.can_receive,
      requestedAt: r.requested_at,
    }));
  }

  // ── Parcels ──────────────────────────────────────────────────────────────

  send(dock: Dock, from: Berth, body: unknown, to?: string): { id: string; seq: number; recipients: number; redacted: string[]; stripped: string[] } {
    const now = this.now();
    const rateKey = `${dock.id}|${from.boxId}`;
    const recent = (this.sends.get(rateKey) ?? []).filter((t) => t > now - 60_000);
    if (recent.length >= dock.settings.ratePerMinute) {
      throw fail("dock_rate", 429, `That's more than ${dock.settings.ratePerMinute} parcels a minute on ${dock.name}.`, "Batch them into fewer, bigger parcels.");
    }

    const receivers = this.berths(dock.id).filter((b) => b.receive && b.tag !== from.tag);
    if (to !== undefined && !receivers.some((r) => r.tag === to)) {
      throw fail("no_such_berth", 404, `Nobody on ${dock.name} who can receive goes by ${to}.`, "Reply to the `from` of a parcel you received.");
    }

    const cleared = inspect(body, dock.settings);
    const keys = this.dockKeys(dock.id);
    const id = `pcl_${randomBytes(12).toString("base64url")}`;
    const envelope = JSON.stringify({ body: cleared.body, redacted: cleared.redacted, stripped: cleared.stripped });
    const expiresAt = now + dock.settings.ttlMs;
    const seq = transaction(this.db, () => {
      const { last_seq } = this.db.prepare("UPDATE docks SET last_seq = last_seq + 1 WHERE id = ? RETURNING last_seq").get(dock.id) as {
        last_seq: number;
      };
      this.db
        .prepare(
          `INSERT INTO parcels (id, dock_id, seq, sender_tag, to_tag, body_enc, sender_enc, size, sent_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          dock.id,
          last_seq,
          from.tag,
          to ?? null,
          seal(keys.enc, envelope, `parcel|${dock.id}|${id}`),
          seal(keys.enc, from.boxId, `parcel-sender|${dock.id}|${id}`),
          cleared.size,
          now,
          expiresAt,
        );
      return last_seq;
    });
    recent.push(now);
    this.sends.set(rateKey, recent);

    const parcel: Parcel = {
      id,
      seq,
      from: from.tag,
      to: to ?? null,
      body: cleared.body,
      sentAt: now,
      expiresAt,
      redacted: cleared.redacted,
    };
    for (const listener of this.listeners) {
      try {
        listener({ dockId: dock.id, parcel });
      } catch {
        // A broken watcher must never break a send.
      }
    }
    const recipients = to ? 1 : receivers.length;
    return { id, seq: parcel.seq, recipients, redacted: cleared.redacted, stripped: cleared.stripped };
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
    return rows.map((row) => {
      const { stripped: _hidden, ...parcel } = this.open(row);
      return parcel;
    });
  }

  private open(row: ParcelRow): FullParcel {
    const keys = this.dockKeys(row.dock_id);
    const envelope = JSON.parse(unseal(keys.enc, row.body_enc, `parcel|${row.dock_id}|${row.id}`).toString()) as {
      body: unknown;
      redacted: string[];
      stripped: string[];
    };
    return {
      id: row.id,
      seq: row.seq,
      from: row.sender_tag,
      to: row.to_tag,
      body: envelope.body,
      sentAt: row.sent_at,
      expiresAt: row.expires_at,
      redacted: envelope.redacted,
      stripped: envelope.stripped,
    };
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
    const dock = this.db.prepare("SELECT * FROM docks WHERE id = ?").get(dockId) as DockRow | undefined;
    if (!dock || toDock(dock).settings.keepAfterDelivery) return;
    const receivers = this.berths(dockId).filter((b) => b.receive);
    const maxCursor = Math.max(0, ...receivers.map((r) => r.cursor));
    if (maxCursor === 0) return;
    const rows = this.db
      .prepare("SELECT seq, sender_tag, to_tag FROM parcels WHERE dock_id = ? AND seq <= ?")
      .all(dockId, maxCursor) as Array<{ seq: number; sender_tag: string; to_tag: string | null }>;
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

  /** When a box is shredded, the parcels it sent go with it. */
  forgetBox(boxId: string) {
    for (const dock of this.list({ includeInternal: true })) {
      this.db.prepare("DELETE FROM parcels WHERE dock_id = ? AND sender_tag = ?").run(dock.id, this.tagFor(dock.id, boxId));
    }
  }

  inFlight(dockId: string): { count: number; bytes: number; unclaimed: number } {
    const all = this.db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS b FROM parcels WHERE dock_id = ?").get(dockId) as {
      n: number;
      b: number;
    };
    const receivers = this.berths(dockId).filter((b) => b.receive);
    const rows = this.db.prepare("SELECT sender_tag, to_tag FROM parcels WHERE dock_id = ?").all(dockId) as Array<{
      sender_tag: string;
      to_tag: string | null;
    }>;
    const unclaimed = rows.filter((p) => !receivers.some((r) => r.tag !== p.sender_tag && (p.to_tag === null || p.to_tag === r.tag))).length;
    return { count: all.n, bytes: all.b, unclaimed };
  }

  /** The owner's view: what's in flight and who really sent it. */
  peek(dockId: string, limit = 50): Array<FullParcel & { senderBoxId: string }> {
    const rows = this.db
      .prepare("SELECT * FROM parcels WHERE dock_id = ? ORDER BY seq DESC LIMIT ?")
      .all(dockId, limit) as unknown as ParcelRow[];
    const keys = this.dockKeys(dockId);
    return rows.map((row) => ({
      ...this.open(row),
      senderBoxId: unseal(keys.enc, row.sender_enc, `parcel-sender|${dockId}|${row.id}`).toString(),
    }));
  }

  /** Expires old parcels and clears delivered ones. Returns how many expired per dock. */
  sweep(): Map<string, number> {
    const expired = new Map<string, number>();
    const rows = this.db
      .prepare("SELECT dock_id, COUNT(*) AS n FROM parcels WHERE expires_at <= ? GROUP BY dock_id")
      .all(this.now()) as Array<{ dock_id: string; n: number }>;
    if (rows.length > 0) {
      this.db.prepare("DELETE FROM parcels WHERE expires_at <= ?").run(this.now());
      for (const r of rows) expired.set(r.dock_id, r.n);
    }
    for (const dock of this.list({ includeInternal: true })) this.collect(dock.id);
    for (const [key, times] of this.sends) {
      if (times.every((t) => t <= this.now() - 60_000)) this.sends.delete(key);
    }
    return expired;
  }
}

function toDock(row: DockRow): Dock {
  return {
    id: row.id,
    name: row.name,
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
  };
}

function validateDockSettings(patch: Record<string, unknown>): Partial<DockSettings> {
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
