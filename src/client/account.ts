import { CardboardError, fail } from "../shared/errors.ts";
import { ctx } from "../shared/contexts.ts";
import { NAME_PATTERN, toName } from "../shared/names.ts";
import { describe, type OpenedEntry, type Outcome } from "../shared/activity.ts";
import { blastRadius, type BlastRadius } from "../shared/blast.ts";
import { inspect } from "../shared/customs.ts";
import type { Item } from "../shared/data.ts";
import { insights, type Insight, type RecoveryPlan } from "../shared/insights.ts";
import { inventory, type Inventory } from "../shared/labels.ts";
import { Box, type AppProfile, type BoxSettings } from "../sdk/index.ts";
import {
  combineShares,
  concat,
  derive,
  equalBytes,
  fromB64u,
  fromCode,
  hmac,
  keyPair,
  open,
  openJson,
  openText,
  openWith,
  random,
  seal,
  sealJson,
  sealTo,
  sha256,
  splitSecret,
  toB64u,
  toCode,
  type KeyLike,
} from "./crypto.ts";
import type { DeviceLock, DeviceRecord, DeviceStore } from "./device.ts";
import { accountKeys, boxIndex, boxKeys, bundle, dockIndex, dockKeys, newClientId, newKey, type AccountKeys, type BoxKeys } from "./keys.ts";
import { isFileData, kindOfKey, PERSONAL_SETTINGS, searchText } from "./personal.ts";
import { Rpc } from "./rpc.ts";

/**
 * Your account, opened on one of your devices. This is where Cardboard's
 * smarts live now: the server can't read anything, so inventory, insights,
 * search, the activity log's sentences and blast radius are all worked out
 * here, on data only this device can open. The CLI and the dashboard are thin
 * layers over this class.
 */

export type DeviceKind = "browser" | "cli" | "other";

export interface GetInOptions {
  url: string;
  store: DeviceStore;
  kind: DeviceKind;
  /** What to call this device, e.g. "Laptop" (sealed: the server never sees it). */
  label?: string;
  /** Makes this device's key. Browsers pass one that makes a non-extractable key. */
  makeKey?: () => Promise<KeyLike>;
  fetch?: typeof fetch;
}

export interface Me {
  id: string;
  createdAt: number;
  recovery: RecoveryPlan;
  recoveryReady: boolean;
  /** Sealed: only your devices read it. `personal` is the id of your personal box. */
  profile: { name?: string; email?: string; personal?: string };
  quota: { used: number; limit: number };
  device: { id: string; kind: DeviceKind; lock: "passkey" | null };
  devices: Array<{ id: string; kind: DeviceKind; lock: "passkey" | null; name: string; createdAt: number; lastSeenAt: number | null; current: boolean }>;
  alarms: Array<{ at: number; text: string }>;
  /** Emergency access links someone is using right now: stop them, or let them in. */
  emergency: EmergencyLinkInfo[];
  server: { version: string; issuer: string; signup: "invite" | "open"; invites: "everyone" | "host"; shake: { ok: boolean; summary: string; at: number } | null };
}

/** An emergency access link you gave someone. */
export interface EmergencyLinkInfo {
  id: string;
  /** Your note on who it's for. */
  label: string | null;
  waitMs: number;
  createdAt: number;
  /** When they used it (the waiting period started), or null. */
  requestedAt: number | null;
  approvedAt: number | null;
  /** When they can get in, or null if they haven't asked. */
  readyAt: number | null;
}

/** What the person holding an emergency access link sees. */
export interface EmergencyPreview {
  from: string;
  message: string | null;
  waitMs: number;
  requestedAt: number | null;
  readyAt: number | null;
  /** The wait is over (or the owner said yes): they can get in now. */
  open: boolean;
}

type WireEmergency = Omit<EmergencyLinkInfo, "label"> & { label: string | null };

export interface TapeInfo {
  id: string;
  box: string;
  label: string;
  kind: "app" | "assistant" | "grant";
  read: boolean;
  write: boolean;
  idleMs: number | null;
  expiresAt: number | null;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
  state: string;
}

/** Someone a box is shared with, as everyone in it sees them. */
export interface MemberInfo {
  id: string;
  name: string;
  write: boolean;
  joinedAt: number;
  you: boolean;
  /** How many of their apps have a working tape on the box. */
  apps: number;
}

/** A share link that hasn't been used yet. */
export interface ShareLinkInfo {
  id: string;
  /** Your note on who it's for. */
  label: string | null;
  write: boolean;
  createdAt: number;
  expiresAt: number;
}

export interface BoxInfo {
  id: string;
  name: string;
  profile: AppProfile;
  settings: BoxSettings;
  createdAt: number;
  items: number;
  bytes: number;
  tapes: TapeInfo[];
  lastActivity: number | null;
  denied24h: number;
  customs24h: number;
  docks: Array<{ dock: string; send: boolean; receive: boolean; waiting: boolean }>;
  /** Set when someone else shared this box with you. */
  shared: { from: string; write: boolean; memberId: string; joinedAt: number } | null;
  /** Who else is in the box (the owner's name, as they put it, when it isn't yours), and links waiting to be used. */
  people: { owner: string | null; members: MemberInfo[]; links: ShareLinkInfo[] };
  /** @internal */
  keys: BoxKeys;
}

export interface DockInfo {
  id: string;
  /** null for a dock an app asked for that you haven't opened yet (its name is in the request). */
  name: string | null;
  settings: Record<string, unknown> & { ttlMs: number; maxParcelBytes: number; secrets: string; personal: string };
  createdAt: number;
  inFlight: { count: number; bytes: number; unclaimed: number };
  berths: Array<{ box: string; boxId: string; tag: string; send: boolean; receive: boolean; waiting: { send: boolean; receive: boolean }; denied: boolean; approvedAt: number | null }>;
}

export interface PendingDock {
  dock: string;
  dockId: string;
  box: string;
  boxId: string;
  send: boolean;
  receive: boolean;
  requestedAt: number | null;
}

export interface LogLine {
  id: number;
  at: number;
  box: string | null;
  action: string;
  outcome: Outcome;
  text: string;
}

interface WireMe {
  account: { id: string; createdAt: number; recovery: RecoveryPlan; recoveryReady: boolean; profile: string | null; quota: { used: number; limit: number } };
  device: { id: string; kind: DeviceKind; lock: "passkey" | null };
  envelope: string | null;
  devices: Array<{ id: string; kind: DeviceKind; lock: "passkey" | null; label: string | null; createdAt: number; lastSeenAt: number | null; current: boolean }>;
  alarms: Array<{ at: number; text: string }>;
  emergency: WireEmergency[];
  server: Me["server"];
}

interface WireTape {
  id: string;
  box: string;
  label: string | null;
  kind: TapeInfo["kind"];
  read: boolean;
  write: boolean;
  idleMs: number | null;
  expiresAt: number | null;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
  state: string;
}

interface WireBox {
  id: string;
  idx: string | null;
  name: string;
  key: string;
  profile: string | null;
  settings: BoxSettings;
  createdAt: number;
  items: number;
  bytes: number;
  tapes: WireTape[];
  lastActivity: number | null;
  denied24h: number;
  customs24h: number;
  docks: Array<{ dock: string; send: boolean; receive: boolean; waiting: boolean }>;
  ownerLabel: string | null;
  members: Array<{ id: string; label: string | null; write: boolean; joinedAt: number; you: boolean; apps: number }>;
  shares: Array<{ id: string; label: string | null; write: boolean; createdAt: number; expiresAt: number }>;
  shared: { member: string; write: boolean; joinedAt: number } | null;
}

/** What a share link holds, sealed by a key made from its secret. */
interface ShareEnvelope {
  v: 1;
  box: string;
  name: string;
  from: string;
}

export interface SharePreview {
  boxId: string;
  /** What the owner calls the box. */
  name: string;
  /** Who's sharing it, as they put it. */
  from: string;
  write: boolean;
  expiresAt: number;
  /** It's your own box (you opened your own link). */
  own: boolean;
  /** You're already in it. */
  member: boolean;
}

interface WireDock {
  id: string;
  idx: string;
  name: string | null;
  key: string | null;
  settings: DockInfo["settings"];
  createdAt: number;
  inFlight: DockInfo["inFlight"];
  berths: Array<{ box: string; tag: string; send: boolean; receive: boolean; waiting: { send: boolean; receive: boolean }; denied: boolean; approvedAt: number | null; ask: string | null }>;
}

const KIT_BYTES = 16;
const PAIR_BYTES = 8;
const FRIEND_BYTES = 16;
const SHARE_BYTES = 16;
const EMERGENCY_BYTES = 16;
/** A locked device locks itself again after this long without use, unless you pick otherwise. */
export const DEFAULT_LOCK_IDLE_MS = 15 * 60 * 1000;

// ── Getting in ─────────────────────────────────────────────────────────────

function newDeviceToken(): string {
  return `cbd_${toB64u(random(32))}`;
}

async function hashOf(token: string): Promise<string> {
  return toB64u(await sha256(token));
}

/** A recovery kit: a code only you hold, and the account key sealed by a key made from it. */
async function makeKit(root: Uint8Array): Promise<{ code: string; lookup: string; envelope: string }> {
  const code = random(KIT_BYTES);
  const [auth, wrap] = await Promise.all([derive(code, "kit-auth"), derive(code, "kit-wrap")]);
  return { code: toCode(code), lookup: toB64u(await sha256(auth)), envelope: toB64u(await seal(wrap, root, ctx.accountKey("kit"))) };
}

