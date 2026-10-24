import { randomBytes } from "node:crypto";
import { fail } from "../shared/errors.ts";
import { newId, newSecret, sameBytes, sha256 } from "./crypto.ts";
import { transaction, type DB } from "./db.ts";

/**
 * People, their devices, and the ways back in.
 *
 * Nobody has a password. Each device holds its own key; the account key is
 * stored once per device, sealed by that device's key. A new device gets in
 * by being approved from one you already have (pairing), or with your
 * recovery kit, or with pieces from trusted friends. The server can tell
 * who's who, but every copy of the account key it holds is sealed by
 * something it never sees.
 */

export const RECOVERY_PLANS = ["kit", "device", "friends", "none"] as const;
export type RecoveryPlan = (typeof RECOVERY_PLANS)[number];
export const DEVICE_KINDS = ["browser", "cli", "other"] as const;
export type DeviceKind = (typeof DEVICE_KINDS)[number];

const DAY = 24 * 60 * 60 * 1000;
const INVITE_TTL = 7 * DAY;
const PAIRING_TTL = 10 * 60 * 1000;
const MAX_PENDING_PAIRINGS = 1000;
/** "Add a device" stays open this long. */
export const OFFER_TTL = 5 * 60 * 1000;

export interface Account {
  id: string;
  createdAt: number;
  lastSeenAt: number | null;
  recovery: RecoveryPlan;
  profile: Buffer | null;
  quotaBytes: number | null;
  internal: boolean;
}

export interface Device {
  id: string;
  accountId: string;
  kind: DeviceKind;
  label: Buffer | null;
  envelope: Buffer | null;
  /** "passkey" when opening this device's envelope also takes Face ID (or another passkey); "pin" when it takes your PIN. */
  lock: DeviceLock | null;
  createdAt: number;
  lastSeenAt: number | null;
}

export const DEVICE_LOCKS = ["passkey", "pin"] as const;
/** Wrong PINs in a row before a device's PIN stops working (then: your recovery kit, or another device). */
export const PIN_TRIES = 3;
export type DeviceLock = (typeof DEVICE_LOCKS)[number];

export interface NewDevice {
  tokenHash: Buffer;
  kind: DeviceKind;
  envelope?: Buffer | null;
  label?: Buffer | null;
}

export interface RecoveryCopy {
  lookup: Buffer;
  envelope: Buffer;
}

export interface Invite {
  id: string;
  note: string | null;
  createdAt: number;
  expiresAt: number;
  usedAt: number | null;
  accountId: string | null;
  /** The account that made it, or null for the host. */
  createdBy: string | null;
}

interface AccountRow {
  id: string;
  created_at: number;
  last_seen_at: number | null;
  recovery: string;
  profile: Uint8Array | null;
  quota_bytes: number | null;
  internal: number;
}

interface DeviceRow {
  id: string;
  account_id: string;
  token_hash: Uint8Array;
  envelope: Uint8Array | null;
  label: Uint8Array | null;
  kind: string;
  lock: string | null;
  created_at: number;
  last_seen_at: number | null;
}

interface PairingRow {
  id: Uint8Array;
  public_key: Uint8Array;
  token_hash: Uint8Array;
  mac: Uint8Array;
  kind: string;
  created_at: number;
  expires_at: number;
  account_id: string | null;
  device_id: string | null;
  envelope: Uint8Array | null;
}

interface OfferRow {
  id: Uint8Array;
  account_id: string;
  created_at: number;
  expires_at: number;
  commitment: Uint8Array | null;
  kind: string | null;
  token_hash: Uint8Array | null;
  nonce_a: Uint8Array | null;
  public_key: Uint8Array | null;
  nonce_n: Uint8Array | null;
  device_id: string | null;
  envelope: Uint8Array | null;
  confirmed: number;
  label: Uint8Array | null;
}

