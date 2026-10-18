import { fail } from "../shared/errors.ts";
import { newId } from "./crypto.ts";
import { transaction, type DB } from "./db.ts";
import type { Box, Vault } from "./vault.ts";

/**
 * Boxes shared between people (a family's shopping list, a shared trip).
 *
 * The owner makes a link. Its secret stays in the link's fragment, which never
 * reaches the server; a key made from it seals the box key, and a hash of
 * another finds the share. Whoever opens the link with their own Cardboard
 * re-seals the box key with their own account key, and the link is used up.
 * The server learns that two accounts share a box, never what's in it.
 *
 * Removing someone stops the server from serving them anything, revokes their
 * apps' tapes on the box, and disconnects their signed-in apps from it. They
 * held the box key, though, so anything they already read (or copied) is
 * theirs: Cardboard doesn't re-key boxes yet.
 */

const DAY = 24 * 60 * 60 * 1000;
export const SHARE_TTL = 3 * DAY;
export const MAX_SHARE_TTL = 30 * DAY;
const MAX_MEMBERS = 50;
const MAX_PENDING = 20;

export interface Share {
  id: string;
  boxId: string;
  accountId: string;
  envelope: Buffer;
  label: Buffer | null;
  write: boolean;
  createdAt: number;
  expiresAt: number;
}

export interface Member {
  id: string;
  boxId: string;
  accountId: string;
  key: Buffer;
  name: Buffer;
  label: Buffer | null;
  write: boolean;
  createdAt: number;
}

/** A box someone can reach: their own (member null), or one shared with them. */
export interface Reach {
  box: Box;
  member: Member | null;
  write: boolean;
}

interface ShareRow {
  id: string;
  box_id: string;
  account_id: string;
  envelope: Uint8Array;
  label: Uint8Array | null;
  can_write: number;
  created_at: number;
  expires_at: number;
}

interface MemberRow {
  id: string;
  box_id: string;
  account_id: string;
  key: Uint8Array | null;
  name: Uint8Array | null;
  label: Uint8Array | null;
  can_write: number;
  created_at: number;
  removed_at: number | null;
}

export class Sharing {
  private readonly db: DB;
  private readonly vault: Vault;
  private readonly now: () => number;

  constructor(db: DB, vault: Vault, now: () => number) {
    this.db = db;
    this.vault = vault;
    this.now = now;
  }

  // ── Links ────────────────────────────────────────────────────────────────

