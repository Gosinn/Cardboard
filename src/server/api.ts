import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { CardboardError, fail } from "../shared/errors.ts";
import { parseDuration } from "../shared/duration.ts";
import { ctx } from "../shared/contexts.ts";
import { DEVICE_KINDS, RECOVERY_PLANS, type Account, type Accounts, type Device, type DeviceKind, type RecoveryPlan } from "./accounts.ts";
import type { Audit, LogInput, Outcome } from "./audit.ts";
import { newId, sameBytes, sha256 } from "./crypto.ts";
import { getMeta, setMeta, type DB } from "./db.ts";
import type { Berth, Dock, Docks } from "./docks.ts";
import type { Hub } from "./hub.ts";
import { hostInsights, type ServerInfo } from "./insights.ts";
import { OAuthError, type OAuth } from "./oauth.ts";
import { runShake, type ShakeReport } from "./shake.ts";
import { tapeView, type Tape, type Tapes } from "./tapes.ts";
import type { Box, Sealed, StoredItem, Vault } from "./vault.ts";
import {
  asBody,
  b64,
  bearer,
  isPlainObject,
  optBlob,
  optBoolean,
  optDuration,
  optNumber,
  optString,
  requireBlob,
  requireClientId,
  requireIndex,
  requireString,
  type Body,
} from "./wire.ts";

/**
 * Every operation, as a pure function: request in, response out (the shake
 * test calls it directly). One endpoint, POST /v1/<op>; the token you send
 * decides who you are and which operations exist for you:
 *
 *   no token  public: say hello, sign up, pair a new device, recover
 *   cbt_…     an app's tape: its own box and its docks
 *   cbd_…     one of your devices: everything in your account
 *   cbh_…     the host: invites, accounts (metadata only), backups, shake test
 *
 * Nothing here can open anything sealed: names and values come in sealed and
 * go out sealed. Ownership is checked on every id, and another account's box
 * looks exactly like no box at all.
 */

export interface ApiRequest {
  op: string;
  authorization?: string | undefined;
  origin?: string | undefined;
  /** The Host header, used to recognise Cardboard's own dashboard. */
  host?: string | undefined;
  ip: string;
  body: unknown;
  /** Set by the shake test so its probing doesn't fill the logs. */
  internal?: boolean;
}

export interface ApiResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export interface Context {
  db: DB;
  accounts: Accounts;
  vault: Vault;
  tapes: Tapes;
  audit: Audit;
  hub: Hub;
  docks: Docks;
  oauth: OAuth;
  info: ServerInfo;
}

export interface DeviceAuth {
  account: Account;
  device: Device;
  actor: string;
}

export interface AppAuth {
  account: Account;
  box: Box;
  tape: Tape;
  actor: string;
  cors: Record<string, string>;
}

/** Who may do what to one box's items. */
interface ItemScope {
  accountId: string;
  box: Box;
  actor: string;
  read: boolean;
  write: boolean;
  /** Owner devices: reads aren't logged (the dashboard reads everything to work out what you store). */
  quietReads: boolean;
}

type PublicOp = (body: Body, req: ApiRequest) => unknown;
type DeviceOp = (auth: DeviceAuth, body: Body, req: ApiRequest) => unknown;
type AppOp = (auth: AppAuth, body: Body, req: ApiRequest) => unknown;
type HostOp = (body: Body, req: ApiRequest) => unknown;
type ItemOp = (scope: ItemScope, body: Body, req: ApiRequest) => unknown;

const DAY = 24 * 60 * 60 * 1000;
const MAX_BATCH = 500;
const KEEP_BACKUPS = 10;
const MAX_NAME = 4096;
const MAX_KEY_BLOB = 512;
const MAX_LABEL = 1024;
const MAX_PROFILE = 4096;
const MAX_DETAIL = 2048;

/** Slows down anyone guessing: 30 failed attempts per 5 minutes per address. */
export class FailureLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly max: number;
  private readonly windowMs: number;

  constructor(max = 30, windowMs = 5 * 60 * 1000) {
    this.max = max;
    this.windowMs = windowMs;
  }

  private recent(ip: string, now: number): number[] {
    const list = (this.hits.get(ip) ?? []).filter((t) => t > now - this.windowMs);
    if (list.length === 0) this.hits.delete(ip);
    else this.hits.set(ip, list);
    return list;
  }

  blocked(ip: string, now: number): boolean {
    return this.recent(ip, now).length >= this.max;
  }

  fail(ip: string, now: number) {
    if (this.hits.size > 10_000) this.hits.clear();
    this.hits.set(ip, [...this.recent(ip, now), now]);
  }

  reset(ip: string) {
    this.hits.delete(ip);
  }
}

export class Api {
  readonly ctx: Context;
  readonly limiter = new FailureLimiter();
  /** New devices asking to pair, per address: 20 per 10 minutes. */
  readonly pairings = new FailureLimiter(20, 10 * 60 * 1000);
  /** New accounts, per address: 10 an hour (matters with open sign-up). */
  readonly signups = new FailureLimiter(10, 60 * 60 * 1000);
  lastShake: ShakeReport | null = null;
  private readonly publicOps: Record<string, PublicOp>;
  private readonly deviceOps: Record<string, DeviceOp>;
  private readonly appOps: Record<string, AppOp>;
  private readonly hostOps: Record<string, HostOp>;
  private readonly itemOps: Record<string, ItemOp>;

  constructor(context: Context) {
    this.ctx = context;
    context.vault.onChange(({ boxId, ...change }) => context.hub.publish(`box:${boxId}`, change));
    context.docks.onParcel(({ dockId, parcel }) => context.hub.publish(`dock:${dockId}`, parcel));
    context.oauth.onRevoke = (tapeIds) => context.hub.closeWhere((w) => w.tapeId !== null && tapeIds.includes(w.tapeId));
    context.oauth.onAlarm = (grant, message) =>
      context.audit.record({ accountId: grant.accountId, boxId: grant.boxId, actor: "system", action: "alarm", outcome: "denied", note: message });
    this.itemOps = this.buildItemOps();
    this.publicOps = this.buildPublicOps();
    this.deviceOps = this.buildDeviceOps();
    this.appOps = this.buildAppOps();
    this.hostOps = this.buildHostOps();
  }

  private now() {
    return this.ctx.vault.now();
  }

  call(req: ApiRequest): ApiResponse {
    try {
      const token = bearer(req.authorization);
      if (!token) return this.callPublic(req);
      if (token.startsWith("cbt_")) return this.callApp(req);
      if (token.startsWith("cbd_")) return this.callDevice(req, token);
      if (token.startsWith("cbh_")) return this.callHost(req, token);
      this.denyAuth(req, "That token isn't one Cardboard makes.");
      throw fail("bad_token", 401, "That token isn't one Cardboard recognises.", "Tapes start with cbt_, device tokens with cbd_, the host token with cbh_.");
    } catch (err) {
      return errorResponse(err);
    }
  }

  // ── Auth ─────────────────────────────────────────────────────────────────

  private guard(req: ApiRequest) {
    if (this.limiter.blocked(req.ip, this.now())) throw slowDown();
  }

  private denyAuth(req: ApiRequest, note: string, accountId: string | null = null, boxId: string | null = null, actor = "anonymous") {
    this.limiter.fail(req.ip, this.now());
    this.log(req, { accountId, boxId, actor, action: "auth", outcome: "denied", note });
  }

  private log(req: ApiRequest, entry: LogInput) {
    if (!req.internal) this.ctx.audit.record(entry);
  }

  /** Device, public and host calls only come from Cardboard's own dashboard (or no browser at all). */
  private sameOriginOnly(req: ApiRequest) {
    if (!req.origin) return;
    let originHost: string | null = null;
    try {
      originHost = new URL(req.origin).host;
    } catch {
      originHost = null;
    }
    if (!originHost || originHost !== req.host) {
      throw fail("not_dashboard", 403, "This part of Cardboard only answers its own dashboard and CLI.", "Apps use their tape, from an origin allowed in the box settings.");
    }
  }