/** What the device that opened an offer sees of it, step by step. */
export interface OfferView {
  expiresAt: number;
  commitment: Buffer | null;
  kind: DeviceKind | null;
  nonceA: Buffer | null;
  publicKey: Buffer | null;
  nonceN: Buffer | null;
  deviceId: string | null;
}

const TOUCH_EVERY_MS = 60 * 1000;

export class Accounts {
  private readonly db: DB;
  private readonly now: () => number;

  constructor(db: DB, now: () => number) {
    this.db = db;
    this.now = now;
  }

  // ── Invites ──────────────────────────────────────────────────────────────

  /** An invite from the host, or (with `createdBy`) from someone already here inviting a friend. */
  createInvite(options: { note?: string; ttlMs?: number; createdBy?: string } = {}): { code: string; invite: Invite } {
    const code = newSecret("cbi");
    const now = this.now();
    const note = options.note?.trim().slice(0, 80) || null;
    const expiresAt = now + (options.ttlMs ?? INVITE_TTL);
    this.db
      .prepare("INSERT INTO invites (hash, note, created_at, expires_at, created_by) VALUES (?, ?, ?, ?, ?)")
      .run(sha256(code), note, now, expiresAt, options.createdBy ?? null);
    return { code, invite: { id: inviteId(sha256(code)), note, createdAt: now, expiresAt, usedAt: null, accountId: null, createdBy: options.createdBy ?? null } };
  }

  /** Invites one account made that are still waiting to be used. */
  invitesBy(accountId: string): Invite[] {
    return this.invites().filter((i) => i.createdBy === accountId && i.usedAt === null && i.expiresAt > this.now());
  }

  invites(): Invite[] {
    const rows = this.db.prepare("SELECT * FROM invites ORDER BY created_at DESC").all() as Array<{
      hash: Uint8Array;
      note: string | null;
      created_at: number;
      expires_at: number;
      used_at: number | null;
      account_id: string | null;
      created_by: string | null;
    }>;
    return rows.map((r) => ({
      id: inviteId(r.hash),
      note: r.note,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      usedAt: r.used_at,
      accountId: r.account_id,
      createdBy: r.created_by,
    }));
  }

  /** Cancels an unused invite (only the account's own, when `createdBy` is given). */
  revokeInvite(id: string, createdBy?: string): boolean {
    const rows = this.db.prepare("SELECT hash, created_by FROM invites WHERE used_at IS NULL").all() as Array<{ hash: Uint8Array; created_by: string | null }>;
    for (const row of rows) {
      if (inviteId(row.hash) === id && (createdBy === undefined || row.created_by === createdBy)) {
        this.db.prepare("DELETE FROM invites WHERE hash = ?").run(row.hash);
        return true;
      }
    }
    return false;
  }

  // ── Accounts ─────────────────────────────────────────────────────────────

  /**
   * A new person. With invite-only sign-up (the default) `invite` must be an
   * unused, unexpired invite code; it's used up in the same transaction.
   */
  signup(input: {
    invite: string | undefined;
    openSignup: boolean;
    device: NewDevice;
    plan: RecoveryPlan;
    kit?: RecoveryCopy;
    friends?: RecoveryCopy;
    internal?: boolean;
  }): { account: Account; device: Device } {
    if (!input.device.envelope) throw fail("bad_request", 400, "A new account needs its first device's sealed key.");
    return transaction(this.db, () => {
      const now = this.now();
      const accountId = newId("acct");
      if (!input.openSignup || input.invite) {
        const row = input.invite
          ? (this.db.prepare("SELECT * FROM invites WHERE hash = ?").get(sha256(input.invite)) as
              | { expires_at: number; used_at: number | null }
              | undefined)
          : undefined;
        if (!row) {
          throw fail("invite_required", 403, "This Cardboard is invite-only, and that invite code isn't valid.", "Ask whoever runs it for an invite link.");
        }
        if (row.used_at !== null) throw fail("invite_used", 403, "That invite has already been used.", "Invites work once. Ask for a new one.");
        if (row.expires_at <= now) throw fail("invite_expired", 403, "That invite has expired.", "Ask for a new one.");
        this.db.prepare("UPDATE invites SET used_at = ?, account_id = ? WHERE hash = ?").run(now, accountId, sha256(input.invite!));
      }
      this.db
        .prepare("INSERT INTO accounts (id, created_at, last_seen_at, recovery, internal) VALUES (?, ?, ?, ?, ?)")
        .run(accountId, now, now, input.plan, input.internal ? 1 : 0);
      this.writeRecovery(accountId, input.plan, input);
      const device = this.addDevice(accountId, input.device);
      return { account: this.account(accountId)!, device };
    });
  }

