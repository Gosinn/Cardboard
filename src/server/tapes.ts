import { fail } from "../shared/errors.ts";
import { describeDuration } from "../shared/duration.ts";
import { newId, sha256 } from "./crypto.ts";
import type { DB } from "./db.ts";

/**
 * A tape is an app's access to one box. It has two halves: a token, which the
 * app sends to prove who it is (stored here only as a hash), and a key, which
 * never leaves the app and opens `bundle`: the box key, sealed. So even a
 * complete copy of this database can't open a box through its tapes.
 *
 * By default a tape stops working after 90 days *without use*: apps you use
 * keep working, dead apps clean themselves up.
 */
export type TapeKind = "app" | "assistant" | "grant";

export interface Tape {
  id: string;
  accountId: string;
  boxId: string;
  /** Sealed by the account key. */
  label: Buffer | null;
  kind: TapeKind;
  read: boolean;
  write: boolean;
  idleMs: number | null;
  expiresAt: number | null;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
  grantId: string | null;
}

export interface NewTape {
  tokenHash: Buffer;
  bundle: Buffer | null;
  label: Buffer | null;
  kind?: TapeKind;
  read?: boolean;
  write?: boolean;
  idleMs?: number | null;
  expiresAt?: number | null;
  grantId?: string | null;
}

export const DEFAULT_IDLE_MS = 90 * 24 * 60 * 60 * 1000;
const TOUCH_EVERY_MS = 60 * 1000;

interface TapeRow {
  id: string;
  account_id: string;
  box_id: string;
  bundle: Uint8Array | null;
  label: Uint8Array | null;
  kind: string;
  can_read: number;
  can_write: number;
  idle_ms: number | null;
  expires_at: number | null;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
  grant_id: string | null;
}

export type TapeCheck = { ok: true; tape: Tape } | { ok: false; reason: string; hint?: string; tape?: Tape };

export class Tapes {
  private readonly db: DB;
  private readonly now: () => number;

  constructor(db: DB, now: () => number) {
    this.db = db;
    this.now = now;
  }