  authenticateApp(req: ApiRequest): AppAuth {
    this.guard(req);
    const token = bearer(req.authorization) ?? "";
    if (/^cbt_[\w-]{86}$/.test(token)) {
      throw fail(
        "whole_tape_sent",
        401,
        "That's a whole tape, key half included. Cardboard only ever needs the first half.",
        "Use the Cardboard SDK: it splits the tape and keeps the key half on your side. Make a new tape to be safe: cardboard tape <box>",
      );
    }
    const check = this.ctx.tapes.check(token);
    if (!check.ok) {
      if (check.tape) this.denyAuth(req, check.reason, check.tape.accountId, check.tape.boxId, `tape:${check.tape.id}`);
      else this.denyAuth(req, check.reason);
      throw fail("bad_tape", 401, check.reason, check.hint);
    }
    const tape = check.tape;
    const box = this.ctx.vault.box(tape.boxId);
    const account = this.ctx.accounts.account(tape.accountId);
    if (!box || !account) throw fail("bad_tape", 401, "That tape's box no longer exists.");
    const actor = `tape:${tape.id}`;
    let cors: Record<string, string> = {};
    if (req.origin) {
      if (!box.settings.origins.includes(req.origin)) {
        this.log(req, { accountId: account.id, boxId: box.id, actor, action: "auth", outcome: "denied", note: `${req.origin} isn't an allowed origin` });
        throw fail(
          "origin_not_allowed",
          403,
          `${req.origin} isn't allowed to use this box from a browser.`,
          `If that's your app, allow it in the dashboard or with: cardboard allow <box> ${req.origin}`,
        );
      }
      cors = { "access-control-allow-origin": req.origin, vary: "Origin" };
    }
    return { account, box, tape, actor, cors };
  }

  private authenticateDevice(req: ApiRequest, token: string): DeviceAuth {
    this.guard(req);
    this.sameOriginOnly(req);
    const found = this.ctx.accounts.authenticateDevice(token);
    if (!found) {
      this.denyAuth(req, "An unknown device token.");
      throw fail("bad_device", 401, "This device isn't signed in to Cardboard any more.", "It was removed, or the account was deleted. Sign in again: cardboard pair, or use your recovery kit.");
    }
    return { ...found, actor: `device:${found.device.id}` };
  }

  private authenticateHost(req: ApiRequest, token: string) {
    this.guard(req);
    this.sameOriginOnly(req);
    const stored = getMeta(this.ctx.db, "host_hash");
    if (!stored || !sameBytes(sha256(token), Buffer.from(stored, "base64"))) {
      this.denyAuth(req, "Wrong host token.");
      throw fail("not_host", 401, "That isn't the host token.", "It was printed when Cardboard first started. Lost it? On the server, run: cardboard reset-host");
    }
  }

  /** Browsers ask before cross-origin calls. Say yes only to origins some box allows. */
  preflightAllowed(origin: string): boolean {
    const rows = this.ctx.db.prepare("SELECT settings FROM boxes WHERE settings LIKE ?").all(`%${JSON.stringify(origin).slice(1, -1)}%`) as Array<{ settings: string }>;
    return rows.some((r) => (JSON.parse(r.settings) as { origins?: string[] }).origins?.includes(origin) ?? false);
  }

  // ── Dispatch ─────────────────────────────────────────────────────────────

  private callPublic(req: ApiRequest): ApiResponse {
    this.sameOriginOnly(req);
    const handler = this.publicOps[req.op];
    if (!handler) {
      throw fail("no_token", 401, `"${req.op}" needs a token.`, "Apps send their tape (Authorization: Bearer cbt_…); the CLI and dashboard send your device's token.");
    }
    this.guard(req);
    return { status: 200, headers: {}, body: handler(asBody(req.body), req) };
  }

  private callDevice(req: ApiRequest, token: string): ApiResponse {
    const auth = this.authenticateDevice(req, token);
    const body = asBody(req.body);
    const item = this.itemOps[req.op];
    if (item) {
      const box = this.ctx.vault.ownBox(auth.account.id, requireString(body, "box", 64));
      const scope: ItemScope = { accountId: auth.account.id, box, actor: auth.actor, read: true, write: true, quietReads: true };
      return { status: 200, headers: {}, body: item(scope, body, req) };
    }
    const handler = this.deviceOps[req.op];
    if (!handler) throw unknownOp(req.op, [...Object.keys(this.deviceOps), ...Object.keys(this.itemOps)]);
    return { status: 200, headers: {}, body: handler(auth, body, req) };
  }

  private callApp(req: ApiRequest): ApiResponse {
    const auth = this.authenticateApp(req);
    try {
      if (req.op === "watch" || req.op === "dock.watch") {
        throw fail("use_stream", 400, `${req.op} streams events, so it can't be called like other operations.`, "Use watch() or dock().on() from the SDK.");
      }
      const body = asBody(req.body);
      const item = this.itemOps[req.op];
      if (item && req.op !== "rewind") {
        const scope: ItemScope = { accountId: auth.account.id, box: auth.box, actor: auth.actor, read: auth.tape.read, write: auth.tape.write, quietReads: false };
        return { status: 200, headers: auth.cors, body: item(scope, body, req) };
      }
      const handler = this.appOps[req.op];
      if (!handler) throw unknownOp(req.op, [...Object.keys(this.appOps), ...Object.keys(this.itemOps).filter((o) => o !== "rewind")]);
      return { status: 200, headers: auth.cors, body: handler(auth, body, req) };
    } catch (err) {
      if (err instanceof CardboardError && err.status === 403 && err.code !== "dock_pending") {
        this.log(req, { accountId: auth.account.id, boxId: auth.box.id, actor: auth.actor, action: req.op, outcome: "denied", note: err.reason });
      }
      const res = errorResponse(err);
      return { ...res, headers: { ...res.headers, ...auth.cors } };
    }
  }

  private callHost(req: ApiRequest, token: string): ApiResponse {
    this.authenticateHost(req, token);
    const handler = this.hostOps[req.op];
    if (!handler) throw unknownOp(req.op, Object.keys(this.hostOps));
    return { status: 200, headers: {}, body: handler(asBody(req.body), req) };
  }

  /** Auth + scope check for the streaming watch endpoint (served by the HTTP layer). */
  authorizeWatch(req: ApiRequest): AppAuth {
    const auth = this.authenticateApp(req);
    requireRead(auth.tape);
    this.log(req, { accountId: auth.account.id, boxId: auth.box.id, actor: auth.actor, action: "watch" });
    return auth;
  }

  /** Auth + berth check for the streaming dock endpoint (served by the HTTP layer). */
  authorizeDockWatch(req: ApiRequest): AppAuth & { dock: Dock; berth: Berth } {
    const auth = this.authenticateApp(req);
    requireRead(auth.tape);
    const { dock, berth } = this.dockAccess(auth, asBody(req.body), "receive", req);
    this.log(req, { accountId: auth.account.id, boxId: auth.box.id, dockId: dock.id, actor: auth.actor, action: "dock.watch", ref: dockRef(dock) });
    return { ...auth, dock, berth };
  }

  // ── Items (apps and your devices) ────────────────────────────────────────

