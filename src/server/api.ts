import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { CardboardError, fail } from "../shared/errors.ts";
import { parseDuration } from "../shared/duration.ts";
import type { Audit, LogDetail, Outcome } from "./audit.ts";
import { blastRadius } from "./blast.ts";
import { sameBytes, sha256 } from "./crypto.ts";
import { getMeta, setMeta, type DB } from "./db.ts";
import type { Berth, Dock, Docks } from "./docks.ts";
import type { Hub } from "./hub.ts";
import { insights, type BoxFacts, type ServerInfo } from "./insights.ts";
import { inventory, type Inventory } from "./labels.ts";
import { runShake, type ShakeReport } from "./shake.ts";
import { tapeView, type Tape, type Tapes } from "./tapes.ts";
import { isPlainObject, validateKey, type Box, type Vault } from "./vault.ts";

export interface ApiRequest {
  op: string;
  admin: boolean;
  authorization?: string | undefined;
  origin?: string | undefined;
  /** The Host header, used to recognise Cardboard's own dashboard. */
  host?: string | undefined;
  ip: string;
  body: unknown;
  /** Set by the shake test so its probing doesn't fill your activity log. */
  internal?: boolean;
}

export interface ApiResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export interface Context {
  db: DB;
  vault: Vault;
  tapes: Tapes;
  audit: Audit;
  hub: Hub;
  docks: Docks;
  info: ServerInfo;
}

export interface AppAuth {
  box: Box;
  tape: Tape;
  actor: string;
  cors: Record<string, string>;
}

type Body = Record<string, unknown>;
type AppOp = (auth: AppAuth, body: Body, req: ApiRequest) => unknown;
type AdminOp = (body: Body, req: ApiRequest) => unknown;

const DAY = 24 * 60 * 60 * 1000;
const MAX_BATCH = 500;
const KEEP_BACKUPS = 10;