  create(accountId: string, boxId: string, input: NewTape): Tape {
    const read = input.read ?? true;
    const write = input.write ?? true;
    if (!read && !write) throw fail("useless_tape", 400, "A tape has to be able to read, write, or both.");
    const tape: Tape = {
      id: newId("tape"),
      accountId,
      boxId,
      label: input.label,
      kind: input.kind ?? "app",
      read,
      write,
      idleMs: input.idleMs === undefined ? DEFAULT_IDLE_MS : input.idleMs,
      expiresAt: input.expiresAt ?? null,
      createdAt: this.now(),
      lastUsedAt: null,
      revokedAt: null,
      grantId: input.grantId ?? null,
    };
    try {
      this.db
        .prepare(
          `INSERT INTO tapes (id, account_id, box_id, token_hash, bundle, label, kind, can_read, can_write, idle_ms, expires_at, created_at, grant_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          tape.id,
          accountId,
          boxId,
          input.tokenHash,
          input.bundle,
          input.label,
          tape.kind,
          read ? 1 : 0,
          write ? 1 : 0,
          tape.idleMs,
          tape.expiresAt,
          tape.createdAt,
          tape.grantId,
        );
    } catch {
      throw fail("tape_exists", 409, "That tape token is already in use.", "Each tape gets its own random token.");
    }
    return tape;
  }

  /** Checks a presented token. Hashing first means lookups never compare secrets directly. */
  check(token: string): TapeCheck {
    const row = this.db.prepare("SELECT * FROM tapes WHERE token_hash = ?").get(sha256(token)) as TapeRow | undefined;
    if (!row) return { ok: false, reason: "That tape isn't valid.", hint: "Check CARDBOARD_TAPE, or make a new one with: cardboard connect <app>" };
    const tape = toTape(row);
    const state = this.state(tape);
    if (state !== "active") return { ok: false, reason: `That tape ${state}.`, hint: "Make a new one with: cardboard tape <box>", tape };
    const now = this.now();
    if (tape.lastUsedAt === null || now - tape.lastUsedAt > TOUCH_EVERY_MS) {
      this.db.prepare("UPDATE tapes SET last_used_at = ? WHERE id = ?").run(now, tape.id);
      tape.lastUsedAt = now;
    }
    return { ok: true, tape };
  }

  /** The box key, sealed by the tape's key half. Useless without that half. */
  bundle(tapeId: string): Buffer | null {
    const row = this.db.prepare("SELECT bundle FROM tapes WHERE id = ?").get(tapeId) as { bundle: Uint8Array | null } | undefined;
    return row?.bundle ? Buffer.from(row.bundle) : null;
  }

  /** "active", or a sentence fragment explaining why not ("was revoked 2 days ago"). */
  state(tape: Tape): string {
    const now = this.now();
    if (tape.revokedAt !== null) return `was revoked ${describeDuration(now - tape.revokedAt)} ago`;
    if (tape.expiresAt !== null && tape.expiresAt <= now) return `expired ${describeDuration(now - tape.expiresAt)} ago`;
    const idleSince = tape.lastUsedAt ?? tape.createdAt;
    if (tape.idleMs !== null && idleSince + tape.idleMs <= now) return `went unused for ${describeDuration(tape.idleMs)}, so it switched itself off`;
    return "active";
  }

  get(id: string): Tape | undefined {
    const row = this.db.prepare("SELECT * FROM tapes WHERE id = ?").get(id) as TapeRow | undefined;
    return row && toTape(row);
  }

  /** A tape, only if it belongs to this account. */
  own(accountId: string, id: string): Tape {
    const tape = this.get(id);
    if (!tape || tape.accountId !== accountId) throw fail("no_such_tape", 404, "You don't have a tape with that id.", "List tapes with: cardboard box <name>");
    return tape;
  }

  /**
   * Tapes one account made for a box (short-lived Sign in with Cardboard tapes
   * are listed under connected apps instead). In a shared box, everyone's
   * tapes are their own business.
   */
  list(boxId: string, accountId: string): Tape[] {
    const rows = this.db.prepare("SELECT * FROM tapes WHERE box_id = ? AND account_id = ? AND grant_id IS NULL ORDER BY created_at DESC").all(boxId, accountId) as unknown as TapeRow[];
    return rows.map(toTape);
  }

  revoke(id: string): Tape {
    const tape = this.get(id);
    if (!tape) throw fail("no_such_tape", 404, "There's no such tape.");
    if (tape.revokedAt === null) {
      tape.revokedAt = this.now();
      this.db.prepare("UPDATE tapes SET revoked_at = ?, bundle = NULL WHERE id = ?").run(tape.revokedAt, id);
    }
    return tape;
  }

  /** Revokes every tape handed out under a Sign in with Cardboard grant. Returns their ids. */
  revokeGrant(grantId: string): string[] {
    const ids = (this.db.prepare("SELECT id FROM tapes WHERE grant_id = ? AND revoked_at IS NULL").all(grantId) as Array<{ id: string }>).map((r) => r.id);
    this.db.prepare("UPDATE tapes SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL").run(this.now(), grantId);
    return ids;
  }

  /** Forgets expired Sign in with Cardboard tapes (they're re-issued all the time). */
  sweepGrantTapes() {
    this.db.prepare("DELETE FROM tapes WHERE grant_id IS NOT NULL AND expires_at < ?").run(this.now() - 24 * 60 * 60 * 1000);
  }

  /** Test/maintenance hook: change when a tape expires. */
  setExpiry(id: string, expiresAt: number | null) {
    this.db.prepare("UPDATE tapes SET expires_at = ? WHERE id = ?").run(expiresAt, id);
  }
}

function toTape(row: TapeRow): Tape {
  return {
    id: row.id,
    accountId: row.account_id,
    boxId: row.box_id,
    label: row.label ? Buffer.from(row.label) : null,
    kind: row.kind as TapeKind,
    read: row.can_read === 1,
    write: row.can_write === 1,
    idleMs: row.idle_ms,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    grantId: row.grant_id,
  };
}

/** What a device sees about a tape: everything except the token and key, which the server doesn't have. */
export function tapeView(tape: Tape, state: string) {
  return {
    id: tape.id,
    box: tape.boxId,
    label: tape.label ? tape.label.toString("base64url") : null,
    kind: tape.kind,
    read: tape.read,
    write: tape.write,
    idleMs: tape.idleMs,
    expiresAt: tape.expiresAt,
    createdAt: tape.createdAt,
    lastUsedAt: tape.lastUsedAt,
    revokedAt: tape.revokedAt,
    state,
  };
}