  private buildItemOps(): Record<string, ItemOp> {
    const { vault } = this.ctx;
    const nameRef = (s: ItemScope, idx: Buffer, name: Uint8Array | null) =>
      name ? { sealed: name, ctx: ctx.itemName(s.box.id, b64(idx)!) } : null;
    const logged = (s: ItemScope, req: ApiRequest, action: string, extra: Partial<LogInput> = {}) =>
      this.log(req, { accountId: s.accountId, boxId: s.box.id, actor: s.actor, action, ...extra });

    const sealedItem = (body: Body): Sealed => ({
      idx: requireIndex(body),
      name: requireBlob(body, "name", MAX_NAME),
      value: requireBlob(body, "value", 64 * 1024 * 1024),
    });
    const writeOptions = (body: Body) => ({ ttlMs: optDuration(body, "ttl"), ifVersion: optNumber(body, "ifVersion") });

    return {
      get: (s, body, req) => {
        requireRead(s);
        const idx = requireIndex(body);
        const item = vault.get(s.box.id, idx);
        if (!s.quietReads) logged(s, req, "read", { ref: item ? nameRef(s, idx, item.name) : null });
        return { item: item ? wireItem(item) : null };
      },

      put: (s, body, req) => {
        requireWrite(s);
        const item = sealedItem(body);
        const result = vault.put(s.box.id, item, writeOptions(body), s.actor);
        logged(s, req, "put", { ref: nameRef(s, item.idx, item.name), detail: optBlob(body, "detail", MAX_DETAIL) ?? null });
        return result;
      },

      delete: (s, body, req) => {
        requireWrite(s);
        const idx = requireIndex(body);
        const purge = optBoolean(body, "purge") ?? false;
        const result = vault.delete(s.box.id, idx, { purge }, s.actor);
        logged(s, req, purge ? "purge" : "delete", { ref: nameRef(s, idx, result.name) });
        return { deleted: result.deleted };
      },

      list: (s, body, req) => {
        requireRead(s);
        const after = optString(body, "after", 64);
        const result = vault.list(s.box.id, {
          after: after ? requireIndex(body, "after") : undefined,
          limit: optNumber(body, "limit"),
          values: optBoolean(body, "values") ?? false,
        });
        if (!s.quietReads && !after) logged(s, req, optBoolean(body, "values") ? "query" : "list", { count: result.items.length });
        return { items: result.items.map((i) => wireItem(i, optBoolean(body, "values") ?? false)), next: result.next };
      },

      history: (s, body, req) => {
        requireRead(s);
        const idx = requireIndex(body);
        const versions = vault.history(s.box.id, idx, optNumber(body, "limit"));
        if (!s.quietReads) logged(s, req, "history", { ref: nameRef(s, idx, versions[0]?.name ?? null) });
        return {
          versions: versions.map((v) => ({ version: v.version, at: v.at, deleted: v.deleted, name: b64(v.name), value: b64(v.value), size: v.size, actor: v.actor })),
        };
      },

      undo: (s, body, req) => {
        requireWrite(s);
        const idx = requireIndex(body);
        const result = vault.undo(s.box.id, idx, { to: optNumber(body, "to") }, s.actor);
        logged(s, req, "undo", { ref: nameRef(s, idx, result.name) });
        return { version: result.version, restored: result.restored, deleted: result.deleted };
      },

      batch: (s, body, req) => {
        requireWrite(s);
        const ops = body["ops"];
        if (!Array.isArray(ops) || ops.length === 0) throw fail("bad_batch", 400, "`ops` must be a non-empty list, like [{ op: 'put', idx, name, value }].");
        if (ops.length > MAX_BATCH) throw fail("bad_batch", 400, `A batch can hold at most ${MAX_BATCH} operations.`);
        const results = vault.batch(() =>
          ops.map((raw, i) => {
            const op = asBody(raw);
            switch (op["op"]) {
              case "put": {
                const item = sealedItem(op);
                return { op: "put", idx: b64(item.idx), ...vault.put(s.box.id, item, writeOptions(op), s.actor) };
              }
              case "delete": {
                const idx = requireIndex(op);
                return { op: "delete", idx: b64(idx), deleted: vault.delete(s.box.id, idx, { purge: optBoolean(op, "purge") ?? false }, s.actor).deleted };
              }
              default:
                throw fail("bad_batch", 400, `Operation ${i + 1} has op "${String(op["op"])}". Use put or delete.`);
            }
          }),
        );
        logged(s, req, "batch", { count: results.length, detail: optBlob(body, "detail", MAX_DETAIL) ?? null });
        return { results };
      },

      rewind: (s, body, req) => {
        requireWrite(s);
        const to = parseWhen(body["to"], this.now());
        const result = vault.rewind(s.box.id, to, s.actor);
        logged(s, req, "box.rewind", { count: result.changed, note: new Date(to).toISOString() });
        return { ...result, to };
      },
    };
  }

  // ── Public ───────────────────────────────────────────────────────────────

  private buildPublicOps(): Record<string, PublicOp> {
    const { accounts, info } = this.ctx;
    const newDevice = (raw: unknown): { tokenHash: Buffer; kind: DeviceKind; envelope?: Buffer; label?: Buffer | null } => {
      const d = asBody(raw);
      const kind = optString(d, "kind") ?? "other";
      if (!(DEVICE_KINDS as readonly string[]).includes(kind)) throw fail("bad_request", 400, `\`device.kind\` is one of ${DEVICE_KINDS.join(", ")}.`);
      return {
        tokenHash: requireBlob(d, "tokenHash", 32, 32),
        kind: kind as DeviceKind,
        envelope: optBlob(d, "envelope", MAX_KEY_BLOB),
        label: optBlob(d, "label", MAX_LABEL) ?? null,
      };
    };

    return {
      hello: () => ({ name: "cardboard", version: info.version, signup: info.signup, issuer: info.publicUrl, shake: this.lastShake }),

      signup: (body, req) => {
        if (this.signups.blocked(req.ip, this.now())) throw slowDown();
        const recovery = asBody(body["recovery"]);
        const plan = requirePlan(recovery);
        const copy = plan === "kit" || plan === "friends" ? { lookup: requireBlob(recovery, "lookup", 32, 32), envelope: requireBlob(recovery, "envelope", MAX_KEY_BLOB) } : undefined;
        try {
          const { account, device } = accounts.signup({
            invite: optString(body, "invite", 100),
            openSignup: info.signup === "open",
            device: newDevice(body["device"]),
            plan,
            kit: plan === "kit" ? copy : undefined,
            friends: plan === "friends" ? copy : undefined,
            internal: req.internal,
          });
          this.signups.fail(req.ip, this.now());
          this.log(req, { accountId: null, actor: "anonymous", action: "account.create", note: account.id });
          this.log(req, { accountId: account.id, actor: `device:${device.id}`, action: "account.create" });
          return { account: { id: account.id }, device: { id: device.id } };
        } catch (err) {
          if (err instanceof CardboardError && err.code.startsWith("invite")) this.denyAuth(req, err.reason);
          throw err;
        }
      },

      "pair.request": (body, req) => {
        if (this.pairings.blocked(req.ip, this.now())) throw slowDown();
        this.pairings.fail(req.ip, this.now());
        const kind = optString(body, "kind") ?? "other";
        if (!(DEVICE_KINDS as readonly string[]).includes(kind)) throw fail("bad_request", 400, `\`kind\` is one of ${DEVICE_KINDS.join(", ")}.`);
        return accounts.requestPairing({
          id: requireBlob(body, "id", 32, 32),
          publicKey: requireBlob(body, "publicKey", 65, 65),
          tokenHash: requireBlob(body, "tokenHash", 32, 32),
          mac: requireBlob(body, "mac", 32, 32),
          kind: kind as DeviceKind,
        });
      },

      "pair.poll": (body, req) => {
        try {
          const result = accounts.pollPairing(requireBlob(body, "id", 32, 32), requireString(body, "token", 100));
          if (result.status === "waiting") return result;
          return { status: "approved", accountId: result.accountId, deviceId: result.deviceId, envelope: b64(result.envelope) };
        } catch (err) {
          this.limiter.fail(req.ip, this.now());
          throw err;
        }
      },

      recover: (body, req) => {
        const kind = requireString(body, "kind", 10);
        if (kind !== "kit" && kind !== "friends") throw fail("bad_request", 400, '`kind` is "kit" or "friends".');
        const found = accounts.recover(kind, requireBlob(body, "secret", 32, 32), newDevice(body["device"]));
        if (!found) {
          this.denyAuth(req, `A ${kind === "kit" ? "recovery kit" : "friends' recovery"} code that doesn't match any account.`);
          throw fail(
            "bad_recovery",
            401,
            kind === "kit" ? "That recovery kit doesn't open any account here." : "Those pieces don't open any account here.",
            kind === "kit" ? "Check the code, and that it's your newest kit: making a new kit retires the old one." : "Check the pieces are from your newest set.",
          );
        }
        this.limiter.reset(req.ip);
        this.log(req, {
          accountId: found.account.id,
          actor: `device:${found.device.id}`,
          action: "recovered",
          outcome: "denied",
          note: kind === "kit" ? "Your recovery kit was used to sign in a new device" : "Your friends' pieces were used to sign in a new device",
        });
        return { accountId: found.account.id, deviceId: found.device.id, envelope: b64(found.envelope) };
      },

      // A sign-in can always be turned down, even from a browser with no Cardboard device.
      "oauth.cancel": (body) => {
        const id = requireString(body, "id", 64);
        const request = this.ctx.oauth.pendingRequest(id);
        this.ctx.oauth.finishRequest(id);
        const error = optString(body, "error") === "login_required" ? "login_required" : "access_denied";
        return {
          redirect: this.ctx.oauth.redirectWith(request.redirectUri, {
            error,
            error_description: error === "login_required" ? "This browser isn't signed in to Cardboard." : "You said no.",
            state: request.state,
          }),
        };
      },
    };
  }

