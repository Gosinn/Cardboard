import { fail } from "../shared/errors.ts";
import { newId } from "./crypto.ts";
import type { DB } from "./db.ts";

/**
 * Emergency access: what happens to your Cardboard if something happens to you.
 *
 * You give someone you trust a link (or a printed QR code). If they ever use
 * it, every one of your devices is told, and a waiting period starts. Stop it
 * and nothing happens; say yes and they're in now; do nothing and, once the
 * wait is over, the server hands them the account key, sealed by a key that
 * only their link can make. The server never holds anything that opens your
 * data. What it does hold is the clock: it keeps the waiting period.
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
export const EMERGENCY_WAIT = 7 * DAY;
export const MIN_EMERGENCY_WAIT = HOUR;
export const MAX_EMERGENCY_WAIT = 365 * DAY;
const MAX_PER_ACCOUNT = 5;

export interface EmergencyLink {
  id: string;
  accountId: string;
  envelope: Buffer;
  note: Buffer;
  label: Buffer | null;
  waitMs: number;
  createdAt: number;
  requestedAt: number | null;
  approvedAt: number | null;
}

interface Row {
  id: string;
  account_id: string;
  envelope: Uint8Array;
  note: Uint8Array;
  label: Uint8Array | null;
  wait_ms: number;
  created_at: number;
  requested_at: number | null;
  approved_at: number | null;
}

export class Emergency {
  private readonly db: DB;
  private readonly now: () => number;

  constructor(db: DB, now: () => number) {
    this.db = db;
    this.now = now;
  }

  create(accountId: string, input: { lookup: Buffer; envelope: Buffer; note: Buffer; label: Buffer | null; waitMs?: number | null }): EmergencyLink {
    const waitMs = input.waitMs ?? EMERGENCY_WAIT;
    if (waitMs < MIN_EMERGENCY_WAIT || waitMs > MAX_EMERGENCY_WAIT) throw fail("bad_request", 400, "The waiting period can be from 1 hour to a year.", 'Try "7d" or "30d".');
    if (this.list(accountId).length >= MAX_PER_ACCOUNT) throw fail("too_many_emergency_links", 409, `You can have up to ${MAX_PER_ACCOUNT} emergency access links.`, "Remove one you don't need first.");
    const link: EmergencyLink = { id: newId("emer"), accountId, envelope: input.envelope, note: input.note, label: input.label, waitMs, createdAt: this.now(), requestedAt: null, approvedAt: null };
    try {
      this.db
        .prepare("INSERT INTO emergency (id, account_id, lookup, envelope, note, label, wait_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(link.id, accountId, input.lookup, link.envelope, link.note, link.label, waitMs, link.createdAt);
    } catch {
      throw fail("emergency_exists", 409, "That link is already in use.", "Each link gets its own random secret.");
    }
    return link;
  }

  list(accountId: string): EmergencyLink[] {
    return (this.db.prepare("SELECT * FROM emergency WHERE account_id = ? ORDER BY created_at").all(accountId) as unknown as Row[]).map(toLink);
  }

  own(accountId: string, id: string): EmergencyLink {
    const row = this.db.prepare("SELECT * FROM emergency WHERE id = ? AND account_id = ?").get(id, accountId) as Row | undefined;
    if (!row) throw fail("no_such_emergency_link", 404, "There's no emergency access link with that id.", "List them with: cardboard emergency");
    return toLink(row);
  }

  /** The link a secret points to. */
  find(lookup: Buffer): EmergencyLink | undefined {
    const row = this.db.prepare("SELECT * FROM emergency WHERE lookup = ?").get(lookup) as Row | undefined;
    return row && toLink(row);
  }

  /** When the person holding the link can get in, or null if they haven't asked. */
  readyAt(link: EmergencyLink): number | null {
    if (link.requestedAt === null) return null;
    return link.approvedAt ?? link.requestedAt + link.waitMs;
  }

  /** They used the link: the waiting period starts (once; asking again changes nothing). */
  request(link: EmergencyLink): EmergencyLink {
    if (link.requestedAt !== null) return link;
    const now = this.now();
    this.db.prepare("UPDATE emergency SET requested_at = ? WHERE id = ?").run(now, link.id);
    return { ...link, requestedAt: now };
  }

  /** You stopped it: back to how it was (the link still works, and you'll hear if it's used again). */
  stop(link: EmergencyLink) {
    this.db.prepare("UPDATE emergency SET requested_at = NULL, approved_at = NULL WHERE id = ?").run(link.id);
  }

  /** You said yes: they can get in now. */
  approve(link: EmergencyLink): EmergencyLink {
    if (link.requestedAt === null) throw fail("not_requested", 409, "Nobody has used that link yet.", "There's nothing to let through.");
    const now = this.now();
    this.db.prepare("UPDATE emergency SET approved_at = ? WHERE id = ?").run(now, link.id);
    return { ...link, approvedAt: now };
  }

  /** Whether the wait is over (or you said yes). */
  isOpen(link: EmergencyLink): boolean {
    const ready = this.readyAt(link);
    return ready !== null && ready <= this.now();
  }

  /** Used up: a link that let someone in never works again. */
  remove(id: string) {
    this.db.prepare("DELETE FROM emergency WHERE id = ?").run(id);
  }
}

function toLink(row: Row): EmergencyLink {
  return {
    id: row.id,
    accountId: row.account_id,
    envelope: Buffer.from(row.envelope),
    note: Buffer.from(row.note),
    label: row.label ? Buffer.from(row.label) : null,
    waitMs: row.wait_ms,
    createdAt: row.created_at,
    requestedAt: row.requested_at,
    approvedAt: row.approved_at,
  };
}