  account(id: string): Account | undefined {
    const row = this.db.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as AccountRow | undefined;
    return row && toAccount(row);
  }

  /** Every account, for the host. Only metadata: there's nothing else the host could read. */
  list(options: { includeInternal?: boolean } = {}): Array<Account & { devices: number; boxes: number; bytes: number }> {
    const rows = this.db
      .prepare(
        `SELECT a.*,
           (SELECT COUNT(*) FROM devices d WHERE d.account_id = a.id) AS devices,
           (SELECT COUNT(*) FROM boxes b WHERE b.account_id = a.id) AS boxes,
           (SELECT COALESCE(SUM(i.size), 0) FROM items i JOIN boxes b ON b.id = i.box_id WHERE b.account_id = a.id) AS bytes
         FROM accounts a ${options.includeInternal ? "" : "WHERE a.internal = 0"} ORDER BY a.created_at`,
      )
      .all() as unknown as Array<AccountRow & { devices: number; boxes: number; bytes: number }>;
    return rows.map((r) => ({ ...toAccount(r), devices: r.devices, boxes: r.boxes, bytes: r.bytes }));
  }

  setProfile(accountId: string, profile: Buffer | null) {
    this.db.prepare("UPDATE accounts SET profile = ? WHERE id = ?").run(profile, accountId);
  }

  setQuota(accountId: string, quotaBytes: number | null) {
    this.db.prepare("UPDATE accounts SET quota_bytes = ? WHERE id = ?").run(quotaBytes, accountId);
  }

  /** Everything goes: devices, boxes, items, history, tapes, docks, log, connected apps. */
  deleteAccount(accountId: string) {
    transaction(this.db, () => this.db.prepare("DELETE FROM accounts WHERE id = ?").run(accountId));
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }

  // ── Devices ──────────────────────────────────────────────────────────────