  // ── Your devices ─────────────────────────────────────────────────────────

  /** Facts about one of your boxes that the server knows without opening anything. */
  boxSummary(box: Box) {
    const { vault, tapes, audit, docks } = this.ctx;
    const since = this.now() - DAY;
    return {
      id: box.id,
      idx: b64(box.idx),
      name: b64(box.name),
      key: b64(box.key),
      profile: b64(box.profile),
      settings: box.settings,
      createdAt: box.createdAt,
      ...vault.stats(box.id),
      tapes: tapes.list(box.id).map((t) => tapeView(t, tapes.state(t))),
      lastActivity: audit.lastActivity(box.id),
      denied24h: audit.deniedSince(box.id, since, { excludeAction: "dock.customs" }),
      customs24h: audit.deniedSince(box.id, since, { action: "dock.customs" }),
      docks: docks.berthsOf(box.id).map((b) => ({ dock: b.dockId, send: b.send, receive: b.receive, waiting: (b.wantSend && !b.send) || (b.wantReceive && !b.receive) })),
    };
  }

  dockSummary(dock: Dock) {
    const { docks } = this.ctx;
    return {
      id: dock.id,
      idx: b64(dock.idx),
      name: b64(dock.name),
      key: b64(dock.key),
      settings: dock.settings,
      createdAt: dock.createdAt,
      inFlight: docks.inFlight(dock.id),
      berths: docks.berths(dock.id).map((b) => ({
        box: b.boxId,
        tag: b.tag,
        send: b.send,
        receive: b.receive,
        waiting: { send: b.wantSend && !b.send, receive: b.wantReceive && !b.receive },
        denied: b.denied,
        approvedAt: b.approvedAt,
        requestedAt: b.requestedAt,
        ask: b64(b.ask),
        keyed: b.key !== null,
      })),
    };
  }