/** Trusted friends: a key split into pieces (any `threshold` of `count` rebuild it), and the account key sealed by it. */
async function makeFriends(root: Uint8Array, count: number, threshold: number): Promise<{ pieces: string[]; lookup: string; envelope: string }> {
  const secret = random(FRIEND_BYTES);
  const [auth, wrap] = await Promise.all([derive(secret, "friends-auth"), derive(secret, "friends-wrap")]);
  return {
    pieces: splitSecret(secret, count, threshold).map((piece) => toCode(piece, 5)),
    lookup: toB64u(await sha256(auth)),
    envelope: toB64u(await seal(wrap, root, ctx.accountKey("friends"))),
  };
}

/** Seals the account key for this device, remembers the device, and opens the account. */
async function finishDevice(options: GetInOptions, rpc: Rpc, root: Uint8Array, ids: { accountId: string; deviceId: string }, token: string): Promise<Account> {
  const key = options.makeKey ? await options.makeKey() : random(32);
  const keys = await accountKeys(root);
  rpc.token = token;
  await rpc.call("device.envelope", { envelope: toB64u(await seal(key, root, ctx.accountKey("device"))) });
  if (options.label) await rpc.call("device.label", { label: toB64u(await seal(keys.meta, options.label, ctx.deviceLabel)) });
  const record: DeviceRecord = { url: rpc.url, accountId: ids.accountId, deviceId: ids.deviceId, token, key };
  await options.store.save(record);
  return new Account(rpc, record, keys, options.store);
}

/**
 * A new account. This device gets the account key; the recovery kit (the
 * standard way back in) is returned once and never stored anywhere but on
 * paper or in your password manager.
 */
export async function signUp(options: GetInOptions & { invite?: string }): Promise<{ account: Account; kit: string }> {
  const rpc = new Rpc(options.url, null, options.fetch);
  const root = newKey();
  const keys = await accountKeys(root);
  const token = newDeviceToken();
  const key = options.makeKey ? await options.makeKey() : random(32);
  const kit = await makeKit(root);
  const res = await rpc.call<{ account: { id: string }; device: { id: string } }>("signup", {
    invite: options.invite ? cleanInvite(options.invite) : undefined,
    device: {
      tokenHash: await hashOf(token),
      envelope: toB64u(await seal(key, root, ctx.accountKey("device"))),
      label: options.label ? toB64u(await seal(keys.meta, options.label, ctx.deviceLabel)) : undefined,
      kind: options.kind,
    },
    recovery: { plan: "kit", lookup: kit.lookup, envelope: kit.envelope },
  });
  rpc.token = token;
  const record: DeviceRecord = { url: rpc.url, accountId: res.account.id, deviceId: res.device.id, token, key };
  await options.store.save(record);
  return { account: new Account(rpc, record, keys, options.store), kit: kit.code };
}

/** Accepts an invite code or a whole invite link. */
export function cleanInvite(invite: string): string {
  const match = /cbi_[A-Za-z0-9_-]{43}/.exec(invite);
  if (!match) throw new CardboardError("bad_invite", 0, "That doesn't look like a Cardboard invite.", "It starts with cbi_, or is a link with #invite= in it.");
  return match[0];
}

export interface UnlockOptions {
  fetch?: typeof fetch;
  /**
   * For a device locked with a passkey: asks for it (Face ID…) and returns its
   * secret. In a browser, pass passkeySecret from passkey.ts.
   */
  passkey?: (lock: DeviceLock) => Promise<Uint8Array>;
}

/** Whether this device is locked with a passkey, without asking for it. */
export async function deviceLock(store: DeviceStore): Promise<DeviceLock | null> {
  return (await store.load())?.lock ?? null;
}

/**
 * Opens the account this device is signed in to, or null if it isn't. A
 * device locked with a passkey needs `passkey`, and throws device_locked
 * without it.
 */
export async function unlock(store: DeviceStore, options: UnlockOptions = {}): Promise<Account | null> {
  const record = await store.load();
  if (!record) return null;
  if (record.lock) {
    if (!options.passkey) throw new CardboardError("device_locked", 0, "This device is locked.", "Unlock it with Face ID (or the passkey you locked it with).");
    const lockKey = await derive(await options.passkey(record.lock), "device-lock");
    let token: string;
    try {
      token = await openText(lockKey, fromB64u(record.lock.token), ctx.deviceToken);
    } catch {
      throw new CardboardError(
        "wrong_passkey",
        0,
        "That passkey didn't unlock this device.",
        "Use the passkey you locked it with. Lost it? Remove this device from another one, or sign in again here with your recovery kit.",
      );
    }
    const rpc = new Rpc(record.url, token, options.fetch);
    const me = await rpc.call<WireMe>("me");
    if (!me.envelope || me.device.lock !== "passkey") throw new CardboardError("no_envelope", 0, "This device's lock doesn't match what the server has.", "Sign in again: pair it from another device, or use your recovery kit.");
    const inner = await open(record.key, fromB64u(me.envelope), ctx.lockedEnvelope);
    const root = await open(lockKey, inner, ctx.accountKey("passkey"));
    return new Account(rpc, record, await accountKeys(root), store);
  }
  if (!record.token) throw new CardboardError("no_envelope", 0, "This device never finished signing in.", "Sign in again: cardboard pair, or use your recovery kit.");
  const rpc = new Rpc(record.url, record.token, options.fetch);
  const me = await rpc.call<WireMe>("me");
  if (!me.envelope) throw new CardboardError("no_envelope", 0, "This device never finished signing in.", "Sign in again: cardboard pair, or use your recovery kit.");
  const root = await open(record.key, fromB64u(me.envelope), ctx.accountKey("device"));
  return new Account(rpc, record, await accountKeys(root), store);
}

// ── Emergency access, for the person holding the link ───────────────────────

async function emergencyKeys(link: string) {
  const code = /#emergency=([^&\s]+)/.exec(link)?.[1] ?? link;
  const secret = fromCode(decodeURIComponent(code), EMERGENCY_BYTES);
  const [auth, wrap, note] = await Promise.all([derive(secret, "emergency-auth"), derive(secret, "emergency-wrap"), derive(secret, "emergency-note")]);
  return { auth: toB64u(auth), wrap, note };
}

/** What an emergency access link is (who it's from, their message, how long the wait is). Doesn't start anything. */
export async function viewEmergency(options: { url: string; link: string; fetch?: typeof fetch }): Promise<EmergencyPreview> {
  const keys = await emergencyKeys(options.link);
  const res = await new Rpc(options.url, null, options.fetch).call<{ note: string; waitMs: number; requestedAt: number | null; readyAt: number | null; open: boolean }>("emergency.view", { secret: keys.auth });
  const note = await openJson<{ v: 1; from: string; message?: string }>(keys.note, fromB64u(res.note), ctx.emergencyNote);
  return { from: note.from, message: note.message ?? null, waitMs: res.waitMs, requestedAt: res.requestedAt, readyAt: res.readyAt, open: res.open };
}

/** Asks for access: the owner is told on every device, and the waiting period starts. */
export async function requestEmergency(options: { url: string; link: string; fetch?: typeof fetch }): Promise<{ readyAt: number; open: boolean }> {
  const keys = await emergencyKeys(options.link);
  return new Rpc(options.url, null, options.fetch).call("emergency.request", { secret: keys.auth });
}

/** After the wait (or once the owner says yes): this device joins their Cardboard. The link is used up. */
export async function claimEmergency(options: GetInOptions & { link: string }): Promise<Account> {
  const keys = await emergencyKeys(options.link);
  const rpc = new Rpc(options.url, null, options.fetch);
  const token = newDeviceToken();
  const res = await rpc.call<{ accountId: string; deviceId: string; envelope: string }>("emergency.claim", {
    secret: keys.auth,
    device: { tokenHash: await hashOf(token), kind: options.kind },
  });
  const root = await open(keys.wrap, fromB64u(res.envelope), ctx.accountKey("emergency"));
  return finishDevice(options, rpc, root, res, token);
}

export interface PendingPairing {
  /** Show this on the new device; type it on one you already have. */
  code: string;
  expiresAt: number;
  /** Resolves once you approve on your other device. */
  wait(options?: { signal?: AbortSignal; everyMs?: number }): Promise<Account>;
}

/**
 * Pairing: this (new) device shows a code; you type it on a device that's
 * already signed in, which seals the account key to this device's public key.
 * The code never reaches the server, and it's what lets the other device
 * check that the public key it's sealing to really is this device's.
 */
