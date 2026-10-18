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
  /** "passkey" when opening this device's envelope also takes Face ID (or another passkey). */
  lock: DeviceLock | null;
  createdAt: number;
  lastSeenAt: number | null;
}

export const DEVICE_LOCKS = ["passkey"] as const;
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

const TOUCH_EVERY_MS = 60 * 1000;

export class Accounts {
  private readonly db: DB;
  private readonly now: () => number;

  constructor(db: DB, now: () => number) {
    this.db = db;
    this.now = now;
  }

  // ── Invites ──────────────────────────────────────────────────────────────

  createInvite(options: { note?: string; ttlMs?: number } = {}): { code: string; invite: Invite } {
    const code = newSecret("cbi");
    const now = this.now();
    const note = options.note?.trim().slice(0, 80) || null;
    const expiresAt = now + (options.ttlMs ?? INVITE_TTL);
    this.db.prepare("INSERT INTO invites (hash, note, created_at, expires_at) VALUES (?, ?, ?, ?)").run(sha256(code), note, now, expiresAt);
    return { code, invite: { id: inviteId(sha256(code)), note, createdAt: now, expiresAt, usedAt: null, accountId: null } };
  }

  invites(): Invite[] {
    const rows = this.db.prepare("SELECT * FROM invites ORDER BY created_at DESC").all() as Array<{
      hash: Uint8Array;
      note: string | null;
      created_at: number;
      expires_at: number;
      used_at: number | null;
      account_id: string | null;
    }>;
    return rows.map((r) => ({
      id: inviteId(r.hash),
      note: r.note,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      usedAt: r.used_at,
      accountId: r.account_id,
    }));
  }

  revokeInvite(id: string): boolean {
    for (const row of this.db.prepare("SELECT hash FROM invites WHERE used_at IS NULL").all() as Array<{ hash: Uint8Array }>) {
      if (inviteId(row.hash) === id) {
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
  setEnvelope(deviceId: string, envelope: Buffer, change: { lock?: DeviceLock | null; tokenHash?: Buffer } = {}) {
    transaction(this.db, () => {
      this.db.prepare("UPDATE devices SET envelope = ? WHERE id = ?").run(envelope, deviceId);
      if (change.lock !== undefined) this.db.prepare("UPDATE devices SET lock = ? WHERE id = ?").run(change.lock, deviceId);
      if (change.tokenHash) {
        try {
          this.db.prepare("UPDATE devices SET token_hash = ? WHERE id = ?").run(change.tokenHash, deviceId);
        } catch {
          throw fail("device_exists", 409, "That device token is already in use.", "Each device makes its own random token.");
        }
      }
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

  sweep() {
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

function noPairing() {
  return fail("no_such_pairing", 404, "That pairing code isn't waiting (it may have expired after 10 minutes).", "Start pairing again on the new device.");
}