  private buildDeviceOps(): Record<string, DeviceOp> {
    const { accounts, vault, tapes, audit, hub, docks, oauth, info } = this.ctx;
    const record = (a: DeviceAuth, req: ApiRequest, action: string, extra: Partial<LogInput> = {}) =>
      this.log(req, { accountId: a.account.id, actor: a.actor, action, ...extra });
    const boxFrom = (a: DeviceAuth, body: Body, field = "box") => vault.ownBox(a.account.id, requireString(body, field, 64));
    const dockFrom = (a: DeviceAuth, body: Body, field = "dock") => docks.own(a.account.id, requireString(body, field, 64));
    const closeBerth = (dockId: string, boxId: string) => hub.closeWhere((w) => w.channel === `dock:${dockId}` && w.boxId === boxId);
    const shred = (box: Box) => {
      hub.closeWhere((w) => w.boxId === box.id);
      vault.shredBox(box.id);
    };

    return {
      me: (a) => {
        const since = this.now() - 7 * DAY;
        return {
          account: {
            id: a.account.id,
            createdAt: a.account.createdAt,
            recovery: a.account.recovery,
            recoveryReady: accounts.hasRecovery(a.account.id) === a.account.recovery || a.account.recovery === "device" || a.account.recovery === "none",
            profile: b64(a.account.profile),
            quota: { used: vault.accountBytes(a.account.id), limit: vault.accountQuota(a.account.id) },
          },
          device: { id: a.device.id, kind: a.device.kind },
          envelope: b64(a.device.envelope),
          devices: accounts.devices(a.account.id).map((d) => ({
            id: d.id,
            kind: d.kind,
            label: b64(d.label),
            createdAt: d.createdAt,
            lastSeenAt: d.lastSeenAt,
            current: d.id === a.device.id,
          })),
          alarms: audit.alarmsSince(a.account.id, since),
          server: { version: info.version, issuer: info.publicUrl, signup: info.signup, shake: this.lastShake ? { ok: this.lastShake.ok, summary: this.lastShake.summary, at: this.lastShake.at } : null },
        };
      },

      "device.envelope": (a, body) => {
        accounts.setEnvelope(a.device.id, requireBlob(body, "envelope", MAX_KEY_BLOB));
        return { ok: true };
      },

      "device.label": (a, body) => {
        accounts.setDeviceLabel(a.account.id, optString(body, "id", 64) ?? a.device.id, optBlob(body, "label", MAX_LABEL) ?? null);
        return { ok: true };
      },

      "device.remove": (a, body, req) => {
        const removed = accounts.removeDevice(a.account.id, requireString(body, "id", 64));
        record(a, req, "device.remove", { ref: removed.label ? { sealed: removed.label, ctx: ctx.deviceLabel } : null });
        return { removed: removed.id, self: removed.id === a.device.id };
      },

      "pair.view": (a, body, req) => {
        const pending = this.countMisses(req, () => accounts.pairing(requireBlob(body, "id", 32, 32)));
        return { publicKey: b64(pending.publicKey), tokenHash: b64(pending.tokenHash), mac: b64(pending.mac), kind: pending.kind, createdAt: pending.createdAt };
      },

      "pair.approve": (a, body, req) => {
        const label = optBlob(body, "label", MAX_LABEL) ?? null;
        const device = this.countMisses(req, () => accounts.approvePairing(a.account.id, requireBlob(body, "id", 32, 32), requireBlob(body, "envelope", MAX_KEY_BLOB), label));
        record(a, req, "device.add", { ref: label ? { sealed: label, ctx: ctx.deviceLabel } : null, note: device.kind });
        return { device: { id: device.id, kind: device.kind } };
      },

      "recovery.set": (a, body, req) => {
        const plan = requirePlan(body);
        const copy = plan === "kit" || plan === "friends" ? { lookup: requireBlob(body, "lookup", 32, 32), envelope: requireBlob(body, "envelope", MAX_KEY_BLOB) } : undefined;
        accounts.setRecovery(a.account.id, plan, { kit: plan === "kit" ? copy : undefined, friends: plan === "friends" ? copy : undefined });
        record(a, req, "recovery.set", { note: plan });
        return { recovery: plan };
      },

      "profile.set": (a, body, req) => {
        accounts.setProfile(a.account.id, optBlob(body, "profile", MAX_PROFILE) ?? null);
        record(a, req, "profile.set");
        return { ok: true };
      },

      "account.delete": (a, body, req) => {
        if (body["confirm"] !== a.account.id) {
          throw fail("confirm_delete", 400, "Deleting your account deletes everything in it, for good.", `Confirm by sending confirm: "${a.account.id}".`);
        }
        for (const box of vault.boxes(a.account.id)) hub.closeWhere((w) => w.boxId === box.id);
        accounts.deleteAccount(a.account.id);
        this.log(req, { accountId: null, actor: "anonymous", action: "account.delete", note: a.account.id });
        return { deleted: a.account.id };
      },

      boxes: (a) => ({
        boxes: vault.boxes(a.account.id).map((b) => this.boxSummary(b)),
        quota: { used: vault.accountBytes(a.account.id), limit: vault.accountQuota(a.account.id) },
      }),

      "box.create": (a, body, req) => {
        const box = vault.createBox(a.account.id, {
          id: requireClientId(body, "id", "box"),
          idx: requireIndex(body),
          name: requireBlob(body, "name", MAX_LABEL),
          key: requireBlob(body, "key", MAX_KEY_BLOB),
          settings: body["settings"] === undefined ? undefined : asBody(body["settings"]),
        });
        record(a, req, "box.create", { boxId: box.id, ref: { sealed: box.name, ctx: ctx.boxName(box.id) } });
        return { box: this.boxSummary(box) };
      },

      "box.settings": (a, body, req) => {
        const box = boxFrom(a, body);
        const updated = vault.updateSettings(box.id, asBody(body["settings"]));
        record(a, req, "box.settings", { boxId: box.id, note: Object.keys(asBody(body["settings"])).join(", ") });
        return { box: this.boxSummary(updated) };
      },

      "box.rename": (a, body, req) => {
        const box = boxFrom(a, body);
        vault.rename(box.id, requireIndex(body), requireBlob(body, "name", MAX_LABEL));
        record(a, req, "box.rename", { boxId: box.id });
        return { box: this.boxSummary(vault.box(box.id)!) };
      },

      "box.profile": (a, body) => {
        const box = boxFrom(a, body);
        vault.setProfile(box.id, optBlob(body, "profile", MAX_PROFILE) ?? null);
        return { box: this.boxSummary(vault.box(box.id)!) };
      },

      "box.shred": (a, body, req) => {
        const box = boxFrom(a, body);
        if (body["confirm"] !== box.id) throw fail("confirm_shred", 400, "Shredding a box can't be undone.", `Confirm by sending confirm: "${box.id}".`);
        shred(box);
        record(a, req, "box.shred");
        return { shredded: box.id };
      },

      tapes: (a, body) => ({ tapes: tapes.list(boxFrom(a, body).id).map((t) => tapeView(t, tapes.state(t))) }),

      "tape.create": (a, body, req) => {
        const box = boxFrom(a, body);
        const kind = optString(body, "kind") ?? "app";
        if (kind !== "app" && kind !== "assistant") throw fail("bad_request", 400, '`kind` is "app" or "assistant".');
        const idle = optDuration(body, "idle");
        const expires = optDuration(body, "expires");
        const label = requireBlob(body, "label", MAX_LABEL);
        const tape = tapes.create(a.account.id, box.id, {
          tokenHash: requireBlob(body, "tokenHash", 32, 32),
          bundle: requireBlob(body, "bundle", MAX_KEY_BLOB),
          label,
          kind,
          read: optBoolean(body, "read"),
          write: optBoolean(body, "write"),
          idleMs: idle,
          expiresAt: expires ? this.now() + expires : null,
        });
        record(a, req, "tape.create", { boxId: box.id, ref: { sealed: label, ctx: ctx.tapeLabel(box.id) } });
        return { tape: tapeView(tape, "active") };
      },

      "tape.revoke": (a, body, req) => {
        const tape = tapes.revoke(tapes.own(a.account.id, requireString(body, "id", 64)).id);
        hub.closeWhere((w) => w.tapeId === tape.id);
        record(a, req, "tape.revoke", { boxId: tape.boxId, ref: tape.label ? { sealed: tape.label, ctx: ctx.tapeLabel(tape.boxId) } : null });
        return { tape: tapeView(tape, tapes.state(tape)) };
      },

      log: (a, body) => {
        const box = optString(body, "box", 64);
        const entries = audit.read(a.account.id, {
          boxId: box ? vault.ownBox(a.account.id, box).id : undefined,
          limit: optNumber(body, "limit"),
          before: optNumber(body, "before"),
        });
        return { entries, actors: this.actorsFor(a.account.id, entries.map((e) => e.actor)) };
      },

      docks: (a) => ({
        docks: docks.list(a.account.id).map((d) => this.dockSummary(d)),
        pending: docks.pending(a.account.id).map(({ dock, berth }) => ({
          dock: dock.id,
          box: berth.boxId,
          send: berth.wantSend && !berth.send,
          receive: berth.wantReceive && !berth.receive,
          requestedAt: berth.requestedAt,
          ask: b64(berth.ask),
        })),
      }),

      "dock.create": (a, body, req) => {
        const dock = docks.create(a.account.id, {
          id: requireClientId(body, "id", "dock"),
          idx: requireIndex(body),
          name: requireBlob(body, "name", MAX_LABEL),
          key: requireBlob(body, "key", MAX_KEY_BLOB),
          settings: body["settings"] === undefined ? undefined : asBody(body["settings"]),
        });
        if (dock.id !== body["id"]) {
          throw fail("dock_requested", 409, "An app already asked for a dock with that name, so it has an id already.", `Seal the name and key for ${dock.id} and try again (the CLI and dashboard do this).`);
        }
        for (const raw of Array.isArray(body["berths"]) ? body["berths"] : []) {
          const b = asBody(raw);
          const box = boxFrom(a, b);
          docks.grant(dock.id, box.id, { send: optBoolean(b, "send"), receive: optBoolean(b, "receive") }, requireBlob(b, "key", MAX_KEY_BLOB));
          record(a, req, "dock.grant", { boxId: box.id, dockId: dock.id, ref: dockRef(dock), note: directions(docks.berth(dock.id, box.id)) });
        }
        record(a, req, "dock.create", { dockId: dock.id, ref: dockRef(dock) });
        return { dock: this.dockSummary(docks.get(dock.id)!) };
      },

      "dock.grant": (a, body, req) => {
        const dock = dockFrom(a, body);
        const box = boxFrom(a, body);
        const berth = docks.grant(dock.id, box.id, { send: optBoolean(body, "send"), receive: optBoolean(body, "receive") }, optBlob(body, "key", MAX_KEY_BLOB) ?? null);
        if (!berth) closeBerth(dock.id, box.id);
        record(a, req, berth ? "dock.grant" : "dock.remove", { boxId: box.id, dockId: dock.id, ref: dockRef(dock), note: berth ? directions(berth) : undefined });
        return { dock: this.dockSummary(dock) };
      },

      "dock.approve": (a, body, req) => {
        const dock = dockFrom(a, body);
        const box = boxFrom(a, body);
        if (!dock.key) throw fail("dock_unnamed", 409, "Open the dock first (give it its name and key), then approve.", "The CLI and dashboard do both in one go.");
        const berth = docks.approve(dock.id, box.id, optBlob(body, "key", MAX_KEY_BLOB) ?? null);
        record(a, req, "dock.approve", { boxId: box.id, dockId: dock.id, ref: dockRef(dock), note: directions(berth) });
        return { dock: this.dockSummary(dock) };
      },

      "dock.deny": (a, body, req) => {
        const dock = dockFrom(a, body);
        const box = boxFrom(a, body);
        docks.deny(dock.id, box.id);
        closeBerth(dock.id, box.id);
        record(a, req, "dock.deny", { boxId: box.id, dockId: dock.id, ref: dockRef(dock) });
        return { dock: this.dockSummary(dock) };
      },

      "dock.remove": (a, body, req) => {
        const dock = dockFrom(a, body);
        const box = boxFrom(a, body);
        const removed = docks.remove(dock.id, box.id);
        closeBerth(dock.id, box.id);
        if (removed) record(a, req, "dock.remove", { boxId: box.id, dockId: dock.id, ref: dockRef(dock) });
        return { removed, dock: this.dockSummary(dock) };
      },

      "dock.settings": (a, body, req) => {
        const dock = dockFrom(a, body);
        docks.updateSettings(dock.id, asBody(body["settings"]));
        record(a, req, "dock.settings", { dockId: dock.id, ref: dockRef(dock), note: Object.keys(asBody(body["settings"])).join(", ") });
        return { dock: this.dockSummary(docks.get(dock.id)!) };
      },

      "dock.rename": (a, body) => {
        const dock = dockFrom(a, body);
        docks.rename(dock.id, requireIndex(body), requireBlob(body, "name", MAX_LABEL));
        return { dock: this.dockSummary(docks.get(dock.id)!) };
      },

      "dock.peek": (a, body, req) => {
        const dock = dockFrom(a, body);
        record(a, req, "dock.peek", { dockId: dock.id, ref: dockRef(dock) });
        return { parcels: docks.peek(dock.id) };
      },

      "dock.shred": (a, body, req) => {
        const dock = dockFrom(a, body);
        if (body["confirm"] !== dock.id) throw fail("confirm_shred", 400, "Shredding a dock can't be undone.", `Confirm by sending confirm: "${dock.id}".`);
        hub.closeWhere((w) => w.channel === `dock:${dock.id}`);
        docks.shred(dock.id);
        record(a, req, "dock.shred");
        return { shredded: dock.id };
      },

      apps: (a) => ({
        issuer: oauth.discovery().issuer,
        connected: oauth.grants(a.account.id).map((g) => ({
          grant: g.id,
          client: g.clientId,
          name: g.client.name,
          site: g.sector,
          scopes: g.scopes,
          box: g.boxId,
          privateId: oauth.subjectFor(a.account.id, g.sector),
          connectedAt: g.createdAt,
          lastUsedAt: g.lastUsedAt,
          selfRegistered: g.client.registeredBy === "self",
        })),
        registered: oauth
          .clientsOf(a.account.id)
          .filter((c) => !oauth.activeGrant(a.account.id, c.id))
          .map((c) => ({ client: c.id, name: c.name, redirectUris: c.redirectUris, createdAt: c.createdAt })),
      }),

      "apps.register": (a, body, req) => {
        try {
          const { client, response } = oauth.register(
            {
              client_name: requireString(body, "name", 80),
              redirect_uris: optList(body, "redirectUris"),
              client_uri: optString(body, "clientUri", 300),
              token_endpoint_auth_method: optBoolean(body, "public") ? "none" : "client_secret_basic",
            },
            a.account.id,
          );
          record(a, req, "app.register", { note: client.name });
          return response;
        } catch (err) {
          if (err instanceof OAuthError) throw fail(err.error, 400, err.message);
          throw err;
        }
      },

      "apps.disconnect": (a, body, req) => {
        const grant = oauth.grant(requireString(body, "grant", 64));
        if (!grant || grant.accountId !== a.account.id) throw fail("no_such_app", 404, "That app isn't connected.");
        const client = oauth.client(grant.clientId);
        oauth.revokeGrant(grant.id);
        let shredded: string | null = null;
        if (optBoolean(body, "shred") && grant.boxId) {
          const box = vault.box(grant.boxId);
          if (box && box.accountId === a.account.id) {
            shred(box);
            shredded = box.id;
          }
        }
        record(a, req, "app.disconnect", { boxId: shredded ? null : grant.boxId, note: `${client?.name ?? "an app"}${shredded ? " (and shredded its box)" : ""}` });
        return { disconnected: client?.name ?? grant.clientId, shredded };
      },

      "apps.forget": (a, body, req) => {
        const client = oauth.forgetClient(a.account.id, requireString(body, "client", 64));
        record(a, req, "app.forget", { note: client.name });
        return { forgotten: client.name };
      },

      "oauth.request": (a, body) => {
        const request = oauth.pendingRequest(requireString(body, "id", 64));
        const sector = oauth.sectorOf(request.redirectUri);
        const active = oauth.activeGrant(a.account.id, request.client.id);
        const box = active?.boxId ?? oauth.previousBox(a.account.id, sector);
        return {
          client: { id: request.client.id, name: request.client.name, uri: request.client.clientUri, selfRegistered: request.client.registeredBy === "self" },
          site: sector,
          scopes: request.scopes,
          appKey: b64(request.appKey),
          prompt: request.prompt,
          returning: active ? { scopes: active.scopes, box: active.boxId } : null,
          box: box && vault.box(box)?.accountId === a.account.id ? box : null,
        };
      },

      "oauth.decide": (a, body, req) => {
        const id = requireString(body, "id", 64);
        const request = oauth.pendingRequest(id);
        if (optBoolean(body, "approve") !== true) {
          oauth.finishRequest(id);
          record(a, req, "app.deny", { note: request.client.name });
          return { redirect: oauth.redirectWith(request.redirectUri, { error: "access_denied", error_description: "You said no.", state: request.state }) };
        }
        const wantsBox = request.scopes.includes("box");
        const boxId = wantsBox ? vault.ownBox(a.account.id, requireString(body, "box", 64)).id : null;
        const bundle = optBlob(body, "bundle", 4096) ?? null;
        if (request.appKey && !bundle) throw fail("bad_request", 400, "This app takes sealed data, so send its bundle (sealed to its key).");
        if (!request.appKey && bundle) throw fail("bad_request", 400, "This app didn't send a key, so it can't take a sealed bundle.");
        let claims: { name?: string; email?: string } | null | undefined;
        if (!request.appKey) {
          const raw = body["claims"];
          if (raw !== undefined && raw !== null) {
            const c = asBody(raw);
            claims = { name: optString(c, "name", 120), email: optString(c, "email", 120) };
            if (claims.name === undefined) delete claims.name;
            if (claims.email === undefined) delete claims.email;
          } else claims = null;
        }
        const grant = oauth.consent(a.account.id, request, { boxId, claims });
        const code = oauth.issueCode(grant, request, this.now(), bundle);
        oauth.finishRequest(id);
        record(a, req, "app.connect", { boxId: grant.boxId, note: `${request.client.name}: ${grant.scopes.join(" ")}` });
        return { redirect: oauth.redirectWith(request.redirectUri, { code, state: request.state }) };
      },
    };
  }