export async function startPairing(options: GetInOptions): Promise<PendingPairing> {
  const rpc = new Rpc(options.url, null, options.fetch);
  const secret = random(PAIR_BYTES);
  const [id, macKey] = await Promise.all([derive(secret, "pair-id"), derive(secret, "pair-mac")]);
  const pair = await keyPair();
  const token = newDeviceToken();
  const tokenHash = await sha256(token);
  const mac = await hmac(macKey, concat(pair.publicKey, tokenHash));
  const { expiresAt } = await rpc.call<{ expiresAt: number }>("pair.request", {
    id: toB64u(id),
    publicKey: toB64u(pair.publicKey),
    tokenHash: toB64u(tokenHash),
    mac: toB64u(mac),
    kind: options.kind,
  });
  return {
    code: toCode(secret, 5),
    expiresAt,
    async wait({ signal, everyMs = 2000 } = {}) {
      for (;;) {
        if (signal?.aborted) throw new CardboardError("cancelled", 0, "Pairing was cancelled.");
        const res = await rpc.call<{ status: "waiting" } | { status: "approved"; accountId: string; deviceId: string; envelope: string }>("pair.poll", { id: toB64u(id), token });
        if (res.status === "approved") {
          const root = await openWith(pair, fromB64u(res.envelope), ctx.accountKey("pairing"));
          return finishDevice(options, rpc, root, res, token);
        }
        await new Promise((resolve) => setTimeout(resolve, everyMs));
      }
    },
  };
}

/** Back in with your recovery kit, on a new device. */
export async function recoverWithKit(options: GetInOptions & { code: string }): Promise<Account> {
  const code = fromCode(options.code, KIT_BYTES);
  const [auth, wrap] = await Promise.all([derive(code, "kit-auth"), derive(code, "kit-wrap")]);
  return recover(options, "kit", auth, wrap);
}

/** Back in with pieces from your trusted friends (enough of them), on a new device. */
export async function recoverWithFriends(options: GetInOptions & { pieces: string[] }): Promise<Account> {
  const secret = combineShares(options.pieces.map((p) => fromCode(p, FRIEND_BYTES + 1)));
  const [auth, wrap] = await Promise.all([derive(secret, "friends-auth"), derive(secret, "friends-wrap")]);
  return recover(options, "friends", auth, wrap);
}

async function recover(options: GetInOptions, kind: "kit" | "friends", auth: Uint8Array, wrap: Uint8Array): Promise<Account> {
  const rpc = new Rpc(options.url, null, options.fetch);
  const token = newDeviceToken();
  const res = await rpc.call<{ accountId: string; deviceId: string; envelope: string }>("recover", {
    kind,
    secret: toB64u(auth),
    device: { tokenHash: await hashOf(token), kind: options.kind },
  });
  const root = await open(wrap, fromB64u(res.envelope), ctx.accountKey(kind));
  return finishDevice(options, rpc, root, res, token);
}

// ── The account ────────────────────────────────────────────────────────────

export class Account {
  readonly url: string;
  readonly id: string;
  readonly deviceId: string;
  readonly rpc: Rpc;
  private readonly keys: AccountKeys;
  private readonly store: DeviceStore;
  /** What this device keeps about itself (token sealed while locked; the live token is in rpc). */
  private record: DeviceRecord;
  private boxCache: Map<string, BoxInfo> | null = null;
  private readonly inventories = new Map<string, { stamp: string; inventory: Inventory }>();

  constructor(rpc: Rpc, record: DeviceRecord, keys: AccountKeys, store: DeviceStore) {
    this.rpc = rpc;
    this.url = rpc.url;
    this.id = record.accountId;
    this.deviceId = record.deviceId;
    this.record = record;
    this.keys = keys;
    this.store = store;
  }

  private openMeta(sealed: string | null | undefined, context: string, fallback: string): Promise<string> {
    if (!sealed) return Promise.resolve(fallback);
    return openText(this.keys.meta, fromB64u(sealed), context).catch(() => fallback);
  }

  private async sealMeta(text: string, context: string): Promise<string> {
    return toB64u(await seal(this.keys.meta, text, context));
  }

  // ── You and your devices ─────────────────────────────────────────────────

  async me(): Promise<Me> {
    const me = await this.rpc.call<WireMe>("me");
    const profile = me.account.profile ? await openJson<Me["profile"]>(this.keys.meta, fromB64u(me.account.profile), ctx.profile).catch(() => ({})) : {};
    return {
      id: me.account.id,
      createdAt: me.account.createdAt,
      recovery: me.account.recovery,
      recoveryReady: me.account.recoveryReady,
      profile,
      quota: me.account.quota,
      device: me.device,
      devices: await Promise.all(
        me.devices.map(async (d) => ({ ...d, label: undefined, name: await this.openMeta(d.label, ctx.deviceLabel, defaultDeviceName(d.kind)) })),
      ),
      alarms: me.alarms,
      emergency: await Promise.all(me.emergency.map((l) => this.openEmergency(l))),
      server: me.server,
    };
  }

  private async openEmergency(l: WireEmergency): Promise<EmergencyLinkInfo> {
    return { ...l, label: l.label ? (await this.openMeta(l.label, ctx.emergencyLabel, "")) || null : null };
  }

  // ── If something happens to you ──────────────────────────────────────────

  /**
   * An emergency access link for someone you trust (print it as a QR code, or
   * put it in their password manager). If they use it, every one of your
   * devices is told; stop it, or after `wait` (7 days unless you choose) they
   * get into your Cardboard. The account key is sealed by a key only the link
   * can make; the server just keeps the clock. `as` is your name as they'll
   * see it, `message` is for them, `label` is your note on who it's for.
   */
  async addEmergencyLink(options: { label?: string; as?: string; message?: string; wait?: string } = {}): Promise<{ link: string; code: string; info: EmergencyLinkInfo }> {
    const me = await this.me();
    const from = (options.as ?? me.profile.name ?? "").trim().slice(0, 60) || "Someone";
    const message = options.message?.trim().slice(0, 1000) || undefined;
    const label = options.label?.trim().slice(0, 60) || undefined;
    const secret = random(EMERGENCY_BYTES);
    const [auth, wrap, noteKey] = await Promise.all([derive(secret, "emergency-auth"), derive(secret, "emergency-wrap"), derive(secret, "emergency-note")]);
    const res = await this.rpc.call<{ link: WireEmergency }>("emergency.create", {
      lookup: toB64u(await sha256(auth)),
      envelope: toB64u(await seal(wrap, this.keys.root, ctx.accountKey("emergency"))),
      note: toB64u(await sealJson(noteKey, { v: 1, from, ...(message ? { message } : {}) }, ctx.emergencyNote)),
      label: label ? await this.sealMeta(label, ctx.emergencyLabel) : undefined,
      wait: options.wait,
    });
    const code = toCode(secret);
    return { link: `${me.server.issuer || this.url}/#emergency=${code}`, code, info: { ...res.link, label: label ?? null } };
  }

  async emergencyLinks(): Promise<EmergencyLinkInfo[]> {
    const { links } = await this.rpc.call<{ links: WireEmergency[] }>("emergency");
    return Promise.all(links.map((l) => this.openEmergency(l)));
  }

  private async findEmergency(which: string): Promise<EmergencyLinkInfo> {
    const links = await this.emergencyLinks();
    const found = links.find((l) => l.id === which || l.label === which);
    if (!found) throw fail("no_such_emergency_link", 404, `There's no emergency access link for ${which}.`, "See them with: cardboard emergency");
    return found;
  }

  /** Stops someone using an emergency access link. The link still works; you'd hear again if it's used. */
  async stopEmergency(which: string) {
    await this.rpc.call("emergency.stop", { id: (await this.findEmergency(which)).id });
  }

  /** Lets them in now, without waiting. */
  async allowEmergency(which: string) {
    await this.rpc.call("emergency.approve", { id: (await this.findEmergency(which)).id });
  }

  async removeEmergency(which: string) {
    await this.rpc.call("emergency.remove", { id: (await this.findEmergency(which)).id });
  }

  // ── Inviting friends ─────────────────────────────────────────────────────

  /** An invite link for a friend to make their own account here (when the host allows it). One use, 7 days. */
  async inviteFriend(options: { expires?: string } = {}): Promise<{ link: string; code: string; expiresAt: number }> {
    const res = await this.rpc.call<{ code: string; link: string; invite: { expiresAt: number } }>("invite.create", { ttl: options.expires });
    return { link: res.link, code: res.code, expiresAt: res.invite.expiresAt };
  }

  /**
   * An invite that lands a friend in one of your apps: they open the app, sign
   * in, make their Cardboard account on the way, and come straight back. The
   * invite rides in the link's fragment, which browsers never send to servers.
   */
  async inviteToApp(home: string, options: { expires?: string } = {}): Promise<{ link: string; expiresAt: number }> {
    const { code, expiresAt } = await this.inviteFriend(options);
    const url = new URL(home);
    url.hash = `cardboard_invite=${code}`;
    return { link: url.toString(), expiresAt };
  }

  async invites(): Promise<{ allowed: boolean; invites: Array<{ id: string; createdAt: number; expiresAt: number }> }> {
    return this.rpc.call("invites");
  }

  async cancelInvite(id: string) {
    await this.rpc.call("invite.revoke", { id });
  }

