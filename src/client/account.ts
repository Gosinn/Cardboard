import { CardboardError, fail } from "../shared/errors.ts";
import { ctx } from "../shared/contexts.ts";
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
import type { DeviceRecord, DeviceStore } from "./device.ts";
import { accountKeys, boxIndex, boxKeys, bundle, dockIndex, dockKeys, newClientId, newKey, type AccountKeys, type BoxKeys } from "./keys.ts";
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
  profile: { name?: string; email?: string };
  quota: { used: number; limit: number };
  device: { id: string; kind: DeviceKind };
  devices: Array<{ id: string; kind: DeviceKind; name: string; createdAt: number; lastSeenAt: number | null; current: boolean }>;
  alarms: Array<{ at: number; text: string }>;
  server: { version: string; issuer: string; signup: "invite" | "open"; shake: { ok: boolean; summary: string; at: number } | null };
}

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
  device: { id: string; kind: DeviceKind };
  envelope: string | null;
  devices: Array<{ id: string; kind: DeviceKind; label: string | null; createdAt: number; lastSeenAt: number | null; current: boolean }>;
  alarms: Array<{ at: number; text: string }>;
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
  idx: string;
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

/** Opens the account this device is signed in to, or null if it isn't. */
export async function unlock(store: DeviceStore, options: { fetch?: typeof fetch } = {}): Promise<Account | null> {
  const record = await store.load();
  if (!record) return null;
  const rpc = new Rpc(record.url, record.token, options.fetch);
  const me = await rpc.call<WireMe>("me");
  if (!me.envelope) throw new CardboardError("no_envelope", 0, "This device never finished signing in.", "Sign in again: cardboard pair, or use your recovery kit.");
  const root = await open(record.key, fromB64u(me.envelope), ctx.accountKey("device"));
  return new Account(rpc, record, await accountKeys(root), store);
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
  private boxCache: Map<string, BoxInfo> | null = null;
  private readonly inventories = new Map<string, { stamp: string; inventory: Inventory }>();

  constructor(rpc: Rpc, record: DeviceRecord, keys: AccountKeys, store: DeviceStore) {
    this.rpc = rpc;
    this.url = rpc.url;
    this.id = record.accountId;
    this.deviceId = record.deviceId;
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
      server: me.server,
    };
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
    await this.rpc.call("profile.set", { profile: toB64u(await sealJson(this.keys.meta, next, ctx.profile)) });
    return next;
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
    const root = await open(this.keys.wrap, fromB64u(raw.key), ctx.boxKey(raw.id));
    const keys = await boxKeys(root);
    const name = await openText(this.keys.meta, fromB64u(raw.name), ctx.boxName(raw.id));
    const profile = raw.profile ? await openJson<AppProfile>(keys.seal, fromB64u(raw.profile), ctx.boxProfile(raw.id)).catch(() => ({})) : {};
    const tapes = await Promise.all(raw.tapes.map((t) => this.openTape(t)));
    return { ...raw, name, profile, tapes, keys };
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

  async box(name: string): Promise<BoxInfo> {
    for (const fresh of [false, true]) {
      if (fresh) await this.boxes();
      for (const box of (await this.cache()).values()) if (box.name === name) return box;
    }
    throw fail("no_such_box", 404, `There's no box called ${name}.`, `Make it with: cardboard connect ${name}`);
  }

  async boxById(id: string): Promise<BoxInfo | undefined> {
    return (await this.cache()).get(id) ?? (await this.boxes()).find((b) => b.id === id);
  }

  async createBox(name: string, settings?: Record<string, unknown>): Promise<BoxInfo> {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) {
      throw fail("bad_box_name", 400, `"${name}" can't be used as a box name.`, "Use lowercase letters, numbers and dashes, like recipe-app.");
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
    const box = await this.box(name);
    const res = await this.rpc.call<{ box: WireBox }>("box.settings", { box: box.id, settings });
    const updated = await this.openBoxInfo(res.box);
    (await this.cache()).set(updated.id, updated);
    return updated;
  }

  async renameBox(name: string, to: string): Promise<BoxInfo> {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(to)) throw fail("bad_box_name", 400, `"${to}" can't be used as a box name.`, "Use lowercase letters, numbers and dashes.");
    const box = await this.box(name);
    const res = await this.rpc.call<{ box: WireBox }>("box.rename", { box: box.id, idx: await boxIndex(this.keys, to), name: await this.sealMeta(to, ctx.boxName(box.id)) });
    const updated = await this.openBoxInfo(res.box);
    (await this.cache()).set(updated.id, updated);
    return updated;
  }

  async setBoxProfile(name: string, profile: AppProfile) {
    const box = await this.box(name);
    await this.rpc.call("box.profile", { box: box.id, profile: toB64u(await sealJson(box.keys.seal, profile, ctx.boxProfile(box.id))) });
    this.boxCache = null;
  }

  /** Crypto-shredding: the sealed box key, every item, version, tape and log line go. */
  async shredBox(name: string) {
    const box = await this.box(name);
    await this.rpc.call("box.shred", { box: box.id, confirm: box.id });
    this.boxCache?.delete(box.id);
  }

  async rewind(name: string, to: string | number): Promise<{ changed: number; to: number }> {
    const box = await this.box(name);
    return this.rpc.call("rewind", { box: box.id, to });
  }

  async exportBox(name: string) {
    const box = await this.box(name);
    const items = await (await this.open(box)).items();
    return {
      format: "cardboard-export",
      formatVersion: 2,
      box: box.name,
      exportedAt: new Date().toISOString(),
      items: items.map(({ key, value, version, createdAt, updatedAt, expiresAt }) => ({ key, value, version, createdAt, updatedAt, expiresAt })),
    };
  }

  async importBox(name: string, data: unknown): Promise<{ imported: number; skipped: number }> {
    const list = (data && typeof data === "object" && "items" in data ? (data as { items: unknown }).items : data) as unknown;
    if (!Array.isArray(list)) throw fail("bad_import", 400, "Import expects a list of { key, value } items, like a Cardboard export.");
    const now = Date.now();
    const ops: Array<{ op: "put"; key: string; value: unknown; ttl?: number }> = [];
    let skipped = 0;
    for (const raw of list) {
      const item = raw as { key?: unknown; value?: unknown; expiresAt?: unknown };
      if (!item || typeof item.key !== "string" || item.value === undefined) throw fail("bad_import", 400, "Every imported item needs a string `key` and a `value`.");
      const expiresAt = typeof item.expiresAt === "number" ? item.expiresAt : null;
      if (expiresAt !== null && expiresAt <= now) {
        skipped++;
        continue;
      }
      ops.push({ op: "put", key: item.key, value: item.value, ...(expiresAt ? { ttl: Math.ceil((expiresAt - now) / 1000) } : {}) });
    }
    const box = await this.open(name);
    for (let i = 0; i < ops.length; i += 200) await box.batch(ops.slice(i, i + 200));
    return { imported: ops.length, skipped };
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

  // ── Smart (worked out here, never on the server) ─────────────────────────

  /** What a box holds, worked out from its opened data. Cached until the box changes. */
  async inventory(box: string | BoxInfo): Promise<Inventory> {
    const info = typeof box === "string" ? await this.box(box) : box;
    const stamp = `${info.items}:${info.bytes}:${info.lastActivity}`;
    const cached = this.inventories.get(info.id);
    if (cached?.stamp === stamp) return cached.inventory;
    const result = inventory((await (await this.open(info)).items()) as Item[]);
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
      boxes: await Promise.all(
        boxes.map(async (b) => ({
          name: b.name,
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
    for (const box of await this.boxes()) {
      for (const item of await (await this.open(box)).items()) {
        if (results.length >= 50) return results;
        const json = JSON.stringify(item.value);
        const at = json.toLowerCase().indexOf(q);
        if (at >= 0 || item.key.toLowerCase().includes(q)) {
          results.push({ box: box.name, key: item.key, snippet: at >= 0 ? json.slice(Math.max(0, at - 40), at + q.length + 40) : null });
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
      actors: Record<string, { kind: "device" | "tape"; gone?: boolean; label?: string | null; deviceKind?: DeviceKind; box?: string; tapeKind?: string; app?: string | null }>;
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
      if (kind === "item-name" || kind === "dock-ask") {
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
    const idx = await dockIndex(this.keys.names, name);
    return (await this.rawDocks()).docks.find((d) => d.idx === idx);
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
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) {
      throw fail("bad_dock_name", 400, `"${name}" can't be used as a dock name.`, "Use lowercase letters, numbers and dashes, like shopping-list.");
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
    }>("apps");
    const boxes = await this.cache();
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
  async approveSignIn(id: string, options: { claims?: { name?: string; email?: string }; appKey?: string | null } = {}): Promise<string> {
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
      let box = req.box ? await this.boxById(req.box) : undefined;
      if (!box) {
        box = await this.createBox(await this.freeName(slug(req.client.name)));
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

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || "connected-app"
  );
}