  /** Guessing pairing codes counts as failing, like guessing tokens. */
  private countMisses<T>(req: ApiRequest, fn: () => T): T {
    try {
      return fn();
    } catch (err) {
      if (err instanceof CardboardError && err.code === "no_such_pairing") this.limiter.fail(req.ip, this.now());
      throw err;
    }
  }

  /** Enough about each actor in a log for your device to name it (labels stay sealed). */
  private actorsFor(accountId: string, actors: string[]) {
    const out: Record<string, unknown> = {};
    for (const actor of new Set(actors)) {
      if (actor.startsWith("device:")) {
        const device = this.ctx.accounts.device(actor.slice(7));
        out[actor] = device && device.accountId === accountId ? { kind: "device", deviceKind: device.kind, label: b64(device.label) } : { kind: "device", gone: true };
      } else if (actor.startsWith("tape:")) {
        const tape = this.ctx.tapes.get(actor.slice(5));
        if (!tape || tape.accountId !== accountId) {
          out[actor] = { kind: "tape", gone: true };
          continue;
        }
        const grant = tape.grantId ? this.ctx.oauth.grant(tape.grantId) : undefined;
        const client = grant ? this.ctx.oauth.client(grant.clientId) : undefined;
        out[actor] = { kind: "tape", box: tape.boxId, label: b64(tape.label), tapeKind: tape.kind, app: client?.name ?? null };
      }
    }
    return out;
  }