  createShare(box: Box, input: { lookup: Buffer; envelope: Buffer; label: Buffer | null; write: boolean; ttlMs?: number | null; ownerLabel?: Buffer | null }): Share {
    const ttl = input.ttlMs ?? SHARE_TTL;
    if (ttl <= 0 || ttl > MAX_SHARE_TTL) throw fail("bad_request", 400, "A share link can last up to 30 days.", 'Try "1d", "3d" or "30d".');
    if (this.sharesOf(box.id).length >= MAX_PENDING) throw fail("too_many_shares", 409, "This box already has 20 links waiting to be used.", "Cancel some first: cardboard shares");
    if (this.membersOf(box.id).length >= MAX_MEMBERS) throw fail("too_many_members", 409, `A box can be shared with up to ${MAX_MEMBERS} people.`);
    const share: Share = {
      id: newId("share"),
      boxId: box.id,
      accountId: box.accountId,
      envelope: input.envelope,
      label: input.label,
      write: input.write,
      createdAt: this.now(),
      expiresAt: this.now() + ttl,
    };
    transaction(this.db, () => {
      try {
        this.db
          .prepare("INSERT INTO shares (id, box_id, account_id, lookup, envelope, label, can_write, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run(share.id, box.id, box.accountId, input.lookup, input.envelope, input.label, input.write ? 1 : 0, share.createdAt, share.expiresAt);
      } catch {
        throw fail("share_exists", 409, "That share link is already in use.", "Each link gets its own random secret.");
      }
      if (input.ownerLabel !== undefined) this.db.prepare("UPDATE boxes SET owner_label = ? WHERE id = ?").run(input.ownerLabel, box.id);
    });
    return share;
  }

  /** Links for one box that haven't been used or expired. */
  sharesOf(boxId: string): Share[] {
    const rows = this.db.prepare("SELECT * FROM shares WHERE box_id = ? AND expires_at > ? ORDER BY created_at DESC").all(boxId, this.now()) as unknown as ShareRow[];
    return rows.map(toShare);
  }

  revokeShare(accountId: string, id: string): Share {
    const row = this.db.prepare("SELECT * FROM shares WHERE id = ? AND account_id = ?").get(id, accountId) as ShareRow | undefined;
    if (!row) throw fail("no_such_share", 404, "There's no waiting share link with that id.", "List them with: cardboard shares");
    this.db.prepare("DELETE FROM shares WHERE id = ?").run(id);
    return toShare(row);
  }

  /** The share a link's secret points to, if it's still good. */
  findShare(lookup: Buffer): Share | undefined {
    const row = this.db.prepare("SELECT * FROM shares WHERE lookup = ? AND expires_at > ?").get(lookup, this.now()) as ShareRow | undefined;
    return row && toShare(row);
  }

  /** Someone opened the link: they join the box, and the link is used up. */
  accept(share: Share, accountId: string, input: { id: string; key: Buffer; name: Buffer; label: Buffer | null }): Member {
    if (share.accountId === accountId) throw fail("own_box", 409, "That's your own box.", "Send the link to the person you want to share it with.");
    if (this.member(share.boxId, accountId)) throw fail("already_member", 409, "You're already in this box.", "It's on your shelf.");
    const member: Member = { id: input.id, boxId: share.boxId, accountId, key: input.key, name: input.name, label: input.label, write: share.write, createdAt: this.now() };
    transaction(this.db, () => {
      const used = this.db.prepare("DELETE FROM shares WHERE id = ?").run(share.id);
      if (Number(used.changes) === 0) throw noShare();
      // Coming back after leaving: the new membership (and name) replaces the old one.
      this.db.prepare("DELETE FROM members WHERE box_id = ? AND account_id = ? AND removed_at IS NOT NULL").run(share.boxId, accountId);
      try {
        this.db
          .prepare("INSERT INTO members (id, box_id, account_id, key, name, label, can_write, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
          .run(member.id, member.boxId, accountId, member.key, member.name, member.label, member.write ? 1 : 0, member.createdAt);
      } catch {
        throw fail("member_exists", 409, "That member id is already taken.", "Try again: each join makes a new random id.");
      }
    });
    return member;
  }

  // ── Members ──────────────────────────────────────────────────────────────

  member(boxId: string, accountId: string): Member | undefined {
    const row = this.db.prepare("SELECT * FROM members WHERE box_id = ? AND account_id = ? AND removed_at IS NULL").get(boxId, accountId) as MemberRow | undefined;
    return row && toMember(row);
  }

  /** Someone who is, or was, in a box: only their label is left once they've gone (so the log can name them). */
  formerOrCurrent(boxId: string, accountId: string): { id: string; label: Buffer | null } | undefined {
    const row = this.db.prepare("SELECT id, label FROM members WHERE box_id = ? AND account_id = ?").get(boxId, accountId) as { id: string; label: Uint8Array | null } | undefined;
    return row && { id: row.id, label: row.label ? Buffer.from(row.label) : null };
  }

  memberById(id: string): Member | undefined {
    const row = this.db.prepare("SELECT * FROM members WHERE id = ? AND removed_at IS NULL").get(id) as MemberRow | undefined;
    return row && toMember(row);
  }

  membersOf(boxId: string): Member[] {
    return (this.db.prepare("SELECT * FROM members WHERE box_id = ? AND removed_at IS NULL ORDER BY created_at").all(boxId) as unknown as MemberRow[]).map(toMember);
  }

  /** Boxes shared with this account. */
  membershipsOf(accountId: string): Member[] {
    return (this.db.prepare("SELECT * FROM members WHERE account_id = ? AND removed_at IS NULL ORDER BY created_at").all(accountId) as unknown as MemberRow[]).map(toMember);
  }

  /** Someone leaves: their copy of the box key and their name for the box are deleted. */
  remove(memberId: string) {
    this.db.prepare("UPDATE members SET removed_at = ?, key = NULL, name = NULL WHERE id = ?").run(this.now(), memberId);
  }

  rename(memberId: string, name: Buffer) {
    this.db.prepare("UPDATE members SET name = ? WHERE id = ?").run(name, memberId);
  }

  /**
   * A box this account owns or was given, or no_such_box: a box someone else
   * hasn't shared with you looks exactly like no box at all.
   */
  reach(accountId: string, boxId: string): Reach {
    const box = this.vault.box(boxId);
    if (box && box.accountId === accountId) return { box, member: null, write: true };
    const member = box ? this.member(box.id, accountId) : undefined;
    if (!box || !member) throw fail("no_such_box", 404, "You don't have that box.", "List your boxes with: cardboard boxes");
    return { box, member, write: member.write };
  }

  canReach(accountId: string, boxId: string): boolean {
    try {
      this.reach(accountId, boxId);
      return true;
    } catch {
      return false;
    }
  }

  /** The owner's name as the box's people see it (sealed by the box key). */
  ownerLabel(boxId: string): Buffer | null {
    const row = this.db.prepare("SELECT owner_label FROM boxes WHERE id = ?").get(boxId) as { owner_label: Uint8Array | null } | undefined;
    return row?.owner_label ? Buffer.from(row.owner_label) : null;
  }

  sweep() {
    this.db.prepare("DELETE FROM shares WHERE expires_at <= ?").run(this.now());
  }
}

function noShare() {
  return fail("no_such_share", 404, "That share link doesn't work any more.", "Links work once, for a few days. Ask for a new one.");
}

export { noShare };

function toShare(row: ShareRow): Share {
  return {
    id: row.id,
    boxId: row.box_id,
    accountId: row.account_id,
    envelope: Buffer.from(row.envelope),
    label: row.label ? Buffer.from(row.label) : null,
    write: row.can_write === 1,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

function toMember(row: MemberRow): Member {
  return {
    id: row.id,
    boxId: row.box_id,
    accountId: row.account_id,
    key: Buffer.from(row.key ?? new Uint8Array()),
    name: Buffer.from(row.name ?? new Uint8Array()),
    label: row.label ? Buffer.from(row.label) : null,
    write: row.can_write === 1,
    createdAt: row.created_at,
  };
}