/** Slows down anyone guessing tapes: 30 failed attempts per 5 minutes per address. */
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
  lastShake: ShakeReport | null = null;
  private readonly inventories = new Map<string, Inventory>();
  private readonly appOps: Record<string, AppOp>;
  private readonly adminOps: Record<string, AdminOp>;

  constructor(ctx: Context) {
    this.ctx = ctx;
    ctx.vault.onChange(({ boxId, ...change }) => {
      this.forgetInventory(boxId);
      ctx.hub.publish(`box:${boxId}`, change);
    });
    ctx.docks.onParcel(({ dockId, parcel }) => ctx.hub.publish(`dock:${dockId}`, parcel));
    this.appOps = this.buildAppOps();
    this.adminOps = this.buildAdminOps();
  }

  call(req: ApiRequest): ApiResponse {
    try {
      return req.admin ? this.callAdmin(req) : this.callApp(req);
    } catch (err) {
      return errorResponse(err);
    }
  }

  // ── Auth ─────────────────────────────────────────────────────────────────

  authenticateApp(req: ApiRequest): AppAuth {
    const now = this.ctx.vault.now();
    if (this.limiter.blocked(req.ip, now)) throw slowDown();
    const secret = bearer(req.authorization);
    if (!secret) {
      this.denyAuth(req, null, "anonymous", "No tape was sent.");
      throw fail(
        "no_tape",
        401,
        "No tape was sent.",
        "Send the header Authorization: Bearer <tape>. Get a tape with: cardboard connect <app>",
      );
    }
    if (secret.startsWith("cbo_") && this.isOwner(secret)) {
      throw fail(
        "owner_token_in_app",
        401,
        "That's your owner token. Apps should use their own tape, so one leaky app can't reach every box.",
        "Make one with: cardboard connect <app>",
      );
    }
    const check = this.ctx.tapes.check(secret);
    if (!check.ok) {
      if (check.tape) this.denyAuth(req, check.tape.boxId, `tape:${check.tape.id}`, check.reason);
      else this.denyAuth(req, null, "anonymous", check.reason);
      throw fail("bad_tape", 401, check.reason, check.hint);
    }
    const tape = check.tape;
    const box = this.ctx.vault.getBox(tape.boxId);
    if (!box) throw fail("bad_tape", 401, "That tape's box no longer exists.");
    const actor = `tape:${tape.id}`;
    let cors: Record<string, string> = {};
    if (req.origin) {
      if (!box.settings.origins.includes(req.origin)) {
        this.log(req, box.id, actor, "auth", "denied", { note: `${req.origin} isn't an allowed origin`, ip: req.ip });
        throw fail(
          "origin_not_allowed",
          403,
          `${req.origin} isn't allowed to use ${box.name} from a browser.`,
          `If that's your app, allow it with: cardboard allow ${box.name} ${req.origin}`,
        );
      }
      cors = { "access-control-allow-origin": req.origin, vary: "Origin" };
    }
    return { box, tape, actor, cors };
  }

  private authenticateOwner(req: ApiRequest) {
    const now = this.ctx.vault.now();
    if (this.limiter.blocked(req.ip, now)) throw slowDown();
    const secret = bearer(req.authorization);
    if (!secret || !this.isOwner(secret)) {
      this.denyAuth(req, null, "anonymous", "Wrong or missing owner token for the admin API.");
      throw fail(
        "not_owner",
        401,
        "That isn't the owner token.",
        "It was printed when Cardboard first started and saved to ~/.config/cardboard/credentials.json. Lost it? On the server, run: cardboard reset-owner",
      );
    }
    if (req.origin) {
      let originHost: string | null = null;
      try {
        originHost = new URL(req.origin).host;
      } catch {
        originHost = null;
      }
      if (!originHost || originHost !== req.host) {
        throw fail("not_dashboard", 403, "The owner API only answers Cardboard's own dashboard and CLI.");
      }
    }
  }

  private isOwner(secret: string): boolean {
    const stored = getMeta(this.ctx.db, "owner_hash");
    return Boolean(stored) && sameBytes(sha256(secret), Buffer.from(stored!, "base64"));
  }

  private denyAuth(req: ApiRequest, boxId: string | null, actor: string, note: string) {
    this.limiter.fail(req.ip, this.ctx.vault.now());
    this.log(req, boxId, actor, "auth", "denied", { note, ip: req.ip });
  }

  private log(req: ApiRequest, boxId: string | null, actor: string, action: string, outcome: Outcome, detail: LogDetail) {
    if (!req.internal) this.ctx.audit.record(boxId, actor, action, outcome, detail);
  }

  /** Browsers ask before cross-origin calls. Say yes only to origins some box allows. */
  preflightAllowed(origin: string): boolean {
    return this.ctx.vault.listBoxes().some((b) => b.settings.origins.includes(origin));
  }

  // ── App API (tapes) ──────────────────────────────────────────────────────

  private callApp(req: ApiRequest): ApiResponse {
    const auth = this.authenticateApp(req);
    const handler = this.appOps[req.op];
    try {
      if (req.op === "watch" || req.op === "dock.watch") {
        throw fail("use_stream", 400, `${req.op} streams events, so it can't be called like other operations.`, "Use watch() or dock().on() from the SDK.");
      }
      if (!handler) {
        throw fail("unknown_op", 404, `Cardboard has no "${req.op}" operation.`, `Try: ${Object.keys(this.appOps).join(", ")}.`);
      }
      return { status: 200, headers: auth.cors, body: handler(auth, asBody(req.body), req) };
    } catch (err) {
      if (err instanceof CardboardError && err.status === 403 && err.code !== "dock_pending") {
        const body = isPlainObject(req.body) ? req.body : {};
        this.log(req, auth.box.id, auth.actor, req.op, "denied", {
          note: err.reason,
          key: typeof body["key"] === "string" ? body["key"] : undefined,
          ip: req.ip,
        });
      }
      const res = errorResponse(err);
      return { ...res, headers: { ...res.headers, ...auth.cors } };
    }
  }

  /** Auth + scope check for the streaming watch endpoint (served by the HTTP layer). */
  authorizeWatch(req: ApiRequest): AppAuth & { prefix: string } {
    const auth = this.authenticateApp(req);
    try {
      requireRead(auth.tape);
      const body = asBody(req.body);
      const prefix = narrowPrefix(auth.tape, optString(body, "prefix"));
      this.log(req, auth.box.id, auth.actor, "watch", "ok", { prefix, ip: req.ip });
      return { ...auth, prefix };
    } catch (err) {
      if (err instanceof CardboardError && err.status === 403) {
        this.log(req, auth.box.id, auth.actor, "watch", "denied", { note: err.reason, ip: req.ip });
      }
      throw err;
    }
  }

  /**
   * Finds the app's berth at a dock. If it isn't allowed to do `want` yet, this
   * files a request for the owner (once) and refuses with a friendly "waiting".
   */
  private dockAccess(a: AppAuth, body: Body, want: "send" | "receive", req: ApiRequest): { dock: Dock; berth: Berth } {
    const { docks } = this.ctx;
    if (a.tape.prefix) {
      throw fail("prefix_tape_no_docks", 403, "This tape is limited to a prefix, so it can't use docks.", "Use the app's main tape for docking.");
    }
    const name = requireString(body, "dock");
    const dock = docks.find(name);
    const berth = dock ? docks.berth(dock.id, a.box.id) : undefined;
    if (dock && berth && (want === "send" ? berth.send : berth.receive)) return { dock, berth };
    const denied = () =>
      fail("dock_denied", 403, `The owner said no to ${want === "send" ? "sending" : "receiving"} on dock “${name}”.`, "Ask them to allow it in the dashboard.");
    if (berth?.denied) throw denied();
    const alreadyAsked = want === "send" ? berth?.wantSend : berth?.wantReceive;
    const result = docks.request(name, a.box.id, { [want]: true });
    if (result.berth.denied) throw denied();
    if (!alreadyAsked) this.log(req, a.box.id, a.actor, "dock.request", "ok", { name, note: want, ip: req.ip });
    throw fail(
      "dock_pending",
      403,
      `Asked to ${want} on dock “${name}”. Waiting for the owner to approve.`,
      `Approve it in the dashboard, or run: cardboard dock approve ${name} ${a.box.name}`,
    );
  }

  /** Auth + berth check for the streaming dock endpoint (served by the HTTP layer). */
  authorizeDockWatch(req: ApiRequest): AppAuth & { dock: Dock; berth: Berth } {
    const auth = this.authenticateApp(req);
    requireRead(auth.tape);
    const { dock, berth } = this.dockAccess(auth, asBody(req.body), "receive", req);
    this.log(req, auth.box.id, auth.actor, "dock.watch", "ok", { name: dock.name, ip: req.ip });
    return { ...auth, dock, berth };
  }

  private buildAppOps(): Record<string, AppOp> {
    const { vault, docks } = this.ctx;
    const ip = (req: ApiRequest) => req.ip;

    const recordWrite = (a: AppAuth, req: ApiRequest, action: string, key: string, notices: string[]) => {
      this.log(req, a.box.id, a.actor, action, "ok", { key, ip: ip(req) });
      if (notices.length > 0) {
        this.log(req, a.box.id, a.actor, "sensitive", "ok", { key, note: notices[0], ip: ip(req) });
      }
    };

    return {
      whoami: (a) => ({
        box: a.box.name,
        tape: tapeView(a.tape, "active"),
        ...vault.stats(a.box.id),
      }),

      get: (a, body, req) => {
        requireRead(a.tape);
        const key = requireKey(a.tape, body);
        const item = vault.get(a.box.id, key);
        this.log(req, a.box.id, a.actor, "read", "ok", { key, ip: ip(req) });
        return { item };
      },

      put: (a, body, req) => {
        requireWrite(a.tape);
        const key = requireKey(a.tape, body);
        const result = vault.put(a.box.id, key, body["value"], writeOptions(body), a.actor);
        recordWrite(a, req, "put", key, result.notices);
        return { key, version: result.version, notices: result.notices };
      },

      patch: (a, body, req) => {
        requireWrite(a.tape);
        const key = requireKey(a.tape, body);
        const result = vault.patch(a.box.id, key, body["value"], writeOptions(body), a.actor);
        recordWrite(a, req, "patch", key, result.notices);
        return { key, version: result.version, notices: result.notices, value: result.value };
      },

      add: (a, body, req) => {
        requireWrite(a.tape);
        const collection = requireString(body, "collection");
        if (a.tape.prefix && !`${collection}/`.startsWith(a.tape.prefix)) throw outsidePrefix(a.tape);
        const result = vault.add(a.box.id, collection, body["value"], writeOptions(body), a.actor);
        recordWrite(a, req, "add", result.key, result.notices);
        return { key: result.key, id: result.id, version: result.version, notices: result.notices };
      },

      delete: (a, body, req) => {
        requireWrite(a.tape);
        const key = requireKey(a.tape, body);
        const purge = optBoolean(body, "purge") ?? false;
        const deleted = vault.delete(a.box.id, key, { purge }, a.actor);
        this.log(req, a.box.id, a.actor, purge ? "purge" : "delete", "ok", { key, ip: ip(req) });
        return { deleted };
      },

      list: (a, body, req) => {
        requireRead(a.tape);
        const prefix = narrowPrefix(a.tape, optString(body, "prefix"));
        const result = vault.list(a.box.id, {
          prefix,
          limit: optNumber(body, "limit"),
          after: optString(body, "after"),
        });
        this.log(req, a.box.id, a.actor, "list", "ok", { prefix, count: result.items.length, ip: ip(req) });
        return result;
      },

      query: (a, body, req) => {
        requireRead(a.tape);
        const prefix = narrowPrefix(a.tape, optString(body, "prefix"));
        const where = body["where"];
        if (where !== undefined && !isPlainObject(where)) {
          throw fail("bad_query", 400, "`where` must be an object, like { done: false }.");
        }
        const sort = body["sort"];
        if (sort !== undefined && typeof sort !== "string" && !Array.isArray(sort)) {
          throw fail("bad_query", 400, '`sort` is a field name like "-stars", or a list of them.');
        }
        const result = vault.query(a.box.id, {
          prefix,
          where,
          sort: sort as string | string[] | undefined,
          limit: optNumber(body, "limit"),
          offset: optNumber(body, "offset"),
        });
        this.log(req, a.box.id, a.actor, "query", "ok", { prefix, count: result.total, ip: ip(req) });
        return result;
      },

      history: (a, body, req) => {
        requireRead(a.tape);
        const key = requireKey(a.tape, body);
        const versions = vault.history(a.box.id, key, optNumber(body, "limit"));
        this.log(req, a.box.id, a.actor, "history", "ok", { key, ip: ip(req) });
        return { versions };
      },

      undo: (a, body, req) => {
        requireWrite(a.tape);
        const key = requireKey(a.tape, body);
        const result = vault.undo(a.box.id, key, { to: optNumber(body, "to") }, a.actor);
        this.log(req, a.box.id, a.actor, "undo", "ok", { key, ip: ip(req) });
        return result;
      },

      batch: (a, body, req) => {
        requireWrite(a.tape);
        const ops = body["ops"];
        if (!Array.isArray(ops) || ops.length === 0) {
          throw fail("bad_batch", 400, "`ops` must be a non-empty list, like [{ op: 'put', key, value }].");
        }
        if (ops.length > MAX_BATCH) throw fail("bad_batch", 400, `A batch can hold at most ${MAX_BATCH} operations.`);
        const results = vault.batch(() =>
          ops.map((raw, i) => {
            const op = asBody(raw);
            switch (op["op"]) {
              case "put": {
                const key = requireKey(a.tape, op);
                const r = vault.put(a.box.id, key, op["value"], writeOptions(op), a.actor);
                return { op: "put", key, version: r.version, notices: r.notices };
              }
              case "patch": {
                const key = requireKey(a.tape, op);
                const r = vault.patch(a.box.id, key, op["value"], writeOptions(op), a.actor);
                return { op: "patch", key, version: r.version, notices: r.notices };
              }
              case "add": {
                const collection = requireString(op, "collection");
                if (a.tape.prefix && !`${collection}/`.startsWith(a.tape.prefix)) throw outsidePrefix(a.tape);
                const r = vault.add(a.box.id, collection, op["value"], writeOptions(op), a.actor);
                return { op: "add", key: r.key, id: r.id, version: r.version, notices: r.notices };
              }
              case "delete": {
                const key = requireKey(a.tape, op);
                const deleted = vault.delete(a.box.id, key, { purge: optBoolean(op, "purge") ?? false }, a.actor);
                return { op: "delete", key, deleted };
              }
              default:
                throw fail("bad_batch", 400, `Operation ${i + 1} has op "${String(op["op"])}". Use put, patch, add or delete.`);
            }
          }),
        );
        this.log(req, a.box.id, a.actor, "batch", "ok", { count: results.length, ip: ip(req) });
        return { results };
      },

      introduce: (a, body, req) => {
        requireWrite(a.tape);
        const box = vault.updateProfile(a.box.id, body);
        this.log(req, a.box.id, a.actor, "introduce", "ok", { name: box.profile.title ?? a.box.name, ip: ip(req) });
        return { profile: box.profile };
      },

      "dock.status": (a, body) => {
        const name = requireString(body, "dock");
        const dock = docks.find(name);
        const berth = dock ? docks.berth(dock.id, a.box.id) : undefined;
        // Only docked apps get counts, and only counts. Who the others are is none of their business.
        const docked = Boolean(berth?.send || berth?.receive);
        const others = dock && docked ? docks.berths(dock.id).filter((b) => b.boxId !== a.box.id) : [];
        return {
          dock: name,
          exists: Boolean(dock),
          me: dock ? (berth?.tag ?? docks.tagFor(dock.id, a.box.id)) : null,
          send: Boolean(berth?.send),
          receive: Boolean(berth?.receive),
          waiting: { send: Boolean(berth?.wantSend && !berth.send), receive: Boolean(berth?.wantReceive && !berth.receive) },
          denied: Boolean(berth?.denied),
          receivers: docked ? others.filter((b) => b.receive).length : null,
          senders: docked ? others.filter((b) => b.send).length : null,
        };
      },

      "dock.send": (a, body, req) => {
        requireWrite(a.tape);
        const { dock, berth } = this.dockAccess(a, body, "send", req);
        try {
          const result = docks.send(dock, berth, body["body"], optString(body, "to"));
          this.log(req, a.box.id, a.actor, "dock.send", "ok", { name: dock.name, count: result.recipients, ip: ip(req) });
          return { ...result, from: berth.tag };
        } catch (err) {
          if (err instanceof CardboardError && (err.status === 422 || err.status === 413)) {
            this.log(req, a.box.id, a.actor, "dock.customs", "denied", { name: dock.name, note: err.reason, ip: ip(req) });
          }
          throw err;
        }
      },

      "dock.receive": (a, body, req) => {
        requireRead(a.tape);
        const { dock, berth } = this.dockAccess(a, body, "receive", req);
        const parcels = docks.receive(dock, berth, { after: optNumber(body, "after"), limit: optNumber(body, "limit") });
        if (optBoolean(body, "ack") && parcels.length > 0) docks.ack(dock, berth, parcels.at(-1)!.seq);
        if (parcels.length > 0) {
          this.log(req, a.box.id, a.actor, "dock.receive", "ok", { name: dock.name, count: parcels.length, ip: ip(req) });
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

      // Listed so the error message for unknown ops mentions them; served by the HTTP layer.
      watch: () => undefined,
      "dock.watch": () => undefined,
    };
  }

  // ── Admin API (owner) ────────────────────────────────────────────────────

  private callAdmin(req: ApiRequest): ApiResponse {
    this.authenticateOwner(req);
    const handler = this.adminOps[req.op];
    if (!handler) {
      throw fail("unknown_op", 404, `Cardboard has no admin "${req.op}" operation.`, `Try: ${Object.keys(this.adminOps).join(", ")}.`);
    }
    return { status: 200, headers: {}, body: handler(asBody(req.body), req) };
  }

  inventoryFor(boxId: string, prefix = ""): Inventory {
    const id = `${boxId}\u0000${prefix}`;
    let inv = this.inventories.get(id);
    if (!inv) {
      inv = inventory(this.ctx.vault.items(boxId, prefix));
      this.inventories.set(id, inv);
    }
    return inv;
  }

  private forgetInventory(boxId: string) {
    for (const id of this.inventories.keys()) {
      if (id.startsWith(`${boxId}\u0000`)) this.inventories.delete(id);
    }
  }

  blastFor(tape: Tape) {
    const box = this.ctx.vault.getBox(tape.boxId);
    if (!box) throw fail("no_such_box", 404, "That tape's box no longer exists.");
    return blastRadius(tape, this.ctx.tapes.state(tape), box, this.inventoryFor(box.id, tape.prefix ?? ""), this.ctx.vault.now());
  }

  boxFacts(box: Box): BoxFacts {
    const now = this.ctx.vault.now();
    return {
      box,
      stats: this.ctx.vault.stats(box.id),
      inventory: this.inventoryFor(box.id),
      tapes: this.ctx.tapes.list(box.id).map((tape) => ({ tape, state: this.ctx.tapes.state(tape) })),
      denied24h: this.ctx.audit.deniedSince(box.id, now - DAY, { excludeAction: "dock.customs" }),
      customs24h: this.ctx.audit.deniedSince(box.id, now - DAY, { action: "dock.customs" }),
    };
  }

  computeInsights() {
    const { vault, db, info } = this.ctx;
    const now = vault.now();
    const anonymous = db
      .prepare("SELECT COUNT(*) AS n FROM log WHERE box_id IS NULL AND outcome = 'denied' AND at >= ?")
      .get(now - DAY) as { n: number };
    const lastBackup = getMeta(db, "last_backup_at");
    return insights({
      now,
      info,
      boxes: vault.listBoxes().map((b) => this.boxFacts(b)),
      anonymousDenied24h: anonymous.n,
      lastBackupAt: lastBackup ? Number(lastBackup) : null,
      shake: this.lastShake,
      pendingDocks: this.pendingDocks(),
      docks: this.ctx.docks.list().map((d) => ({ name: d.name, ...this.ctx.docks.inFlight(d.id) })),
    });
  }

  runShake(): ShakeReport {
    this.lastShake = runShake(this);
    return this.lastShake;
  }

  private boxName(boxId: string): string {
    return this.ctx.vault.getBox(boxId)?.name ?? "(shredded box)";
  }

  pendingDocks() {
    return this.ctx.docks.pending().map((p) => ({ dock: p.dock, box: this.boxName(p.boxId), send: p.send, receive: p.receive, requestedAt: p.requestedAt }));
  }

  dockSummary(dock: Dock) {
    const { docks } = this.ctx;
    return {
      name: dock.name,
      createdAt: dock.createdAt,
      settings: dock.settings,
      inFlight: docks.inFlight(dock.id),
      berths: docks.berths(dock.id).map((b) => ({
        box: this.boxName(b.boxId),
        tag: b.tag,
        send: b.send,
        receive: b.receive,
        waiting: { send: b.wantSend && !b.send, receive: b.wantReceive && !b.receive },
        denied: b.denied,
        approvedAt: b.approvedAt,
      })),
    };
  }

  private boxSummary(box: Box) {
    const facts = this.boxFacts(box);
    return {
      name: box.name,
      profile: box.profile,
      docks: this.ctx.docks.berthsOf(box.id).map((b) => ({ dock: b.dock, send: b.send, receive: b.receive, waiting: (b.wantSend && !b.send) || (b.wantReceive && !b.receive) })),
      createdAt: box.createdAt,
      settings: box.settings,
      ...facts.stats,
      summary: facts.inventory.summary,
      sensitive: facts.inventory.sensitive,
      tapes: facts.tapes.filter((t) => t.state === "active").length,
      lastActivity: this.ctx.audit.lastActivity(box.id),
    };
  }

  private buildAdminOps(): Record<string, AdminOp> {
    const { vault, tapes, audit, hub, db, info, docks } = this.ctx;
    const owner = "owner";
    const boxFrom = (body: Body, field = "name") => vault.requireBox(requireString(body, field));
    const dockFrom = (body: Body, field = "dock") => docks.require(requireString(body, field));
    const closeBerth = (dockId: string, boxId: string) => hub.closeWhere((w) => w.channel === `dock:${dockId}` && w.boxId === boxId);
    const directions = (b: { send: boolean; receive: boolean }) => (b.send && b.receive ? "send and receive" : b.send ? "send" : "receive");

    return {
      overview: () => ({
        version: info.version,
        server: { host: info.host, port: info.port, tls: info.tls, startedAt: info.startedAt },
        boxes: vault.listBoxes().map((b) => this.boxSummary(b)),
        insights: this.computeInsights(),
        shake: this.lastShake,
        pendingDocks: this.pendingDocks(),
        docks: docks.list().length,
      }),

      boxes: () => ({ boxes: vault.listBoxes().map((b) => this.boxSummary(b)) }),

      "box.create": (body) => {
        const box = vault.createBox(requireString(body, "name"));
        if (body["settings"] !== undefined) vault.updateSettings(box.id, asBody(body["settings"]));
        audit.record(box.id, owner, "box.create", "ok", { name: box.name });
        const { tape, secret } = tapes.create(box.id, tapeOptions(body, vault.now()));
        audit.record(box.id, owner, "tape.create", "ok", { label: tape.label, prefix: tape.prefix ?? undefined });
        return { box: this.boxSummary(vault.getBox(box.id)!), tape: tapeView(tape, "active"), secret };
      },

      "box.get": (body) => {
        const box = boxFrom(body);
        return {
          box: this.boxSummary(box),
          inventory: this.inventoryFor(box.id),
          tapes: tapes.list(box.id).map((t) => ({ ...tapeView(t, tapes.state(t)), blast: this.blastFor(t) })),
          log: audit.read({ boxId: box.id, limit: 30 }),
        };
      },

      "box.settings": (body) => {
        const box = boxFrom(body);
        const updated = vault.updateSettings(box.id, asBody(body["settings"]));
        audit.record(box.id, owner, "box.settings", "ok", { note: Object.keys(asBody(body["settings"])).join(", ") });
        return { box: this.boxSummary(updated) };
      },

      "box.shred": (body) => {
        const box = boxFrom(body);
        if (body["confirm"] !== box.name) {
          throw fail("confirm_shred", 400, `Shredding ${box.name} can't be undone.`, `Confirm by sending confirm: "${box.name}".`);
        }
        hub.closeWhere((w) => w.boxId === box.id);
        docks.forgetBox(box.id);
        vault.shredBox(box.id);
        this.forgetInventory(box.id);
        audit.record(null, owner, "box.shred", "ok", { name: box.name });
        const hasBackups = getMeta(db, "last_backup_at") !== undefined;
        return {
          shredded: box.name,
          note: hasBackups
            ? "Backups made before now still contain this box. Delete them too if it needs to be gone everywhere."
            : undefined,
        };
      },

      "box.rewind": (body) => {
        const box = boxFrom(body);
        const to = parseWhen(body["to"], vault.now());
        const result = vault.rewind(box.id, to, owner);
        audit.record(box.id, owner, "box.rewind", "ok", { count: result.changed, note: new Date(to).toISOString() });
        return { ...result, to };
      },

      "box.export": (body) => {
        const box = boxFrom(body);
        const data = vault.exportBox(box.id);
        audit.record(box.id, owner, "box.export", "ok", { count: data.items.length });
        return data;
      },

      "box.import": (body) => {
        const box = boxFrom(body);
        const source = isPlainObject(body["data"]) ? body["data"]["items"] : body["items"];
        const result = vault.importItems(box.id, source, owner);
        audit.record(box.id, owner, "box.import", "ok", { count: result.imported });
        return result;
      },

      "box.items": (body) => {
        const box = boxFrom(body);
        const prefix = optString(body, "prefix") ?? "";
        // Listing key names isn't logged (the dashboard does it on every visit); opening a value is.
        return vault.list(box.id, { prefix, limit: optNumber(body, "limit"), after: optString(body, "after") });
      },

      "box.item": (body) => {
        const box = boxFrom(body);
        const key = requireString(body, "key");
        validateKey(key);
        audit.record(box.id, owner, "box.read", "ok", { key });
        return { item: vault.get(box.id, key), history: vault.history(box.id, key, 20) };
      },

      "tape.create": (body) => {
        const box = boxFrom(body, "box");
        const { tape, secret } = tapes.create(box.id, tapeOptions(body, vault.now()));
        audit.record(box.id, owner, "tape.create", "ok", { label: tape.label, prefix: tape.prefix ?? undefined });
        return { tape: tapeView(tape, "active"), secret, blast: this.blastFor(tape) };
      },

      "tape.revoke": (body) => {
        const tape = tapes.revoke(requireString(body, "id"));
        hub.closeWhere((w) => w.tapeId === tape.id);
        audit.record(tape.boxId, owner, "tape.revoke", "ok", { label: tape.label });
        return { tape: tapeView(tape, tapes.state(tape)) };
      },

      "tape.blast": (body) => this.blastFor(tapes.require(requireString(body, "id"))),

      log: (body) => {
        const name = optString(body, "box");
        const boxId = name ? vault.requireBox(name).id : undefined;
        return { entries: audit.read({ boxId, limit: optNumber(body, "limit"), before: optNumber(body, "before") }) };
      },

      insights: () => ({ insights: this.computeInsights() }),

      shake: () => this.runShake(),

      search: (body) => {
        const q = requireString(body, "q").trim().toLowerCase();
        if (q.length < 2) throw fail("bad_search", 400, "Search for at least 2 characters.");
        const results: Array<{ box: string; key: string; snippet: string | null }> = [];
        for (const box of vault.listBoxes()) {
          for (const item of vault.items(box.id)) {
            if (results.length >= 50) break;
            const json = JSON.stringify(item.value);
            const at = json.toLowerCase().indexOf(q);
            if (at >= 0 || item.key.toLowerCase().includes(q)) {
              results.push({
                box: box.name,
                key: item.key,
                snippet: at >= 0 ? json.slice(Math.max(0, at - 40), at + q.length + 40) : null,
              });
            }
          }
        }
        audit.record(null, owner, "search", "ok", { note: q, count: results.length });
        return { results };
      },

      "box.profile": (body) => {
        const box = boxFrom(body);
        const updated = vault.updateProfile(box.id, asBody(body["profile"]));
        return { box: this.boxSummary(updated) };
      },

      docks: () => ({ docks: docks.list().map((d) => this.dockSummary(d)), pending: this.pendingDocks() }),

      "dock.create": (body) => {
        const dock = docks.create(requireString(body, "name"));
        if (body["settings"] !== undefined) docks.updateSettings(dock.id, asBody(body["settings"]));
        const send = optStringList(body, "send");
        const receive = optStringList(body, "receive");
        for (const name of new Set([...send, ...receive])) {
          const box = vault.requireBox(name);
          const berth = docks.grant(dock.id, box.id, { send: send.includes(name), receive: receive.includes(name) })!;
          audit.record(box.id, owner, "dock.grant", "ok", { name: dock.name, note: directions(berth) });
        }
        audit.record(null, owner, "dock.create", "ok", { name: dock.name });
        return { dock: this.dockSummary(docks.require(dock.name)) };
      },

      "dock.grant": (body) => {
        const dock = dockFrom(body);
        const box = boxFrom(body, "box");
        const berth = docks.grant(dock.id, box.id, { send: optBoolean(body, "send"), receive: optBoolean(body, "receive") });
        if (!berth) closeBerth(dock.id, box.id);
        audit.record(box.id, owner, berth ? "dock.grant" : "dock.remove", "ok", { name: dock.name, note: berth ? directions(berth) : undefined });
        return { dock: this.dockSummary(dock) };
      },

      "dock.approve": (body) => {
        const dock = dockFrom(body);
        const box = boxFrom(body, "box");
        const berth = docks.approve(dock.id, box.id);
        audit.record(box.id, owner, "dock.approve", "ok", { name: dock.name, note: directions(berth) });
        return { dock: this.dockSummary(dock) };
      },

      "dock.deny": (body) => {
        const dock = dockFrom(body);
        const box = boxFrom(body, "box");
        docks.deny(dock.id, box.id);
        closeBerth(dock.id, box.id);
        audit.record(box.id, owner, "dock.deny", "ok", { name: dock.name });
        return { dock: this.dockSummary(dock) };
      },

      "dock.remove": (body) => {
        const dock = dockFrom(body);
        const box = boxFrom(body, "box");
        const removed = docks.remove(dock.id, box.id);
        closeBerth(dock.id, box.id);
        if (removed) audit.record(box.id, owner, "dock.remove", "ok", { name: dock.name });
        return { removed, dock: this.dockSummary(dock) };
      },

      "dock.settings": (body) => {
        const dock = dockFrom(body);
        docks.updateSettings(dock.id, asBody(body["settings"]));
        audit.record(null, owner, "dock.settings", "ok", { name: dock.name, note: Object.keys(asBody(body["settings"])).join(", ") });
        return { dock: this.dockSummary(docks.require(dock.name)) };
      },

      "dock.peek": (body) => {
        const dock = dockFrom(body);
        audit.record(null, owner, "dock.peek", "ok", { name: dock.name });
        return {
          parcels: docks.peek(dock.id).map(({ senderBoxId, ...parcel }) => ({ ...parcel, sender: this.boxName(senderBoxId) })),
        };
      },

      "dock.shred": (body) => {
        const dock = dockFrom(body);
        if (body["confirm"] !== dock.name) {
          throw fail("confirm_shred", 400, `Shredding the dock ${dock.name} can't be undone.`, `Confirm by sending confirm: "${dock.name}".`);
        }
        hub.closeWhere((w) => w.channel === `dock:${dock.id}`);
        docks.shred(dock.id);
        audit.record(null, owner, "dock.shred", "ok", { name: dock.name });
        return { shredded: dock.name };
      },

      backup: () => {
        const dir = join(info.dataDir, "backups");
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const stamp = new Date(vault.now()).toISOString().replace(/[:.]/g, "-");
        const file = join(dir, `cardboard-${stamp}.db`);
        db.prepare("VACUUM INTO ?").run(file);
        setMeta(db, "last_backup_at", String(vault.now()));
        const old = readdirSync(dir)
          .filter((f) => /^cardboard-.*\.db$/.test(f))
          .sort()
          .slice(0, -KEEP_BACKUPS);
        for (const f of old) rmSync(join(dir, f));
        audit.record(null, owner, "backup", "ok", { note: file });
        return { file, bytes: statSync(file).size, kept: KEEP_BACKUPS };
      },
    };
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

export function errorResponse(err: unknown): ApiResponse {
  if (err instanceof CardboardError) {
    return { status: err.status, headers: {}, body: { error: err.toJSON() } };
  }
  console.error("[cardboard] unexpected error:", err);
  return {
    status: 500,
    headers: {},
    body: { error: { code: "internal", message: "Something went wrong inside Cardboard. The server log has details." } },
  };
}

function slowDown() {
  return fail("slow_down", 429, "Too many failed attempts from your address.", "Wait a few minutes and try again.");
}

function bearer(header: string | undefined): string | null {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header ?? "");
  return match ? match[1]! : null;
}

function asBody(body: unknown): Body {
  if (body === undefined || body === null) return {};
  if (!isPlainObject(body)) throw fail("bad_request", 400, "Send a JSON object as the request body.");
  return body;
}

function requireString(body: Body, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || value.length === 0) {
    throw fail("bad_request", 400, `\`${field}\` is required and must be a string.`);
  }
  return value;
}

function optString(body: Body, field: string): string | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw fail("bad_request", 400, `\`${field}\` must be a string.`);
  return value;
}