  // ── Apps (tapes) ─────────────────────────────────────────────────────────

  /**
   * Finds the app's berth at a dock. If it isn't allowed to do `want` yet, this
   * files a request for you (once) and refuses with a friendly "waiting".
   */
  private dockAccess(a: AppAuth, body: Body, want: "send" | "receive", req: ApiRequest): { dock: Dock; berth: Berth } {
    const { docks } = this.ctx;
    const idx = requireIndex(body, "dock");
    const dock = docks.find(a.account.id, idx);
    const berth = dock ? docks.berth(dock.id, a.box.id) : undefined;
    if (dock && berth && (want === "send" ? berth.send : berth.receive)) return { dock, berth };
    const denied = () => fail("dock_denied", 403, `You said no to this app ${want === "send" ? "sending" : "receiving"} on that dock.`, "Allow it in the dashboard if you change your mind.");
    if (berth?.denied) throw denied();
    const alreadyAsked = want === "send" ? berth?.wantSend : berth?.wantReceive;
    const result = docks.request(a.account.id, { id: newId("dock"), idx, ask: optBlob(body, "ask", MAX_LABEL) ?? null }, a.box.id, { [want]: true });
    if (result.berth.denied) throw denied();
    if (!alreadyAsked) {
      this.log(req, {
        accountId: a.account.id,
        boxId: a.box.id,
        dockId: result.dock.id,
        actor: a.actor,
        action: "dock.request",
        note: want,
        ref: result.dock.name ? dockRef(result.dock) : result.berth.ask ? { sealed: result.berth.ask, ctx: ctx.dockAsk(a.box.id, b64(idx)!) } : null,
      });
    }
    throw fail("dock_pending", 403, `Asked to ${want} on that dock. Waiting for you to approve.`, "Approve it in the dashboard, or with: cardboard docks");
  }

  private buildAppOps(): Record<string, AppOp> {
    const { vault, docks, tapes } = this.ctx;
    return {
      whoami: (a) => ({
        box: { id: a.box.id, settings: a.box.settings, profile: b64(a.box.profile) },
        tape: tapeView(a.tape, "active"),
        bundle: b64(tapes.bundle(a.tape.id)),
        ...vault.stats(a.box.id),
      }),

      introduce: (a, body, req) => {
        requireWrite(a.tape);
        vault.setProfile(a.box.id, requireBlob(body, "profile", MAX_PROFILE));
        this.log(req, { accountId: a.account.id, boxId: a.box.id, actor: a.actor, action: "introduce" });
        return { ok: true };
      },

      "dock.status": (a, body) => {
        const idx = requireIndex(body, "dock");
        const dock = docks.find(a.account.id, idx);
        const berth = dock ? docks.berth(dock.id, a.box.id) : undefined;
        // Only docked apps get counts, and only counts. Who the others are is none of their business.
        const docked = Boolean(berth?.send || berth?.receive);
        const others = dock && docked ? docks.berths(dock.id).filter((b) => b.boxId !== a.box.id) : [];
        return {
          exists: Boolean(dock?.key),
          id: docked ? dock!.id : null,
          me: dock ? (berth?.tag ?? docks.tagFor(dock.id, a.box.id)) : null,
          send: Boolean(berth?.send),
          receive: Boolean(berth?.receive),
          waiting: { send: Boolean(berth?.wantSend && !berth.send), receive: Boolean(berth?.wantReceive && !berth.receive) },
          denied: Boolean(berth?.denied),
          receivers: docked ? others.filter((b) => b.receive).length : null,
          senders: docked ? others.filter((b) => b.send).length : null,
          key: docked ? b64(berth!.key) : null,
          settings: docked ? dock!.settings : null,
        };
      },

      "dock.send": (a, body, req) => {
        requireWrite(a.tape);
        const { dock, berth } = this.dockAccess(a, body, "send", req);
        const parcel = asBody(body["parcel"]);
        const result = docks.send(dock, berth, { id: requireClientId(parcel, "id", "pcl"), body: requireBlob(parcel, "body", 64 * 1024 * 1024) }, optString(body, "to", 40));
        this.log(req, { accountId: a.account.id, boxId: a.box.id, dockId: dock.id, actor: a.actor, action: "dock.send", count: result.recipients, ref: dockRef(dock) });
        return { ...result, from: berth.tag };
      },

      "dock.receive": (a, body, req) => {
        requireRead(a.tape);
        const { dock, berth } = this.dockAccess(a, body, "receive", req);
        const parcels = docks.receive(dock, berth, { after: optNumber(body, "after"), limit: optNumber(body, "limit") });
        if (optBoolean(body, "ack") && parcels.length > 0) docks.ack(dock, berth, parcels.at(-1)!.seq);
        if (parcels.length > 0) {
          this.log(req, { accountId: a.account.id, boxId: a.box.id, dockId: dock.id, actor: a.actor, action: "dock.receive", count: parcels.length, ref: dockRef(dock) });
        }
        return { me: berth.tag, parcels };
      },

      "dock.ack": (a, body, req) => {
        requireRead(a.tape);
        const { dock, berth } = this.dockAccess(a, body, "receive", req);
        const seq = optNumber(body, "seq");
        if (seq === undefined) throw fail("bad_request", 400, "`seq` is required: the seq of the last parcel you handled.");
        return { cursor: docks.ack(dock, berth, seq) };
      },

      /** The receiving SDK's customs refused a parcel. Logged (what kind, never what), so you hear about it. */
      "dock.refuse": (a, body, req) => {
        const { dock } = this.dockAccess(a, body, "receive", req);
        const reason = optString(body, "reason", 20) ?? "unsafe";
        const kinds: Record<string, string> = { secret: "it held a secret", personal: "it held personal data", shape: "it didn't match the manifest", unsafe: "it was booby-trapped", sealed: "it didn't open with the dock key" };
        this.log(req, {
          accountId: a.account.id,
          boxId: a.box.id,
          dockId: dock.id,
          actor: a.actor,
          action: "dock.customs",
          outcome: "denied",
          note: kinds[reason] ?? kinds["unsafe"],
          ref: dockRef(dock),
        });
        return { ok: true };
      },

      // Listed so the error message for unknown ops mentions them; served by the HTTP layer.
      watch: () => undefined,
      "dock.watch": () => undefined,
    };
  }

  // ── Host ─────────────────────────────────────────────────────────────────

  computeHostInsights() {
    const { db, info, accounts } = this.ctx;
    const now = this.now();
    const anonymous = db.prepare("SELECT COUNT(*) AS n FROM log WHERE account_id IS NULL AND outcome = 'denied' AND at >= ?").get(now - DAY) as { n: number };
    const lastBackup = getMeta(db, "last_backup_at");
    return hostInsights({
      now,
      info,
      accounts: accounts.list().length,
      anonymousDenied24h: anonymous.n,
      lastBackupAt: lastBackup ? Number(lastBackup) : null,
      shake: this.lastShake,
    });
  }

  async runShake(): Promise<ShakeReport> {
    this.lastShake = await runShake(this);
    return this.lastShake;
  }

  /** What the host can know about each person: counts, sizes and dates. */
  hostAccountsView() {
    const { accounts, vault } = this.ctx;
    return {
      accounts: accounts.list().map((a) => ({
        id: a.id,
        createdAt: a.createdAt,
        lastSeenAt: a.lastSeenAt,
        recovery: a.recovery,
        devices: a.devices,
        boxes: a.boxes,
        bytes: a.bytes,
        quota: vault.accountQuota(a.id),
      })),
      note: "This is everything Cardboard knows about each person: their names, boxes and data are sealed by keys only their devices hold.",
    };
  }