  /** Your name and email, sealed. Apps only get them when you say so, sealed to the app. */
  async setProfile(profile: { name?: string | null; email?: string | null }): Promise<Me["profile"]> {
    const next = { ...(await this.me()).profile };
    for (const field of ["name", "email"] as const) {
      const value = profile[field];
      if (value === undefined) continue;
      if (value === null || value === "") delete next[field];
      else {
        if (value.length > 120) throw fail("bad_profile", 400, `\`${field}\` must be at most 120 characters.`);
        if (field === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw fail("bad_profile", 400, "That doesn't look like an email address.");
        next[field] = value;
      }
    }
    await this.writeProfile(next);
    return next;
  }

  private async writeProfile(profile: Me["profile"]) {
    await this.rpc.call("profile.set", { profile: toB64u(await sealJson(this.keys.meta, profile, ctx.profile)) });
  }

  /** Your personal box (notes, passwords, links, files): just for you, on every device you sign in on. null until you make it. */
  async personalBox(me?: Me): Promise<BoxInfo | null> {
    const id = (me ?? (await this.me())).profile.personal;
    if (!id) return null;
    const box = await this.boxById(id);
    return box && !box.shared ? box : null;
  }

  /** Makes your personal box (or finds the one you already have). Which box it is stays sealed in your profile. */
  async makePersonalBox(): Promise<BoxInfo> {
    const me = await this.me();
    const existing = await this.personalBox(me);
    if (existing) return existing;
    const box = await this.createBox(await this.freeName("personal"), PERSONAL_SETTINGS);
    await this.writeProfile({ ...me.profile, personal: box.id });
    return box;
  }

  /**
   * You typed the code a new device is showing. Checks the code matches what
   * that device sent (so nobody, not even the server, swapped in their own
   * key), then seals the account key to it.
   */
  async approveDevice(code: string, label?: string): Promise<{ id: string; kind: DeviceKind }> {
    const secret = fromCode(code, PAIR_BYTES);
    const [id, macKey] = await Promise.all([derive(secret, "pair-id"), derive(secret, "pair-mac")]);
    const view = await this.rpc.call<{ publicKey: string; tokenHash: string; mac: string; kind: DeviceKind }>("pair.view", { id: toB64u(id) });
    const publicKey = fromB64u(view.publicKey);
    const expected = await hmac(macKey, concat(publicKey, fromB64u(view.tokenHash)));
    if (!equalBytes(expected, fromB64u(view.mac))) {
      throw new CardboardError("pairing_tampered", 0, "That device's request doesn't match the code, so Cardboard didn't trust it.", "Start pairing again on the new device.");
    }
    const envelope = await sealTo(publicKey, this.keys.root, ctx.accountKey("pairing"));
    const res = await this.rpc.call<{ device: { id: string; kind: DeviceKind } }>("pair.approve", {
      id: toB64u(id),
      envelope: toB64u(envelope),
      label: label ? await this.sealMeta(label, ctx.deviceLabel) : undefined,
    });
    return res.device;
  }

  // ── Locking this device (Face ID…) ───────────────────────────────────────

  /** This device's passkey lock, or null if opening it needs nothing but the device itself. */
  get lock(): DeviceLock | null {
    return this.record.lock ?? null;
  }

  /**
   * Locks this device with a passkey: from now on, opening your account here
   * takes the passkey's secret (Face ID, Touch ID, Windows Hello…) as well as
   * this device's own key. Its token is swapped for a new one, kept sealed by
   * the passkey, so the old one (which sat on the device unsealed) stops
   * working. In a browser, get `passkey` from createPasskey in passkey.ts.
   */
  async lockWithPasskey(passkey: { credential: string; salt: string; secret: Uint8Array }, options: { idleMs?: number | null } = {}) {
    if (passkey.secret.byteLength < 32) throw fail("bad_passkey", 400, "That passkey's secret is too short to lock anything with.");
    const lockKey = await derive(passkey.secret, "device-lock");
    const envelope = await seal(this.record.key, await seal(lockKey, this.keys.root, ctx.accountKey("passkey")), ctx.lockedEnvelope);
    const token = newDeviceToken();
    const lock: DeviceLock = {
      kind: "passkey",
      credential: passkey.credential,
      salt: passkey.salt,
      token: toB64u(await seal(lockKey, token, ctx.deviceToken)),
      idleMs: options.idleMs === undefined ? (this.record.lock?.idleMs ?? DEFAULT_LOCK_IDLE_MS) : options.idleMs,
    };
    await this.swapEnvelope(envelope, "passkey", token, { ...this.record, token: null, lock });
  }

  /** Takes the passkey lock off this device: opening it needs only the device again. */
  async removeLock() {
    if (!this.record.lock) return;
    const token = newDeviceToken();
    const envelope = await seal(this.record.key, this.keys.root, ctx.accountKey("device"));
    await this.swapEnvelope(envelope, null, token, { ...this.record, token, lock: null });
  }

  /** How long this locked device waits without use before locking itself again (null: never). */
  async setLockIdle(idleMs: number | null) {
    if (!this.record.lock) throw fail("not_locked", 400, "This device isn't locked with a passkey.", "Lock it first.");
    if (idleMs !== null && (!Number.isFinite(idleMs) || idleMs < 60_000)) throw fail("bad_request", 400, "Pick at least a minute, or never.");
    const record = { ...this.record, lock: { ...this.record.lock, idleMs } };
    await this.store.save(record);
    this.record = record;
  }

  /** Remembers the new lock here first, so a failed call to the server can be put back. */
  private async swapEnvelope(envelope: Uint8Array, lock: "passkey" | null, token: string, record: DeviceRecord) {
    const previous = this.record;
    await this.store.save(record);
    try {
      await this.rpc.call("device.envelope", { envelope: toB64u(envelope), lock, tokenHash: await hashOf(token) });
    } catch (err) {
      await this.store.save(previous);
      throw err;
    }
    this.rpc.token = token;
    this.record = record;
  }

  async renameDevice(id: string, label: string) {
    await this.rpc.call("device.label", { id, label: await this.sealMeta(label, ctx.deviceLabel) });
  }

  /** Signs a device out for good. Removing this device also forgets it here. */
  async removeDevice(id: string): Promise<{ self: boolean }> {
    const res = await this.rpc.call<{ self: boolean }>("device.remove", { id });
    if (res.self) await this.store.clear();
    return res;
  }

  async signOut() {
    await this.removeDevice(this.deviceId);
  }

  /**
   * Picks how you'd get back in if you lost every device. "kit" (the standard)
   * returns a new recovery-kit code, "friends" returns the pieces to hand out.
   * Either way, the old kit or pieces stop working.
   */
  async setRecovery(plan: RecoveryPlan, options: { count?: number; threshold?: number } = {}): Promise<{ kit?: string; pieces?: string[]; threshold?: number }> {
    if (plan === "kit") {
      const kit = await makeKit(this.keys.root);
      await this.rpc.call("recovery.set", { plan, lookup: kit.lookup, envelope: kit.envelope });
      return { kit: kit.code };
    }
    if (plan === "friends") {
      const count = options.count ?? 3;
      const threshold = options.threshold ?? 2;
      if (!Number.isInteger(count) || !Number.isInteger(threshold) || threshold < 2 || count < threshold || count > 10) {
        throw fail("bad_request", 400, "Pick 2 to 10 friends, and how many of them it takes (at least 2).");
      }
      const friends = await makeFriends(this.keys.root, count, threshold);
      await this.rpc.call("recovery.set", { plan, lookup: friends.lookup, envelope: friends.envelope });
      return { pieces: friends.pieces, threshold };
    }
    await this.rpc.call("recovery.set", { plan });
    return {};
  }

  async deleteAccount() {
    await this.rpc.call("account.delete", { confirm: this.id });
    await this.store.clear();
  }

  // ── Boxes ────────────────────────────────────────────────────────────────

  private async openBoxInfo(raw: WireBox): Promise<BoxInfo> {
    const shared = raw.shared;
    const root = await open(this.keys.wrap, fromB64u(raw.key), shared ? ctx.memberBoxKey(raw.id) : ctx.boxKey(raw.id));
    const keys = await boxKeys(root);
    const name = await openText(this.keys.meta, fromB64u(raw.name), shared ? ctx.memberBoxName(raw.id) : ctx.boxName(raw.id));
    const profile = raw.profile ? await openJson<AppProfile>(keys.seal, fromB64u(raw.profile), ctx.boxProfile(raw.id)).catch(() => ({})) : {};
    const tapes = await Promise.all(raw.tapes.map((t) => this.openTape(t)));
    const inBox = (sealed: string | null, context: string, fallback: string) =>
      sealed ? openText(keys.seal, fromB64u(sealed), context).catch(() => fallback) : Promise.resolve(fallback);
    const owner = shared ? await inBox(raw.ownerLabel, ctx.ownerLabel(raw.id), "Whoever shared it") : null;
    const members = await Promise.all(raw.members.map(async (m) => ({ ...m, label: undefined, name: await inBox(m.label, ctx.memberLabel(raw.id, m.id), "Someone") })));
    const links = await Promise.all(raw.shares.map(async (l) => ({ ...l, label: l.label ? await this.openMeta(l.label, ctx.shareLabel(raw.id), "") || null : null })));
    return {
      ...raw,
      name,
      profile,
      tapes,
      keys,
      shared: shared ? { from: owner ?? "Whoever shared it", write: shared.write, memberId: shared.member, joinedAt: shared.joinedAt } : null,
      people: { owner, members, links },
    };
  }

  private async ownedBox(name: string): Promise<BoxInfo> {
    const box = await this.box(name);
    if (box.shared) throw fail("not_your_box", 403, `${name} was shared with you by ${box.shared.from}; only they can change that.`, "You can leave it, or rename it for yourself.");
    return box;
  }

  private async openTape(t: WireTape): Promise<TapeInfo> {
    return { ...t, label: await this.openMeta(t.label, ctx.tapeLabel(t.box), t.kind === "grant" ? "signed-in app" : "(unnamed)") };
  }

  /** All your boxes, opened. */
  async boxes(): Promise<BoxInfo[]> {
    const { boxes } = await this.rpc.call<{ boxes: WireBox[] }>("boxes");
    const opened = await Promise.all(boxes.map((b) => this.openBoxInfo(b)));
    this.boxCache = new Map(opened.map((b) => [b.id, b]));
    return opened.sort((a, b) => a.name.localeCompare(b.name));
  }

  private async cache(): Promise<Map<string, BoxInfo>> {
    if (!this.boxCache) await this.boxes();
    return this.boxCache!;
  }

  /** A box by name. "LORE" finds "lore": names are typed by people too. */
  async box(name: string): Promise<BoxInfo> {
    const wanted = new Set([name, toName(name)]);
    for (const fresh of [false, true]) {
      if (fresh) await this.boxes();
      for (const box of (await this.cache()).values()) if (box.name === name) return box;
      for (const box of (await this.cache()).values()) if (wanted.has(box.name)) return box;
    }
    throw fail("no_such_box", 404, `There's no box called ${name}.`, `Make it with: cardboard connect ${name}`);
  }

  async boxById(id: string): Promise<BoxInfo | undefined> {
    return (await this.cache()).get(id) ?? (await this.boxes()).find((b) => b.id === id);
  }

  async createBox(name: string, settings?: Record<string, unknown>): Promise<BoxInfo> {
    if (!NAME_PATTERN.test(name)) {
      throw fail("bad_box_name", 400, `"${name}" can't be used as a box name.`, `Names are lowercase letters, numbers and dashes${toName(name) ? `: try ${toName(name)}` : ", like recipe-app"}.`);
    }
    for (const box of (await this.cache()).values()) {
      if (box.shared && box.name === name) throw fail("box_exists", 409, `You already have a box called ${name} (shared with you by ${box.shared.from}).`, "Pick another name, or rename that one.");
    }
    const id = newClientId("box");
    const root = newKey();
    const res = await this.rpc.call<{ box: WireBox }>("box.create", {
      id,
      idx: await boxIndex(this.keys, name),
      name: await this.sealMeta(name, ctx.boxName(id)),
      key: toB64u(await seal(this.keys.wrap, root, ctx.boxKey(id))),
      settings,
    });
    const box = await this.openBoxInfo(res.box);
    (await this.cache()).set(box.id, box);
    return box;
  }

  /** A free name based on `base` ("notes", "notes-2", …). */
  async freeName(base: string): Promise<string> {
    const taken = new Set((await this.boxes()).map((b) => b.name));
    let name = base;
    for (let i = 2; taken.has(name); i++) name = `${base.slice(0, 58)}-${i}`;
    return name;
  }

  /** The box itself, as the SDK sees it: get, put, query, history, undo… opened on this device. */
  async open(box: string | BoxInfo): Promise<Box> {
    const info = typeof box === "string" ? await this.box(box) : box;
    return Box.owned(this.rpc, info.id, info.keys, this.keys.names, info.settings);
  }

  async setBoxSettings(name: string, settings: Record<string, unknown>): Promise<BoxInfo> {
    const box = await this.ownedBox(name);
    const res = await this.rpc.call<{ box: WireBox }>("box.settings", { box: box.id, settings });
    const updated = await this.openBoxInfo(res.box);
    (await this.cache()).set(updated.id, updated);
    return updated;
  }

  async renameBox(name: string, to: string): Promise<BoxInfo> {
    if (!NAME_PATTERN.test(to)) throw fail("bad_box_name", 400, `"${to}" can't be used as a box name.`, `Names are lowercase letters, numbers and dashes${toName(to) ? `: try ${toName(to)}` : ""}.`);
    const box = await this.box(name);
    if ((await this.boxes()).some((b) => b.name === to && b.id !== box.id)) throw fail("box_exists", 409, `You already have a box called ${to}.`);
    if (box.shared) {
      // Your own name for a box someone shared with you: only you see it.
      await this.rpc.call("member.rename", { box: box.id, name: await this.sealMeta(to, ctx.memberBoxName(box.id)) });
      this.boxCache = null;
      return this.box(to);
    }
    const res = await this.rpc.call<{ box: WireBox }>("box.rename", { box: box.id, idx: await boxIndex(this.keys, to), name: await this.sealMeta(to, ctx.boxName(box.id)) });
    const updated = await this.openBoxInfo(res.box);
    (await this.cache()).set(updated.id, updated);
    return updated;
  }

  async setBoxProfile(name: string, profile: AppProfile) {
    const box = await this.ownedBox(name);
    await this.rpc.call("box.profile", { box: box.id, profile: toB64u(await sealJson(box.keys.seal, profile, ctx.boxProfile(box.id))) });
    this.boxCache = null;
  }

  /** Crypto-shredding: the sealed box key, every item, version, tape and log line go. */
  async shredBox(name: string) {
    const box = await this.ownedBox(name);
    await this.rpc.call("box.shred", { box: box.id, confirm: box.id });
    this.boxCache?.delete(box.id);
  }

  async rewind(name: string, to: string | number): Promise<{ changed: number; to: number }> {
    const box = await this.ownedBox(name);
    return this.rpc.call("rewind", { box: box.id, to });
  }

  /**
   * A box, ready to export: a header, then every item, fetched a few MB at a
   * time so a box full of videos never has to fit in memory. Bytes (a file's
   * parts) come as base64 in `bytes`; everything else as JSON in `value`.
   */
  async *exportRecords(name: string): AsyncGenerator<Record<string, unknown>> {
    const info = await this.box(name);
    const box = await this.open(info);
    yield { format: "cardboard-export", formatVersion: 3, box: info.name, exportedAt: new Date().toISOString() };
    const entries = await box.list("", { limit: Infinity });
    for (let i = 0; i < entries.length; ) {
      let end = i + 1;
      for (let bytes = entries[i]!.size; end < entries.length && end - i < 500 && bytes + entries[end]!.size <= 8 * 1024 * 1024; end++) bytes += entries[end]!.size;
      for (const { key, value, version, createdAt, updatedAt, expiresAt } of await box.getMany(entries.slice(i, end).map((e) => e.key))) {
        yield value instanceof Uint8Array ? { key, bytes: toB64u(value), version, createdAt, updatedAt, expiresAt } : { key, value, version, createdAt, updatedAt, expiresAt };
      }
      i = end;
    }
  }

  /** The export as JSON Lines (one record per line), for writing straight to a file. */
  async *exportLines(name: string): AsyncGenerator<string> {
    for await (const record of this.exportRecords(name)) yield `${JSON.stringify(record)}\n`;
  }

  /** The whole export as one object, in memory: fine for boxes without big files. */
  async exportBox(name: string) {
    const records: Array<Record<string, unknown>> = [];
    for await (const record of this.exportRecords(name)) records.push(record);
    const [header, ...items] = records;
    return { ...header!, items };
  }

  /**
   * Imports an export: the object exportBox gives, a list of { key, value }
   * (or { key, bytes }), or records one at a time (JSON Lines, read as you go).
   */
  async importBox(name: string, data: unknown): Promise<{ imported: number; skipped: number }> {
    const list = (data && typeof data === "object" && "items" in data ? (data as { items: unknown }).items : data) as unknown;
    const records = list as AsyncIterable<unknown> | Iterable<unknown>;
    if (!Array.isArray(list) && !(list && typeof list === "object" && (Symbol.asyncIterator in list || Symbol.iterator in list))) {
      throw fail("bad_import", 400, "Import expects a list of { key, value } items, like a Cardboard export.");
    }
    const box = await this.open(name);
    const now = Date.now();
    let ops: Array<{ op: "put"; key: string; value: unknown; ttl?: number }> = [];
    let bytes = 0;
    let imported = 0;
    let skipped = 0;
    const flush = async () => {
      if (ops.length) await box.batch(ops);
      imported += ops.length;
      ops = [];
      bytes = 0;
    };
    for await (const raw of records) {
      const item = raw as { key?: unknown; value?: unknown; bytes?: unknown; expiresAt?: unknown; format?: unknown };
      if (item && typeof item.format === "string" && item.key === undefined) continue; // a header line
      if (item && typeof item.bytes === "string") item.value = fromB64u(item.bytes);
      if (!item || typeof item.key !== "string" || item.value === undefined) throw fail("bad_import", 400, "Every imported item needs a string `key` and a `value` (or `bytes`).");
      const expiresAt = typeof item.expiresAt === "number" ? item.expiresAt : null;
      if (expiresAt !== null && expiresAt <= now) {
        skipped++;
        continue;
      }
      const size = item.value instanceof Uint8Array ? item.value.length : JSON.stringify(item.value).length;
      if (ops.length >= 200 || (ops.length > 0 && bytes + size > 8 * 1024 * 1024)) await flush();
      ops.push({ op: "put", key: item.key, value: item.value, ...(expiresAt ? { ttl: Math.ceil((expiresAt - now) / 1000) } : {}) });
      bytes += size;
    }
    await flush();
    return { imported, skipped };
  }

  // ── Tapes ────────────────────────────────────────────────────────────────

  /**
   * A tape for an app: a token (the server keeps its hash) and a key (only the
   * app keeps it) that opens a sealed copy of the box key. Returned once.
   */
  async createTape(
    boxName: string,
    options: { label?: string; read?: boolean; write?: boolean; idle?: string | null; expires?: string | null; kind?: "app" | "assistant" } = {},
  ): Promise<{ tape: TapeInfo; secret: string }> {
    const box = await this.box(boxName);
    const token = random(32);
    const tapeKey = random(32);
    const label = (options.label ?? "default").trim().slice(0, 60) || "default";
    const sealedBundle = await sealJson(tapeKey, bundle(box.id, box.keys.root, this.keys.names.root), ctx.tapeBundle(box.id));
    const res = await this.rpc.call<{ tape: WireTape }>("tape.create", {
      box: box.id,
      tokenHash: toB64u(await sha256(`cbt_${toB64u(token)}`)),
      bundle: toB64u(sealedBundle),
      label: await this.sealMeta(label, ctx.tapeLabel(box.id)),
      kind: options.kind ?? "app",
      read: options.read,
      write: options.write,
      idle: options.idle,
      expires: options.expires,
    });
    this.boxCache = null;
    return { tape: await this.openTape(res.tape), secret: `cbt_${toB64u(concat(token, tapeKey))}` };
  }

  async revokeTape(id: string): Promise<TapeInfo> {
    const res = await this.rpc.call<{ tape: WireTape }>("tape.revoke", { id });
    this.boxCache = null;
    return this.openTape(res.tape);
  }

  /** Every tape you made, across boxes. */
  async tape(id: string): Promise<{ tape: TapeInfo; box: BoxInfo } | undefined> {
    for (const box of await this.boxes()) {
      const tape = box.tapes.find((t) => t.id === id);
      if (tape) return { tape, box };
    }
    return undefined;
  }

  // ── Sharing boxes with people ────────────────────────────────────────────

  /**
   * A link that shares a box with one person. Its secret is in the part after
   * #, which browsers never send to a server: a key made from it seals the
   * box key and name for whoever opens it. It works once, then it's gone.
   * `as` is your name as they'll see it; `label` is your note on who it's for.
   */
  async shareBox(
    boxName: string,
    options: { write?: boolean; label?: string; as?: string; expires?: string } = {},
  ): Promise<{ link: string; code: string; share: ShareLinkInfo; expiresAt: number }> {
    const box = await this.ownedBox(boxName);
    const me = await this.me();
    const from = (options.as ?? me.profile.name ?? "").trim().slice(0, 60) || "Someone";
    const secret = random(SHARE_BYTES);
    const [auth, wrap] = await Promise.all([derive(secret, "share-auth"), derive(secret, "share-wrap")]);
    const envelope: ShareEnvelope = { v: 1, box: toB64u(box.keys.root), name: box.name, from };
    const label = options.label?.trim().slice(0, 60);
    const res = await this.rpc.call<{ share: WireBox["shares"][number] }>("share.create", {
      box: box.id,
      lookup: toB64u(await sha256(auth)),
      envelope: toB64u(await sealJson(wrap, envelope, ctx.share(box.id))),
      label: label ? await this.sealMeta(label, ctx.shareLabel(box.id)) : undefined,
      write: options.write ?? true,
      ttl: options.expires,
      ownerLabel: toB64u(await seal(box.keys.seal, from, ctx.ownerLabel(box.id))),
    });
    this.boxCache = null;
    const code = toCode(secret);
    return { link: `${me.server.issuer || this.url}/#share=${code}`, code, share: { ...res.share, label: label ?? null }, expiresAt: res.share.expiresAt };
  }

  /** Cancels a share link nobody has used yet. */
  async cancelShare(id: string) {
    await this.rpc.call("share.revoke", { id });
    this.boxCache = null;
  }

  private async shareKeys(link: string) {
    const code = /#share=([^&\s]+)/.exec(link)?.[1] ?? link;
    const secret = fromCode(decodeURIComponent(code), SHARE_BYTES);
    const [auth, wrap] = await Promise.all([derive(secret, "share-auth"), derive(secret, "share-wrap")]);
    return { auth: toB64u(auth), wrap };
  }

  /** What a share link (or its code) is for, opened here. Doesn't use it up. */
  async viewShare(link: string): Promise<SharePreview> {
    const { auth, wrap } = await this.shareKeys(link);
    const res = await this.rpc.call<{ box: string; envelope: string; write: boolean; expiresAt: number; own: boolean; member: boolean }>("share.view", { secret: auth });
    const opened = await openJson<ShareEnvelope>(wrap, fromB64u(res.envelope), ctx.share(res.box));
    return { boxId: res.box, name: opened.name, from: opened.from, write: res.write, expiresAt: res.expiresAt, own: res.own, member: res.member };
  }

  /**
   * Joins a box someone shared with you. The box key is re-sealed with your
   * own account key, so the link is no longer needed (and no longer works).
   * `as` is your name as everyone in the box will see it.
   */
  async joinShare(link: string, options: { as?: string; name?: string } = {}): Promise<BoxInfo> {
    const { auth, wrap } = await this.shareKeys(link);
    const view = await this.rpc.call<{ box: string; envelope: string; own: boolean; member: boolean }>("share.view", { secret: auth });
    if (view.own) throw fail("own_box", 409, "That's your own box.", "Send the link to the person you want to share it with.");
    if (view.member) throw fail("already_member", 409, "You're already in this box.", "It's on your shelf.");
    const opened = await openJson<ShareEnvelope>(wrap, fromB64u(view.envelope), ctx.share(view.box));
    const root = fromB64u(opened.box);
    const keys = await boxKeys(root);
    const id = newClientId("mem");
    const wanted = toName(options.name ?? opened.name).slice(0, 50) || "shared";
    const name = await this.freeName(wanted);
    const as = (options.as ?? (await this.me()).profile.name ?? "").trim().slice(0, 60) || "Someone";
    const res = await this.rpc.call<{ box: WireBox }>("share.accept", {
      secret: auth,
      id,
      key: toB64u(await seal(this.keys.wrap, root, ctx.memberBoxKey(view.box))),
      name: await this.sealMeta(name, ctx.memberBoxName(view.box)),
      label: toB64u(await seal(keys.seal, as, ctx.memberLabel(view.box, id))),
    });
    const box = await this.openBoxInfo(res.box);
    (await this.cache()).set(box.id, box);
    return box;
  }

  /** Takes someone off a box you own. Their apps' tapes on it stop working right away. */
  async removeMember(boxName: string, member: string) {
    const box = await this.ownedBox(boxName);
    const found = box.people.members.find((m) => m.id === member || m.name === member);
    if (!found) throw fail("no_such_member", 404, `Nobody called ${member} is in ${boxName}.`, `See who is: cardboard box ${boxName}`);
    await this.rpc.call("member.remove", { box: box.id, member: found.id });
    this.boxCache = null;
  }

  /** Leaves a box someone shared with you. */
  async leaveBox(boxName: string) {
    const box = await this.box(boxName);
    if (!box.shared) throw fail("own_box", 409, `${boxName} is your own box: you can't leave it.`, "Shred it, or take people off it.");
    await this.rpc.call("member.leave", { box: box.id });
    this.boxCache?.delete(box.id);
  }

  // ── Smart (worked out here, never on the server) ─────────────────────────

  /** What a box holds, worked out from its opened data. Cached until the box changes. */
  async inventory(box: string | BoxInfo): Promise<Inventory> {
    const info = typeof box === "string" ? await this.box(box) : box;
    const stamp = `${info.items}:${info.bytes}:${info.lastActivity}`;
    const cached = this.inventories.get(info.id);
    if (cached?.stamp === stamp) return cached.inventory;
    // A file's bytes (in the personal box) are skipped: there's nothing to label in them, and they're big.
    const result = inventory((await (await this.open(info)).items("", { skip: isFileData })) as Item[]);
    this.inventories.set(info.id, { stamp, inventory: result });
    return result;
  }

  async blast(tape: TapeInfo, box: BoxInfo): Promise<BlastRadius> {
    return blastRadius(tape, tape.state, { name: box.name, historyDays: box.settings.historyDays }, await this.inventory(box), Date.now());
  }

  async insights(options: { boxes?: BoxInfo[]; me?: Me; docks?: { docks: DockInfo[]; pending: PendingDock[] } } = {}): Promise<Insight[]> {
    const [boxes, me, docks] = await Promise.all([options.boxes ?? this.boxes(), options.me ?? this.me(), options.docks ?? this.docks()]);
    return insights({
      now: Date.now(),
      url: this.url,
      recovery: { plan: me.recovery, ready: me.recoveryReady },
      devices: me.devices,
      // Box advice is about settings only the owner can change, so boxes shared with you sit this out.
      boxes: await Promise.all(
        boxes.filter((b) => !b.shared).map(async (b) => ({
          name: b.name,
          personal: b.id === me.profile.personal,
          settings: b.settings,
          createdAt: b.createdAt,
          stats: { items: b.items, bytes: b.bytes },
          inventory: await this.inventory(b).catch(() => null),
          tapes: b.tapes,
          denied24h: b.denied24h,
          customs24h: b.customs24h,
        })),
      ),
      pendingDocks: docks.pending,
      docks: docks.docks.filter((d) => d.name).map((d) => ({ name: d.name!, unclaimed: d.inFlight.unclaimed })),
      alarms: me.alarms,
      quota: me.quota,
    });
  }

  /** Searches every box, here on this device. */
  async search(query: string): Promise<Array<{ box: string; key: string; snippet: string | null }>> {
    const q = query.trim().toLowerCase();
    if (q.length < 2) throw fail("bad_search", 400, "Search for at least 2 characters.");
    const results: Array<{ box: string; key: string; snippet: string | null }> = [];
    const personal = (await this.me()).profile.personal;
    for (const box of await this.boxes()) {
      for (const item of await (await this.open(box)).items("", { skip: isFileData })) {
        if (results.length >= 50) return results;
        // In your personal box, search what you'd read (titles, notes, usernames), never a password.
        if (item.value instanceof Uint8Array) continue;
        const thing = box.id === personal && kindOfKey(item.key) !== null;
        const text = thing ? searchText(item.value) : JSON.stringify(item.value);
        const at = text.toLowerCase().indexOf(q);
        if (at >= 0 || (!thing && item.key.toLowerCase().includes(q))) {
          results.push({ box: box.name, key: item.key, snippet: at >= 0 ? text.slice(Math.max(0, at - 40), at + q.length + 40).replace(/\s+/g, " ") : null });
        }
      }
    }
    return results;
  }

  /** The activity log, opened and in plain English. */
  async log(options: { box?: string; limit?: number; before?: number } = {}): Promise<LogLine[]> {
    const boxId = options.box ? (await this.box(options.box)).id : undefined;
    const res = await this.rpc.call<{
      entries: Array<{ id: number; at: number; box: string | null; dock: string | null; actor: string; action: string; outcome: Outcome; count: number | null; note: string | null; ref: { sealed: string; ctx: string } | null; detail: string | null }>;
      actors: Record<
        string,
        | { kind: "device" | "tape"; gone?: boolean; label?: string | null; deviceKind?: DeviceKind; box?: string; tapeKind?: string; app?: string | null }
        | { kind: "person"; via: "device" | "app"; box: string; label: string | null; labelCtx: string; owner: boolean }
      >;
    }>("log", { box: boxId, limit: options.limit, before: options.before });
    const boxes = await this.cache();
    const dockNames = new Map<string, string>();
    const needsDocks = res.entries.some((e) => e.dock);
    if (needsDocks) for (const d of (await this.docks()).docks) if (d.name) dockNames.set(d.id, d.name);

    const who = async (actor: string): Promise<string> => {
      if (actor === "system") return "Cardboard";
      if (actor === "anonymous") return "Someone without a valid token";
      if (actor === "host") return "Whoever runs Cardboard";
      const info = res.actors[actor];
      if (info?.kind === "person") {
        // Someone you share a box with, named the way they asked to be.
        const box = boxes.get(info.box);
        const name = box && info.label ? await openText(box.keys.seal, fromB64u(info.label), info.labelCtx).catch(() => null) : null;
        const who = name ?? (info.owner ? "The box's owner" : "Someone you share with");
        return info.via === "app" ? `${who} (in an app)` : who;
      }
      if (!info || info.gone) return actor.startsWith("tape:") ? "A tape that no longer exists" : "A device that was removed";
      if (info.kind === "device") {
        if (actor === `device:${this.deviceId}`) return "You (this device)";
        return `You (on “${await this.openMeta(info.label, ctx.deviceLabel, defaultDeviceName(info.deviceKind ?? "other"))}”)`;
      }
      const boxName = info.box ? (boxes.get(info.box)?.name ?? "a shredded box") : "an app";
      if (info.tapeKind === "grant") return `${info.app ?? boxName} (signed in)`;
      const label = await this.openMeta(info.label, ctx.tapeLabel(info.box ?? ""), "(unnamed)");
      return info.tapeKind === "assistant" ? `${label} (AI assistant)` : `${boxName} (tape “${label}”)`;
    };

    return Promise.all(
      res.entries.map(async (e) => {
        const box = e.box ? (boxes.get(e.box) ?? null) : null;
        const opened: OpenedEntry = {
          action: e.action,
          outcome: e.outcome,
          count: e.count,
          note: e.note,
          who: await who(e.actor),
          what: e.ref ? await this.openRef(e.ref, boxes) : null,
          box: box?.name ?? null,
          dock: e.dock ? (dockNames.get(e.dock) ?? null) : null,
          detail: e.detail ? await this.openDetail(e.detail, box) : null,
        };
        return { id: e.id, at: e.at, box: box?.name ?? null, action: e.action, outcome: e.outcome, text: describe(opened) };
      }),
    );
  }

  private async openRef(ref: { sealed: string; ctx: string }, boxes: Map<string, BoxInfo>): Promise<string | null> {
    const [kind, owner] = ref.ctx.split("|");
    try {
      if (kind === "item-name" || kind === "dock-ask" || kind === "member-label") {
        const box = boxes.get(owner ?? "");
        return box ? await openText(box.keys.seal, fromB64u(ref.sealed), ref.ctx) : null;
      }
      return await openText(this.keys.meta, fromB64u(ref.sealed), ref.ctx);
    } catch {
      return null;
    }
  }

  private async openDetail(sealed: string, box: BoxInfo | null): Promise<{ notices?: string[] } | null> {
    try {
      return await openJson(box ? box.keys.seal : this.keys.meta, fromB64u(sealed), ctx.logNote(box?.id ?? null));
    } catch {
      return null;
    }
  }

  // ── Docks ────────────────────────────────────────────────────────────────

  private async rawDocks() {
    return this.rpc.call<{ docks: WireDock[]; pending: Array<{ dock: string; box: string; send: boolean; receive: boolean; requestedAt: number | null; ask: string | null }> }>("docks");
  }

  /** Your docks and the requests waiting for you, with every name opened. */
  async docks(): Promise<{ docks: DockInfo[]; pending: PendingDock[] }> {
    const raw = await this.rawDocks();
    const boxes = await this.cache();
    const asked = new Map<string, string>();
    const nameOf = async (d: WireDock): Promise<string | null> => {
      if (d.name) return this.openMeta(d.name, ctx.dockName(d.id), "(unreadable)");
      // Not opened yet: the asking apps sealed its name for you.
      for (const b of d.berths) {
        const box = boxes.get(b.box);
        if (!b.ask || !box) continue;
        try {
          return await openText(box.keys.seal, fromB64u(b.ask), ctx.dockAsk(box.id, d.idx));
        } catch {
          // An app that can't seal properly; try the next.
        }
      }
      return null;
    };
    const docks: DockInfo[] = [];
    for (const d of raw.docks) {
      const name = await nameOf(d);
      if (name) asked.set(d.id, name);
      docks.push({
        id: d.id,
        name: d.name ? name : null,
        settings: d.settings,
        createdAt: d.createdAt,
        inFlight: d.inFlight,
        berths: d.berths.map((b) => ({ ...b, ask: undefined, boxId: b.box, box: boxes.get(b.box)?.name ?? "(shredded box)" })),
      });
    }
    const pending = raw.pending.map((p) => ({
      dock: asked.get(p.dock) ?? "(a dock it didn't name)",
      dockId: p.dock,
      box: boxes.get(p.box)?.name ?? "(shredded box)",
      boxId: p.box,
      send: p.send,
      receive: p.receive,
      requestedAt: p.requestedAt,
    }));
    return { docks: docks.filter((d) => d.name !== null || d.berths.length > 0), pending };
  }

  /** Finds a dock by name, including one an app asked for that you haven't opened yet. */
  private async findDock(name: string): Promise<WireDock | undefined> {
    const { docks } = await this.rawDocks();
    for (const candidate of new Set([name, toName(name)])) {
      if (!candidate) continue;
      const idx = await dockIndex(this.keys.names, candidate);
      const found = docks.find((d) => d.idx === idx);
      if (found) return found;
    }
    return undefined;
  }

  private async requireDock(name: string): Promise<WireDock & { key: string }> {
    const dock = await this.findDock(name);
    if (!dock?.key) throw fail("no_such_dock", 404, `There's no dock called ${name}.`, `Make it with: cardboard dock create ${name}`);
    return dock as WireDock & { key: string };
  }

  private async dockRoot(dock: WireDock & { key: string }): Promise<Uint8Array> {
    return open(this.keys.wrap, fromB64u(dock.key), ctx.dockKey(dock.id));
  }

  /** The dock key, sealed for one box (only that app can open it). */
  private async berthKey(dockId: string, root: Uint8Array, box: BoxInfo): Promise<string> {
    return toB64u(await seal(box.keys.wrap, root, ctx.berthKey(dockId, box.id)));
  }

  async createDock(name: string, options: { send?: string[]; receive?: string[]; settings?: Record<string, unknown> } = {}): Promise<DockInfo> {
    if (!NAME_PATTERN.test(name)) {
      throw fail("bad_dock_name", 400, `"${name}" can't be used as a dock name.`, `Names are lowercase letters, numbers and dashes${toName(name) ? `: try ${toName(name)}` : ", like shopping-list"}.`);
    }
    const existing = await this.findDock(name);
    if (existing?.key) throw fail("dock_exists", 409, `There's already a dock called ${name}.`);
    const id = existing?.id ?? newClientId("dock");
    const root = newKey();
    const send = options.send ?? [];
    const receive = options.receive ?? [];
    const berths = [];
    for (const boxName of new Set([...send, ...receive])) {
      const box = await this.box(boxName);
      berths.push({ box: box.id, send: send.includes(boxName), receive: receive.includes(boxName), key: await this.berthKey(id, root, box) });
    }
    await this.rpc.call("dock.create", {
      id,
      idx: await dockIndex(this.keys.names, name),
      name: await this.sealMeta(name, ctx.dockName(id)),
      key: toB64u(await seal(this.keys.wrap, root, ctx.dockKey(id))),
      settings: options.settings,
      berths,
    });
    return (await this.docks()).docks.find((d) => d.id === id)!;
  }

  async dockGrant(dockName: string, boxName: string, can: { send?: boolean; receive?: boolean }) {
    const dock = await this.requireDock(dockName);
    const box = await this.box(boxName);
    await this.rpc.call("dock.grant", { dock: dock.id, box: box.id, ...can, key: await this.berthKey(dock.id, await this.dockRoot(dock), box) });
  }

  /** Says yes to an app's request. Opens the dock first if the app asked for one you hadn't made. */
  async dockApprove(dockName: string, boxName: string) {
    let dock = await this.findDock(dockName);
    if (!dock) throw fail("no_request", 404, `Nothing has asked to dock on ${dockName}.`);
    if (!dock.key) {
      await this.createDock(dockName);
      dock = (await this.findDock(dockName))!;
    }
    const box = await this.box(boxName);
    await this.rpc.call("dock.approve", { dock: dock.id, box: box.id, key: await this.berthKey(dock.id, await this.dockRoot(dock as WireDock & { key: string }), box) });
  }

  async dockDeny(dockName: string, boxName: string) {
    const dock = await this.findDock(dockName);
    if (!dock) throw fail("no_request", 404, `Nothing has asked to dock on ${dockName}.`);
    await this.rpc.call("dock.deny", { dock: dock.id, box: (await this.box(boxName)).id });
  }

  async dockRemove(dockName: string, boxName: string): Promise<boolean> {
    const dock = await this.requireDock(dockName);
    return (await this.rpc.call<{ removed: boolean }>("dock.remove", { dock: dock.id, box: (await this.box(boxName)).id })).removed;
  }

  async dockSettings(dockName: string, settings: Record<string, unknown>) {
    const dock = await this.requireDock(dockName);
    await this.rpc.call("dock.settings", { dock: dock.id, settings });
  }

  /** What's in flight on a dock, opened here, and which of your apps really sent it. */
  async dockPeek(dockName: string): Promise<Array<{ seq: number; from: string; sender: string; to: string | null; body: unknown; sentAt: number; expiresAt: number; redacted: string[]; wouldStrip: string[] }>> {
    const dock = await this.requireDock(dockName);
    const keys = await dockKeys(await this.dockRoot(dock));
    const { parcels } = await this.rpc.call<{ parcels: Array<{ id: string; seq: number; from: string; to: string | null; body: string; sentAt: number; expiresAt: number; senderBox: string }> }>("dock.peek", { dock: dock.id });
    const boxes = await this.cache();
    return Promise.all(
      parcels.map(async (p) => {
        let body: unknown = "(didn't open with the dock key)";
        let redacted: string[] = [];
        let wouldStrip: string[] = [];
        try {
          const envelope = await openJson<{ body: unknown; redacted: string[] }>(keys.seal, fromB64u(p.body), ctx.parcel(dock.id, p.id));
          body = envelope.body;
          redacted = envelope.redacted;
          wouldStrip = (() => {
            try {
              return inspect(body, { ...dock.settings, shape: (dock.settings["shape"] as Record<string, string> | null) ?? null } as never).stripped;
            } catch {
              return [];
            }
          })();
        } catch {
          // Shown as unopenable: someone sealed it with the wrong key.
        }
        return { seq: p.seq, from: p.from, sender: boxes.get(p.senderBox)?.name ?? "(shredded box)", to: p.to, body, sentAt: p.sentAt, expiresAt: p.expiresAt, redacted, wouldStrip };
      }),
    );
  }

  async shredDock(dockName: string) {
    const dock = await this.findDock(dockName);
    if (!dock) throw fail("no_such_dock", 404, `There's no dock called ${dockName}.`);
    await this.rpc.call("dock.shred", { dock: dock.id, confirm: dock.id });
  }

  // ── Apps (Sign in with Cardboard) ────────────────────────────────────────

  async apps() {
    const res = await this.rpc.call<{
      issuer: string;
      connected: Array<{ grant: string; client: string; name: string; site: string; scopes: string[]; box: string | null; privateId: string; connectedAt: number; lastUsedAt: number | null; selfRegistered: boolean }>;
      registered: Array<{ client: string; name: string; redirectUris: string[]; createdAt: number }>;
      mine: Array<{ client: string; name: string; home: string }>;
    }>("apps");
    let boxes = await this.cache();
    // A box made by a sign-in in another tab (or on another device) isn't in this page's list yet.
    if (res.connected.some((c) => c.box && !boxes.has(c.box))) {
      await this.boxes();
      boxes = await this.cache();
    }
    return { ...res, connected: res.connected.map((c) => ({ ...c, boxName: c.box ? (boxes.get(c.box)?.name ?? null) : null })) };
  }

  async registerApp(app: { name: string; redirectUris: string[]; clientUri?: string; public?: boolean }) {
    return this.rpc.call<{ client_id: string; client_secret?: string; client_name: string; redirect_uris: string[] }>("apps.register", app);
  }

  async disconnectApp(grant: string, options: { shred?: boolean } = {}) {
    const res = await this.rpc.call<{ disconnected: string; shredded: string | null }>("apps.disconnect", { grant, shred: options.shred });
    this.boxCache = null;
    return res;
  }

  async forgetApp(client: string) {
    return this.rpc.call<{ forgotten: string }>("apps.forget", { client });
  }

  /** An app asking you to sign in, as your dashboard shows it. */
  async signInRequest(id: string) {
    const req = await this.rpc.call<{
      client: { id: string; name: string; uri: string | null; selfRegistered: boolean };
      site: string;
      scopes: string[];
      appKey: string | null;
      prompt: string | null;
      returning: { scopes: string[]; box: string | null } | null;
      box: string | null;
    }>("oauth.request", { id });
    const box = req.box ? await this.boxById(req.box) : undefined;
    return { ...req, boxName: box?.name ?? null };
  }

  /**
   * You said yes. With the box scope the app gets its box (the one it had
   * before, or a new one); its key and your name/email (if it asked) are
   * sealed to the app's own key, so the server only relays them. An app that
   * didn't send a key only gets a name/email if you pass `claims` yourself.
   */
  async approveSignIn(id: string, options: { claims?: { name?: string; email?: string }; appKey?: string | null; box?: string } = {}): Promise<string> {
    const req = await this.signInRequest(id);
    if (options.appKey && options.appKey !== req.appKey) {
      throw new CardboardError(
        "app_key_swapped",
        0,
        "The app's key changed on its way here, so Cardboard didn't hand anything over.",
        "Something between the app and your Cardboard (possibly the server) tampered with the sign-in. Go back to the app and try again.",
      );
    }
    let boxId: string | null = null;
    const sealed: { v: 1; box?: ReturnType<typeof bundle>; profile?: { name?: string; email?: string } } = { v: 1 };
    if (req.scopes.includes("box")) {
      // `box` picks one (e.g. a box shared with you, so the app shares it too: read-only if that's how it
      // was shared); otherwise the app's own.
      let box = options.box ? await this.boxById(options.box) : req.box ? await this.boxById(req.box) : undefined;
      if (options.box && !box) throw fail("no_such_box", 404, "You don't have that box.");
      if (!box) {
        box = await this.createBox(await this.freeName(toName(req.client.name) || "connected-app"));
        await this.setBoxProfile(box.name, { title: req.client.name.slice(0, 60), ...(req.client.uri ? { url: req.client.uri } : {}) });
      }
      boxId = box.id;
      sealed.box = bundle(box.id, box.keys.root, this.keys.names.root);
    }
    let bundleText: string | undefined;
    let claims: { name?: string; email?: string } | undefined;
    if (req.appKey) {
      if (req.scopes.includes("profile") || req.scopes.includes("email")) {
        const { profile } = await this.me();
        sealed.profile = {
          ...(req.scopes.includes("profile") && profile.name ? { name: profile.name } : {}),
          ...(req.scopes.includes("email") && profile.email ? { email: profile.email } : {}),
        };
      }
      bundleText = toB64u(await sealTo(fromB64u(req.appKey), JSON.stringify(sealed), ctx.signIn(req.client.id)));
    } else {
      claims = options.claims;
    }
    const res = await this.rpc.call<{ redirect: string }>("oauth.decide", { id, approve: true, box: boxId, bundle: bundleText, claims });
    return res.redirect;
  }

  async denySignIn(id: string): Promise<string> {
    return (await this.rpc.call<{ redirect: string }>("oauth.decide", { id, approve: false })).redirect;
  }
}

function defaultDeviceName(kind: DeviceKind): string {
  return kind === "browser" ? "a browser" : kind === "cli" ? "a computer (CLI)" : "a device";
}