  private addDevice(accountId: string, input: NewDevice): Device {
    const id = newId("dev");
    const now = this.now();
    try {
      this.db
        .prepare("INSERT INTO devices (id, account_id, token_hash, envelope, label, kind, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(id, accountId, input.tokenHash, input.envelope ?? null, input.label ?? null, input.kind, now, now);
    } catch {
      throw fail("device_exists", 409, "That device token is already in use.", "Each device makes its own random token.");
    }
    return this.device(id)!;
  }

  device(id: string): Device | undefined {
    const row = this.db.prepare("SELECT * FROM devices WHERE id = ?").get(id) as DeviceRow | undefined;
    return row && toDevice(row);
  }

  devices(accountId: string): Device[] {
    return (this.db.prepare("SELECT * FROM devices WHERE account_id = ? ORDER BY created_at").all(accountId) as unknown as DeviceRow[]).map(toDevice);
  }

  authenticateDevice(token: string): { account: Account; device: Device } | null {
    const row = this.db.prepare("SELECT * FROM devices WHERE token_hash = ?").get(sha256(token)) as DeviceRow | undefined;
    if (!row) return null;
    const account = this.account(row.account_id);
    if (!account) return null;
    const now = this.now();
    if (row.last_seen_at === null || now - row.last_seen_at > TOUCH_EVERY_MS) {
      this.db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(now, row.id);
      this.db.prepare("UPDATE accounts SET last_seen_at = ? WHERE id = ?").run(now, account.id);
      row.last_seen_at = now;
    }
    return { account, device: toDevice(row) };
  }

  /**
   * A device stores its own sealed copy of the account key (after pairing or
   * recovery, or when it's locked or unlocked). Locking also swaps its token,
   * so the old one, which sat unsealed on the device, stops working.
   */
  setEnvelope(deviceId: string, envelope: Buffer, change: { lock?: DeviceLock | null; tokenHash?: Buffer; pin?: { proof: Buffer; share: Buffer } } = {}) {
    transaction(this.db, () => {
      this.db.prepare("UPDATE devices SET envelope = ? WHERE id = ?").run(envelope, deviceId);
      if (change.lock !== undefined) this.db.prepare("UPDATE devices SET lock = ? WHERE id = ?").run(change.lock, deviceId);
      // The PIN check goes in with the envelope it opens, or nothing does; and goes when the PIN lock does.
      if (change.lock === "pin") {
        if (!change.pin) throw fail("bad_request", 400, "A PIN lock needs its `pin` (proof and share).");
        this.setPin(deviceId, change.pin.proof, change.pin.share);
      } else if (change.lock !== undefined) this.db.prepare("DELETE FROM device_pins WHERE device_id = ?").run(deviceId);
      if (change.tokenHash) {
        try {
          this.db.prepare("UPDATE devices SET token_hash = ? WHERE id = ?").run(change.tokenHash, deviceId);
        } catch {
          throw fail("device_exists", 409, "That device token is already in use.", "Each device makes its own random token.");
        }
      }
    });
  }

  // ── PIN locks ─────────────────────────────────────────────────────────────
  //
  // The device keeps its key sealed by a key made from your PIN and a share only this
  // server holds. The server gives the share out only for a proof made from the right PIN,
  // and counts wrong ones: three, and the share is gone. So a copy of the device's storage
  // can't be tried against PINs on its own, and the server (which never has the device's
  // storage) can't open anything with the share either.

  /** Keeps a device's PIN check and the server's share of its key (made on the device, which then forgets it). */
  private setPin(deviceId: string, proof: Buffer, share: Buffer) {
    this.db
      .prepare(
        "INSERT INTO device_pins (device_id, proof_hash, share, tries, locked_at, updated_at) VALUES (?, ?, ?, 0, NULL, ?) ON CONFLICT(device_id) DO UPDATE SET proof_hash = excluded.proof_hash, share = excluded.share, tries = 0, locked_at = NULL, updated_at = excluded.updated_at",
      )
      .run(deviceId, sha256(proof), share, this.now());
  }

  /** The share, for the right PIN's proof; a wrong one counts, and the last allowed wrong one locks the PIN for good. */
  openPin(deviceId: string, proof: Buffer): { share: Buffer } | { wrong: number; locked: boolean; accountId: string } | null {
    return transaction(this.db, () => {
      const row = this.db
        .prepare("SELECT p.proof_hash, p.share, p.tries, p.locked_at, d.account_id FROM device_pins p JOIN devices d ON d.id = p.device_id WHERE p.device_id = ?")
        .get(deviceId) as { proof_hash: Uint8Array; share: Uint8Array | null; tries: number; locked_at: number | null; account_id: string } | undefined;
      if (!row) return null;
      if (row.locked_at !== null || !row.share) return { wrong: row.tries, locked: true, accountId: row.account_id };
      if (sameBytes(Buffer.from(row.proof_hash), sha256(proof))) {
        this.db.prepare("UPDATE device_pins SET tries = 0 WHERE device_id = ?").run(deviceId);
        return { share: Buffer.from(row.share) };
      }
      const tries = row.tries + 1;
      const locked = tries >= PIN_TRIES;
      this.db.prepare("UPDATE device_pins SET tries = ?, locked_at = ?, share = CASE WHEN ? THEN NULL ELSE share END WHERE device_id = ?").run(tries, locked ? this.now() : null, locked ? 1 : 0, deviceId);
      return { wrong: tries, locked, accountId: row.account_id };
    });
  }

  setDeviceLabel(accountId: string, deviceId: string, label: Buffer | null) {
    const { changes } = this.db.prepare("UPDATE devices SET label = ? WHERE id = ? AND account_id = ?").run(label, deviceId, accountId);
    if (Number(changes) === 0) throw noDevice();
  }

  /** Signs a device out for good: its token stops working and its copy of the account key is deleted. */
  removeDevice(accountId: string, deviceId: string): Device {
    const device = this.device(deviceId);
    if (!device || device.accountId !== accountId) throw noDevice();
    this.db.prepare("DELETE FROM devices WHERE id = ?").run(deviceId);
    return device;
  }

  // ── Recovery ─────────────────────────────────────────────────────────────

  setRecovery(accountId: string, plan: RecoveryPlan, copies: { kit?: RecoveryCopy; friends?: RecoveryCopy }) {
    transaction(this.db, () => {
      this.db.prepare("UPDATE accounts SET recovery = ? WHERE id = ?").run(plan, accountId);
      this.writeRecovery(accountId, plan, copies);
    });
  }

  private writeRecovery(accountId: string, plan: RecoveryPlan, copies: { kit?: RecoveryCopy; friends?: RecoveryCopy }) {
    if (plan === "kit" && !copies.kit) throw fail("bad_request", 400, "The recovery-kit plan needs a sealed copy for the kit.");
    if (plan === "friends" && !copies.friends) throw fail("bad_request", 400, "The trusted-friends plan needs a sealed copy for the friends' pieces.");
    // Only the plan you picked keeps a copy: old kits and old friends' pieces stop working.
    this.db.prepare("DELETE FROM recovery WHERE account_id = ?").run(accountId);
    const copy = plan === "kit" ? copies.kit : plan === "friends" ? copies.friends : undefined;
    if (!copy) return;
    try {
      this.db
        .prepare("INSERT INTO recovery (account_id, kind, lookup, envelope, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(accountId, plan, copy.lookup, copy.envelope, this.now());
    } catch {
      throw fail("bad_request", 400, "That recovery code is already in use. Make a new one.");
    }
  }

  hasRecovery(accountId: string): RecoveryPlan | null {
    const row = this.db.prepare("SELECT kind FROM recovery WHERE account_id = ?").get(accountId) as { kind: RecoveryPlan } | undefined;
    return row?.kind ?? null;
  }

  /**
   * Someone has a recovery kit code (or enough friends' pieces): `secret` is a
   * key derived from it. If it matches, a new device is added and gets the
   * sealed copy, which only the code can open.
   */
  /** A new device on an account whose key it will get some other way (emergency access). */
  addDeviceFor(accountId: string, device: NewDevice): Device {
    return this.addDevice(accountId, { ...device, envelope: null });
  }

  recover(kind: "kit" | "friends", secret: Uint8Array, device: NewDevice): { account: Account; device: Device; envelope: Buffer } | null {
    const row = this.db.prepare("SELECT * FROM recovery WHERE lookup = ? AND kind = ?").get(sha256(secret), kind) as
      | { account_id: string; envelope: Uint8Array }
      | undefined;
    if (!row) return null;
    return transaction(this.db, () => {
      const added = this.addDevice(row.account_id, { ...device, envelope: null });
      return { account: this.account(row.account_id)!, device: added, envelope: Buffer.from(row.envelope) };
    });
  }

  // ── Pairing a new device ─────────────────────────────────────────────────

  requestPairing(input: { id: Buffer; publicKey: Buffer; tokenHash: Buffer; mac: Buffer; kind: DeviceKind }): { expiresAt: number } {
    const now = this.now();
    this.db.prepare("DELETE FROM pairings WHERE expires_at <= ?").run(now);
    const open = this.db.prepare("SELECT COUNT(*) AS n FROM pairings").get() as { n: number };
    if (open.n >= MAX_PENDING_PAIRINGS) throw fail("slow_down", 429, "Too many devices are waiting to be paired right now.", "Try again in a few minutes.");
    const expiresAt = now + PAIRING_TTL;
    try {
      this.db
        .prepare("INSERT INTO pairings (id, public_key, token_hash, mac, kind, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(input.id, input.publicKey, input.tokenHash, input.mac, input.kind, now, expiresAt);
    } catch {
      throw fail("pairing_exists", 409, "That pairing code is already waiting.", "Start pairing again to get a new code.");
    }
    return { expiresAt };
  }

  /** What the approving device needs to check the code and seal the account key to the new device. */
  pairing(id: Buffer): { publicKey: Buffer; tokenHash: Buffer; mac: Buffer; kind: DeviceKind; createdAt: number } {
    const row = this.db.prepare("SELECT * FROM pairings WHERE id = ?").get(id) as PairingRow | undefined;
    if (!row || row.expires_at <= this.now() || row.account_id !== null) throw noPairing();
    return {
      publicKey: Buffer.from(row.public_key),
      tokenHash: Buffer.from(row.token_hash),
      mac: Buffer.from(row.mac),
      kind: row.kind as DeviceKind,
      createdAt: row.created_at,
    };
  }

  /** You said yes on a device you already have. The new device becomes yours. */
  approvePairing(accountId: string, id: Buffer, envelope: Buffer, label: Buffer | null): Device {
    return transaction(this.db, () => {
      const pending = this.pairing(id);
      const device = this.addDevice(accountId, { tokenHash: pending.tokenHash, kind: pending.kind, envelope: null, label });
      this.db.prepare("UPDATE pairings SET account_id = ?, device_id = ?, envelope = ? WHERE id = ?").run(accountId, device.id, envelope, id);
      return device;
    });
  }

  /** The new device asks whether it's been approved. Only the device holding the token gets the answer, once. */
  pollPairing(id: Buffer, token: string): { status: "waiting"; expiresAt: number } | { status: "approved"; accountId: string; deviceId: string; envelope: Buffer } {
    const row = this.db.prepare("SELECT * FROM pairings WHERE id = ?").get(id) as PairingRow | undefined;
    if (!row || !sameBytes(row.token_hash, sha256(token))) throw noPairing();
    if (row.account_id === null) {
      if (row.expires_at <= this.now()) throw noPairing();
      return { status: "waiting", expiresAt: row.expires_at };
    }
    this.db.prepare("DELETE FROM pairings WHERE id = ?").run(id);
    return { status: "approved", accountId: row.account_id, deviceId: row.device_id!, envelope: Buffer.from(row.envelope!) };
  }

  // ── Adding a device by matching numbers ──────────────────────────────────

  /** "Add a device" on a device you have: one open offer per account at a time. */
  openOffer(accountId: string): { id: Buffer; expiresAt: number } {
    const now = this.now();
    const id = randomBytes(16);
    const expiresAt = now + OFFER_TTL;
    transaction(this.db, () => {
      this.db.prepare("DELETE FROM pair_offers WHERE account_id = ? OR expires_at <= ?").run(accountId, now);
      this.db.prepare("INSERT INTO pair_offers (id, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(id, accountId, now, expiresAt);
    });
    return { id, expiresAt };
  }

  /** Offers nobody has answered yet, newest first. They say nothing about whose they are. */
  offersWaiting(): Buffer[] {
    const rows = this.db.prepare("SELECT id FROM pair_offers WHERE commitment IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 3").all(this.now()) as Array<{ id: Uint8Array }>;
    return rows.map((r) => Buffer.from(r.id));
  }

  /** A new device answers an offer. Only the first one to answer gets it. */
  joinOffer(id: Buffer, input: { commitment: Buffer; tokenHash: Buffer; kind: DeviceKind }): { expiresAt: number } {
    const row = this.offerRow(id);
    if (row.commitment !== null) throw offerTaken();
    const done = this.db
      .prepare("UPDATE pair_offers SET commitment = ?, token_hash = ?, kind = ? WHERE id = ? AND commitment IS NULL")
      .run(input.commitment, input.tokenHash, input.kind, id);
    if (done.changes !== 1) throw offerTaken();
    return { expiresAt: row.expires_at };
  }

  /** The offering device's view of its own offer. */
  offer(accountId: string, id: Buffer): OfferView {
    const row = this.offerRow(id);
    if (row.account_id !== accountId) throw noOffer();
    return {
      expiresAt: row.expires_at,
      commitment: blob(row.commitment),
      kind: (row.kind as DeviceKind | null) ?? null,
      nonceA: blob(row.nonce_a),
      publicKey: blob(row.public_key),
      nonceN: blob(row.nonce_n),
      deviceId: row.device_id,
    };
  }

  /** The offering device's random nonce, sent only once the new device is committed to its key. */
  challengeOffer(accountId: string, id: Buffer, nonce: Buffer) {
    const row = this.offerRow(id);
    if (row.account_id !== accountId) throw noOffer();
    if (row.commitment === null || row.nonce_a !== null) throw fail("offer_out_of_order", 409, "That step of adding a device already happened, or isn't due yet.", "Press Add a device again.");
    this.db.prepare("UPDATE pair_offers SET nonce_a = ? WHERE id = ?").run(nonce, id);
  }

  /** The new device's view: the offering device's nonce, then (once you say yes) the sealed account key. Only the device holding the token. */
  joinerView(id: Buffer, token: string): { nonceA: Buffer | null; approved: { accountId: string; deviceId: string; envelope: Buffer } | null } {
    const row = this.joinerRow(id, token);
    if (row.device_id === null) return { nonceA: blob(row.nonce_a), approved: null };
    this.db.prepare("DELETE FROM pair_offers WHERE id = ?").run(id);
    return { nonceA: blob(row.nonce_a), approved: { accountId: row.account_id, deviceId: row.device_id, envelope: Buffer.from(row.envelope!) } };
  }

  /** The new device reveals its key and nonce, after seeing the offering device's nonce. */
  revealOffer(id: Buffer, token: string, publicKey: Buffer, nonce: Buffer) {
    const row = this.joinerRow(id, token);
    if (row.nonce_a === null || row.public_key !== null) throw fail("offer_out_of_order", 409, "That step of adding a device already happened, or isn't due yet.", "Start again on both devices.");
    this.db.prepare("UPDATE pair_offers SET public_key = ?, nonce_n = ? WHERE id = ?").run(publicKey, nonce, id);
  }

  /**
   * You said the numbers match on the device you have. The new device is added once it has said
   * so too (confirmOffer), in whichever order: neither side alone can add a device to an account.
   */
  approveOffer(accountId: string, id: Buffer, envelope: Buffer, label: Buffer | null): { kind: DeviceKind; added: Device | null } {
    return transaction(this.db, () => {
      const row = this.offerRow(id);
      if (row.account_id !== accountId) throw noOffer();
      if (row.public_key === null || row.envelope !== null) throw fail("offer_out_of_order", 409, "That device isn't ready to be added yet.", "Wait for the number to show on both devices.");
      this.db.prepare("UPDATE pair_offers SET envelope = ?, label = ? WHERE id = ?").run(envelope, label, id);
      return { kind: row.kind as DeviceKind, added: row.confirmed ? this.finishOffer(id) : null };
    });
  }

  /** The new device says the numbers match. */
  confirmOffer(id: Buffer, token: string): void {
    transaction(this.db, () => {
      const row = this.joinerRow(id, token);
      if (row.public_key === null) throw fail("offer_out_of_order", 409, "There's no number to agree to yet.", "Wait for the number to show.");
      this.db.prepare("UPDATE pair_offers SET confirmed = 1 WHERE id = ?").run(id);
      if (row.envelope !== null && row.device_id === null) this.finishOffer(id);
    });
  }

  /** Both said yes: the new device becomes the account's. */
  private finishOffer(id: Buffer): Device {
    const row = this.db.prepare("SELECT * FROM pair_offers WHERE id = ?").get(id) as unknown as OfferRow;
    const device = this.addDevice(row.account_id, { tokenHash: Buffer.from(row.token_hash!), kind: row.kind as DeviceKind, envelope: null, label: row.label ? Buffer.from(row.label) : null });
    this.db.prepare("UPDATE pair_offers SET device_id = ? WHERE id = ?").run(device.id, id);
    return device;
  }

  closeOffer(accountId: string, id: Buffer) {
    this.db.prepare("DELETE FROM pair_offers WHERE id = ? AND account_id = ?").run(id, accountId);
  }

  private offerRow(id: Buffer): OfferRow {
    const row = this.db.prepare("SELECT * FROM pair_offers WHERE id = ?").get(id) as OfferRow | undefined;
    if (!row || row.expires_at <= this.now()) throw noOffer();
    return row;
  }

  private joinerRow(id: Buffer, token: string): OfferRow {
    const row = this.db.prepare("SELECT * FROM pair_offers WHERE id = ?").get(id) as OfferRow | undefined;
    if (!row || row.token_hash === null || !sameBytes(row.token_hash, sha256(token))) throw noOffer();
    // Once approved, the new device may collect its key a little late; until then, the offer expires.
    if (row.device_id === null && row.expires_at <= this.now()) throw noOffer();
    return row;
  }

  sweep() {
    this.db.prepare("DELETE FROM pair_offers WHERE expires_at <= ?").run(this.now() - OFFER_TTL);
    this.db.prepare("DELETE FROM pairings WHERE expires_at <= ?").run(this.now() - PAIRING_TTL);
    this.db.prepare("DELETE FROM invites WHERE used_at IS NULL AND expires_at <= ?").run(this.now() - 30 * DAY);
  }
}

/** A short, stable id for an invite that isn't the invite code itself. */
function inviteId(hash: Uint8Array): string {
  return `inv_${Buffer.from(hash).subarray(0, 6).toString("hex")}`;
}

function toAccount(row: AccountRow): Account {
  return {
    id: row.id,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    recovery: row.recovery as RecoveryPlan,
    profile: row.profile ? Buffer.from(row.profile) : null,
    quotaBytes: row.quota_bytes,
    internal: row.internal === 1,
  };
}

function toDevice(row: DeviceRow): Device {
  return {
    id: row.id,
    accountId: row.account_id,
    kind: row.kind as DeviceKind,
    label: row.label ? Buffer.from(row.label) : null,
    envelope: row.envelope ? Buffer.from(row.envelope) : null,
    lock: (row.lock as DeviceLock | null) ?? null,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  };
}

function noDevice() {
  return fail("no_such_device", 404, "There's no such device on your account.");
}

function blob(value: Uint8Array | null): Buffer | null {
  return value ? Buffer.from(value) : null;
}

function noOffer() {
  return fail("no_such_offer", 404, "Nobody is adding a device right now (or it was more than 5 minutes ago).", "On a device where you're signed in, press Add a device, then try again here.");
}

function offerTaken() {
  return fail("offer_taken", 409, "Another device answered first, so this one wasn't added.", "Press Add a device again on your other device, then try again here.");
}

function noPairing() {
  return fail("no_such_pairing", 404, "That pairing code isn't waiting (it may have expired after 10 minutes).", "Start pairing again on the new device.");
}