  /** POST /v1/host.shake: the one operation that takes a while (it attacks the real API). */
  async hostShake(req: ApiRequest): Promise<ApiResponse> {
    try {
      const token = bearer(req.authorization);
      if (!token?.startsWith("cbh_")) throw fail("not_host", 401, "Only the host can run the shake test.", "Send the host token (cbh_…).");
      this.authenticateHost(req, token);
      return { status: 200, headers: {}, body: await this.runShake() };
    } catch (err) {
      return errorResponse(err);
    }
  }

  private buildHostOps(): Record<string, HostOp> {
    const { accounts, db, info, vault, hub, audit } = this.ctx;
    const host = (req: ApiRequest, action: string, note?: string) => this.log(req, { accountId: null, actor: "host", action, note });
    const link = (code: string) => `${info.publicUrl}/#invite=${code}`;
    return {
      "host.overview": () => ({
        version: info.version,
        server: { host: info.host, port: info.port, tls: info.tls, publicUrl: info.publicUrl, signup: info.signup, startedAt: info.startedAt, dataDir: info.dataDir, keyFile: info.keyFile },
        accounts: accounts.list().length,
        invites: accounts.invites().filter((i) => i.usedAt === null && i.expiresAt > this.now()).length,
        insights: this.computeHostInsights(),
        shake: this.lastShake,
      }),

      "host.invite": (body, req) => {
        const ttl = optDuration(body, "ttl");
        const { code, invite } = accounts.createInvite({ note: optString(body, "note", 80), ttlMs: ttl ?? undefined });
        host(req, "invite.create", invite.note ?? undefined);
        return { code, link: link(code), invite };
      },

      "host.invites": () => ({ invites: accounts.invites() }),

      "host.invite.revoke": (body, req) => {
        const revoked = accounts.revokeInvite(requireString(body, "id", 40));
        if (!revoked) throw fail("no_such_invite", 404, "There's no unused invite with that id.");
        host(req, "invite.revoke");
        return { revoked: true };
      },

      "host.accounts": () => this.hostAccountsView(),

      "host.account.delete": (body, req) => {
        const id = requireString(body, "id", 64);
        if (!accounts.account(id)) throw fail("no_such_account", 404, "There's no account with that id.");
        if (body["confirm"] !== id) throw fail("confirm_delete", 400, "Deleting an account deletes everything in it, for good.", `Confirm by sending confirm: "${id}".`);
        for (const box of vault.boxes(id)) hub.closeWhere((w) => w.boxId === box.id);
        accounts.deleteAccount(id);
        host(req, "account.delete", id);
        return { deleted: id };
      },

      "host.account.quota": (body, req) => {
        const id = requireString(body, "id", 64);
        if (!accounts.account(id)) throw fail("no_such_account", 404, "There's no account with that id.");
        const quota = body["quota"] === null || body["quota"] === "default" ? null : parseSizeOrFail(body["quota"]);
        accounts.setQuota(id, quota);
        host(req, "account.quota", id);
        return { id, quota: vault.accountQuota(id) };
      },

      "host.log": (body) => ({ entries: audit.read(null, { limit: optNumber(body, "limit"), before: optNumber(body, "before") }) }),

      // Listed so it shows up in "Try: …"; it's async, so hostShake() serves it.
      "host.shake": () => undefined,

      "host.backup": (_body, req) => {
        const dir = join(info.dataDir, "backups");
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const stamp = new Date(this.now()).toISOString().replace(/[:.]/g, "-");
        const file = join(dir, `cardboard-${stamp}.db`);
        db.prepare("VACUUM INTO ?").run(file);
        setMeta(db, "last_backup_at", String(this.now()));
        const old = readdirSync(dir)
          .filter((f) => /^cardboard-.*\.db$/.test(f))
          .sort()
          .slice(0, -KEEP_BACKUPS);
        for (const f of old) rmSync(join(dir, f));
        host(req, "backup");
        return { file, bytes: statSync(file).size, kept: KEEP_BACKUPS };
      },
    };
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

export function errorResponse(err: unknown): ApiResponse {
  if (err instanceof CardboardError) return { status: err.status, headers: {}, body: { error: err.toJSON() } };
  console.error("[cardboard] unexpected error:", err);
  return { status: 500, headers: {}, body: { error: { code: "internal", message: "Something went wrong inside Cardboard. The server log has details." } } };
}

function wireItem(item: StoredItem, withValue = true) {
  return {
    idx: b64(item.idx),
    name: b64(item.name),
    ...(withValue ? { value: b64(item.value) } : {}),
    version: item.version,
    size: item.size,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    expiresAt: item.expiresAt,
  };
}

function dockRef(dock: Dock) {
  return dock.name ? { sealed: dock.name, ctx: ctx.dockName(dock.id) } : null;
}

function directions(b: { send: boolean; receive: boolean } | undefined): string | undefined {
  if (!b) return undefined;
  return b.send && b.receive ? "send and receive" : b.send ? "send" : "receive";
}

function slowDown() {
  return fail("slow_down", 429, "Too many failed attempts from your address.", "Wait a few minutes and try again.");
}

function unknownOp(op: string, known: string[]) {
  return fail("unknown_op", 404, `Cardboard has no "${op}" operation for this token.`, `Try: ${known.filter((o) => o !== "watch" && o !== "dock.watch").join(", ")}.`);
}

function requirePlan(body: Body): RecoveryPlan {
  const plan = requireString(body, "plan", 20);
  if (!(RECOVERY_PLANS as readonly string[]).includes(plan)) throw fail("bad_request", 400, `\`plan\` is one of ${RECOVERY_PLANS.join(", ")}.`);
  return plan as RecoveryPlan;
}

function optList(body: Body, field: string): string[] {
  const value = body[field];
  if (value === undefined || value === null) return [];
  const list = typeof value === "string" ? value.split(",") : value;
  if (!Array.isArray(list) || list.some((v) => typeof v !== "string")) throw fail("bad_request", 400, `\`${field}\` must be a list of strings.`);
  return list.map((v) => (v as string).trim()).filter(Boolean);
}

function parseSizeOrFail(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.round(value);
  const match = /^\s*(\d+(?:\.\d+)?)\s*([kmgt]?b)?\s*$/i.exec(String(value));
  const units: Record<string, number> = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 };
  if (!match) throw fail("bad_size", 400, `"${String(value)}" isn't a size Cardboard understands.`, 'Try "500MB" or "5GB".');
  return Math.round(Number(match[1]) * units[(match[2] ?? "b").toLowerCase()]!);
}

/** "10m" (ago), a timestamp in ms, or an ISO date. */
function parseWhen(input: unknown, now: number): number {
  if (typeof input === "number" && Number.isFinite(input)) return input;
  if (typeof input === "string") {
    if (/^\d{4}-\d{2}-\d{2}/.test(input)) {
      const t = Date.parse(input);
      if (!Number.isNaN(t)) return t;
    }
    return now - parseDuration(input.replace(/\s*ago\s*$/i, ""));
  }
  throw fail("bad_time", 400, '`to` must be a time like "10m" (ten minutes ago), an ISO date, or a timestamp.');
}

function requireRead(who: { read: boolean }) {
  if (!who.read) throw fail("write_only", 403, "This tape can write but not read.", "Make a tape that can read with: cardboard tape <box>");
}

function requireWrite(who: { write: boolean }) {
  if (!who.write) throw fail("read_only", 403, "This tape is read-only.", "Make a tape that can write with: cardboard tape <box>");
}

export type { Outcome };
export { isPlainObject };