function optNumber(body: Body, field: string): number | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw fail("bad_request", 400, `\`${field}\` must be a number.`);
  return value;
}

function optStringList(body: Body, field: string): string[] {
  const value = body[field];
  if (value === undefined || value === null) return [];
  const list = typeof value === "string" ? value.split(",") : value;
  if (!Array.isArray(list) || list.some((v) => typeof v !== "string")) {
    throw fail("bad_request", 400, `\`${field}\` must be a list of box names.`);
  }
  return list.map((v) => (v as string).trim()).filter(Boolean);
}

function optBoolean(body: Body, field: string): boolean | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw fail("bad_request", 400, `\`${field}\` must be true or false.`);
  return value;
}

function writeOptions(body: Body) {
  const ttl = body["ttl"];
  return {
    ttlMs: ttl === undefined ? undefined : ttl === null || ttl === "never" ? null : parseDuration(ttl as string | number),
    ifVersion: optNumber(body, "ifVersion"),
  };
}

function tapeOptions(body: Body, now: number) {
  const idle = body["idle"];
  const expires = body["expires"];
  const prefix = optString(body, "prefix");
  return {
    label: optString(body, "label"),
    read: optBoolean(body, "read"),
    write: optBoolean(body, "write"),
    prefix: prefix ?? null,
    idleMs: idle === undefined ? undefined : idle === null || idle === "never" ? null : parseDuration(idle as string),
    expiresAt: expires === undefined || expires === null ? null : now + parseDuration(expires as string),
  };
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

function requireRead(tape: Tape) {
  if (!tape.read) {
    throw fail("write_only", 403, "This tape can write but not read.", "Make a tape that can read with: cardboard tape <box>");
  }
}

function requireWrite(tape: Tape) {
  if (!tape.write) {
    throw fail("read_only", 403, "This tape is read-only.", "Make a tape that can write with: cardboard tape <box>");
  }
}

function outsidePrefix(tape: Tape) {
  return fail("outside_prefix", 403, `This tape only reaches keys starting with “${tape.prefix}”.`);
}

function requireKey(tape: Tape, body: Body): string {
  const key = body["key"];
  validateKey(key);
  if (tape.prefix && !key.startsWith(tape.prefix)) throw outsidePrefix(tape);
  return key;
}

/** Narrows a requested prefix to what the tape may see, or refuses if they don't overlap. */
export function narrowPrefix(tape: Tape, requested: string | undefined): string {
  const wanted = requested ?? "";
  if (!tape.prefix) return wanted;
  if (wanted.startsWith(tape.prefix)) return wanted;
  if (tape.prefix.startsWith(wanted)) return tape.prefix;
  throw outsidePrefix(tape);
}
