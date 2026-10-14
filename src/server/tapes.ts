import { fail } from "../shared/errors.ts";
import { describeDuration } from "../shared/duration.ts";
import { newId, newSecret, sha256 } from "./crypto.ts";
import type { DB } from "./db.ts";

/**
 * A tape is an app's access token for one box. Only a SHA-256 hash of the
 * secret is stored. By default a tape stops working after 90 days *without
 * use*: apps you use keep working, dead apps clean themselves up.
 */
export interface Tape {
  id: string;
  boxId: string;
  label: string;
  read: boolean;
  write: boolean;
  /** If set, the tape can only reach keys starting with this. */
  prefix: string | null;
  idleMs: number | null;
  expiresAt: number | null;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

export interface TapeOptions {
  label?: string;
  read?: boolean;
  write?: boolean;
  prefix?: string | null;
  idleMs?: number | null;
  expiresAt?: number | null;
}

export const DEFAULT_IDLE_MS = 90 * 24 * 60 * 60 * 1000;
const TOUCH_EVERY_MS = 60 * 1000;

interface TapeRow {
  id: string;
  box_id: string;
  label: string;
  can_read: number;
  can_write: number;
  prefix: string | null;
  idle_ms: number | null;
  expires_at: number | null;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

export type TapeCheck = { ok: true; tape: Tape } | { ok: false; reason: string; hint?: string; tape?: Tape };

export class Tapes {
  private readonly db: DB;
  private readonly now: () => number;

  constructor(db: DB, now: () => number) {
    this.db = db;
    this.now = now;
  }

  create(boxId: string, options: TapeOptions = {}): { tape: Tape; secret: string } {
    const read = options.read ?? true;
    const write = options.write ?? true;
    if (!read && !write) throw fail("useless_tape", 400, "A tape has to be able to read, write, or both.");
    const label = (options.label ?? "default").trim().slice(0, 60) || "default";
    if (options.prefix !== undefined && options.prefix !== null && options.prefix.length === 0) {
      throw fail("bad_prefix", 400, "A prefix can't be empty. Leave it out to reach the whole box.");
    }
    const secret = newSecret("cbt");
    const tape: Tape = {
      id: newId("tape"),
      boxId,
      label,
      read,
      write,
      prefix: options.prefix ?? null,
      idleMs: options.idleMs === undefined ? DEFAULT_IDLE_MS : options.idleMs,
      expiresAt: options.expiresAt ?? null,
      createdAt: this.now(),
      lastUsedAt: null,
      revokedAt: null,
    };
    this.db
      .prepare(
        `INSERT INTO tapes (id, box_id, label, secret_hash, can_read, can_write, prefix, idle_ms, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        tape.id,
        boxId,
        label,
        sha256(secret),
        read ? 1 : 0,
        write ? 1 : 0,
        tape.prefix,
        tape.idleMs,
        tape.expiresAt,
        tape.createdAt,
      );
    return { tape, secret };
  }

  /** Checks a presented secret. Hashing first means lookups never compare secrets directly. */
  check(secret: string): TapeCheck {
    const row = this.db.prepare("SELECT * FROM tapes WHERE secret_hash = ?").get(sha256(secret)) as TapeRow | undefined;
    if (!row) {
      return { ok: false, reason: "That tape isn't valid.", hint: "Check CARDBOARD_TAPE, or make a new one with: cardboard connect <app>" };
    }
    const tape = toTape(row);
    const state = this.state(tape);
    if (state !== "active") {
      return { ok: false, reason: `That tape ${state}.`, hint: "Make a new one with: cardboard tape <box>", tape };
    }
    const now = this.now();
    if (tape.lastUsedAt === null || now - tape.lastUsedAt > TOUCH_EVERY_MS) {
      this.db.prepare("UPDATE tapes SET last_used_at = ? WHERE id = ?").run(now, tape.id);
      tape.lastUsedAt = now;
    }
    return { ok: true, tape };
  }

  /** "active", or a sentence fragment explaining why not ("was revoked 2 days ago"). */
  state(tape: Tape): string {
    const now = this.now();
    if (tape.revokedAt !== null) return `was revoked ${describeDuration(now - tape.revokedAt)} ago`;
    if (tape.expiresAt !== null && tape.expiresAt <= now) return `expired ${describeDuration(now - tape.expiresAt)} ago`;
    const idleSince = tape.lastUsedAt ?? tape.createdAt;
    if (tape.idleMs !== null && idleSince + tape.idleMs <= now) {
      return `went unused for ${describeDuration(tape.idleMs)}, so it switched itself off`;
    }
    return "active";
  }

  get(id: string): Tape | undefined {
    const row = this.db.prepare("SELECT * FROM tapes WHERE id = ?").get(id) as TapeRow | undefined;
    return row && toTape(row);
  }

  require(id: string): Tape {
    const tape = this.get(id);
    if (!tape) throw fail("no_such_tape", 404, `There's no tape with id ${id}.`, "List tapes with: cardboard box <name>");
    return tape;
  }

  list(boxId: string): Tape[] {
    const rows = this.db
      .prepare("SELECT * FROM tapes WHERE box_id = ? ORDER BY created_at DESC")
      .all(boxId) as unknown as TapeRow[];
    return rows.map(toTape);
  }

  listAll(): Tape[] {
    const rows = this.db.prepare("SELECT * FROM tapes ORDER BY created_at DESC").all() as unknown as TapeRow[];
    return rows.map(toTape);
  }

  revoke(id: string): Tape {
    const tape = this.require(id);
    if (tape.revokedAt === null) {
      tape.revokedAt = this.now();
      this.db.prepare("UPDATE tapes SET revoked_at = ? WHERE id = ?").run(tape.revokedAt, id);
    }
    return tape;
  }

  /** Test/maintenance hook: change when a tape expires. */
  setExpiry(id: string, expiresAt: number | null) {
    this.db.prepare("UPDATE tapes SET expires_at = ? WHERE id = ?").run(expiresAt, id);
  }
}

function toTape(row: TapeRow): Tape {
  return {
    id: row.id,
    boxId: row.box_id,
    label: row.label,
    read: row.can_read === 1,
    write: row.can_write === 1,
    prefix: row.prefix,
    idleMs: row.idle_ms,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}

/** Public view of a tape (never includes the secret, which Cardboard doesn't have anyway). */
export function tapeView(tape: Tape, state: string) {
  return {
    id: tape.id,
    label: tape.label,
    read: tape.read,
    write: tape.write,
    prefix: tape.prefix,
    idleMs: tape.idleMs,
    expiresAt: tape.expiresAt,
    createdAt: tape.createdAt,
    lastUsedAt: tape.lastUsedAt,
    revokedAt: tape.revokedAt,
    state,
  };
}
