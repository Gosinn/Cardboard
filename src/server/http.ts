import { existsSync, readFileSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { stripTypeScriptTypes } from "node:module";
import type { AddressInfo } from "node:net";
import { join, posix } from "node:path";
import { parseDuration } from "../shared/duration.ts";
import { CardboardError, fail } from "../shared/errors.ts";
import { VERSION } from "../shared/version.ts";
import { Accounts } from "./accounts.ts";
import { Api, errorResponse, type ApiRequest } from "./api.ts";
import { Audit } from "./audit.ts";
import { Docks, type Parcel } from "./docks.ts";
import { Emergency } from "./emergency.ts";
import { Hub } from "./hub.ts";
import { OAuth } from "./oauth.ts";
import { createOAuthHandler } from "./oauth-http.ts";
import type { ServerInfo } from "./insights.ts";
import { openStore, resolvePaths, type Paths } from "./setup.ts";
import type { ShakeReport } from "./shake.ts";
import { Sharing } from "./sharing.ts";
import { Tapes } from "./tapes.ts";
import { DEFAULT_ACCOUNT_QUOTA, Vault, type Change } from "./vault.ts";

export interface StartOptions {
  dataDir?: string;
  keyFile?: string;
  host?: string;
  port?: number;
  /** Paths to a certificate and private key to serve HTTPS directly. */
  tls?: { cert: string; key: string };
  /** Trust X-Forwarded-For (only when Cardboard sits behind your own reverse proxy). */
  trustProxy?: boolean;
  /** The address people and apps reach Cardboard at, e.g. https://cardboard.example.com (the OpenID issuer). */
  publicUrl?: string;
  /** Let anyone make an account (default: invite only). */
  openSignup?: boolean;
  /** Who may make invite links: "everyone" with an account (default, up to 5 waiting each) or only the "host". */
  invites?: "everyone" | "host";
  /** Storage per account unless the host sets it per person (default 1 GB). */
  accountQuotaBytes?: number;
  /** Run the shake test on startup (default true). */
  shake?: boolean;
  /** Back up the database this often (ms) into <data>/backups, keeping the newest 10. Off unless set. */
  backupEveryMs?: number | null;
  sweepEveryMs?: number;
  now?: () => number;
}

export interface RunningCardboard {
  url: string;
  /** Where apps reach Cardboard; the issuer for Sign in with Cardboard. */
  publicUrl: string;
  host: string;
  port: number;
  paths: Paths;
  firstRun: boolean;
  /** Printed once, on the very first start. */
  hostToken?: string;
  /** On the very first start: an invite link for the first account (probably yours). */
  firstInvite?: string;
  shake: ShakeReport | null;
  api: Api;
  close(): Promise<void>;
}

const MAX_BODY = 32 * 1024 * 1024;
const ROOT = join(import.meta.dirname, "..", "..");
const PUBLIC_DIR = join(ROOT, "public");
const STATIC: Record<string, string> = {
  "/index.html": "text/html; charset=utf-8",
  "/app.js": "text/javascript; charset=utf-8",
  "/device.js": "text/javascript; charset=utf-8",
  "/boot.js": "text/javascript; charset=utf-8",
  "/style.css": "text/css; charset=utf-8",
  "/favicon.svg": "image/svg+xml",
  "/manifest.webmanifest": "application/manifest+json",
  "/icon-192.png": "image/png",
  "/icon-512.png": "image/png",
  "/apple-touch-icon.png": "image/png",
};
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

export async function startServer(options: StartOptions = {}): Promise<RunningCardboard> {
  const now = options.now ?? Date.now;
  const paths = resolvePaths(options);
  const { db, keys, firstRun, hostToken } = openStore(paths, now);

  // A crash mid-shake could leave its throwaway accounts behind.
  db.prepare("DELETE FROM accounts WHERE internal = 1").run();
  db.prepare("DELETE FROM oauth_clients WHERE registered_by = 'shake'").run();

  const accounts = new Accounts(db, now);
  const vault = new Vault(db, now, options.accountQuotaBytes ?? DEFAULT_ACCOUNT_QUOTA);
  const tapes = new Tapes(db, now);
  const audit = new Audit(db, now);
  const hub = new Hub();
  const docks = new Docks(db, now, keys.subkey("dock-tags"));
  const host = options.host ?? process.env["CARDBOARD_HOST"] ?? "127.0.0.1";
  const port = options.port ?? Number(process.env["CARDBOARD_PORT"] ?? process.env["PORT"] ?? 8787);
  const info: ServerInfo = {
    version: VERSION,
    dataDir: paths.dataDir,
    dbFile: paths.dbFile,
    keyFile: paths.keyFile,
    host,
    port,
    tls: Boolean(options.tls),
    trustProxy: Boolean(options.trustProxy ?? process.env["CARDBOARD_TRUST_PROXY"] === "1"),
    publicUrl: "",
    startedAt: now(),
    signup: options.openSignup || process.env["CARDBOARD_OPEN_SIGNUP"] === "1" ? "open" : "invite",
    invites: (options.invites ?? process.env["CARDBOARD_INVITES"]) === "host" ? "host" : "everyone",
  };
  const oauth = new OAuth(db, vault, tapes, keys, () => info.publicUrl);
  const sharing = new Sharing(db, vault, now);
  const emergency = new Emergency(db, now);
  const backupEvery = options.backupEveryMs !== undefined ? options.backupEveryMs : process.env["CARDBOARD_BACKUP_EVERY"];
  const backupEveryMs = typeof backupEvery === "string" ? (backupEvery === "never" ? null : parseDuration(backupEvery)) : (backupEvery ?? null);
  const api = new Api({ db, accounts, vault, tapes, audit, hub, docks, oauth, sharing, emergency, info });
  const oauthHandler = createOAuthHandler({ oauth, api, ip: (req) => clientIp(req, info.trustProxy) });
  const statics = loadStatics();
  const modules = new Map<string, Buffer | null>();

  const handler = (req: IncomingMessage, res: ServerResponse) => {
    handle(req, res).catch((err) => {
      console.error("[cardboard] request failed:", err);
      if (!res.headersSent) sendJson(res, 500, { error: { code: "internal", message: "Something went wrong inside Cardboard." } });
      else res.destroy();
    });
  };

  async function handle(req: IncomingMessage, res: ServerResponse) {
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("x-frame-options", "DENY");
    const path = new URL(req.url ?? "/", "http://cardboard.local").pathname;
    if (await oauthHandler(req, res, path)) return;

    if (req.method === "GET" || req.method === "HEAD") {
      if (path === "/health") return sendJson(res, 200, { ok: true, version: VERSION });
      if (path.startsWith("/lib/")) {
        const body = clientModule(path.slice(5), modules);
        if (!body) return sendJson(res, 404, notFound());
        res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" });
        res.end(req.method === "HEAD" ? undefined : body);
        return;
      }
      const file = statics.get(path === "/" ? "/index.html" : path);
      if (!file) return sendJson(res, 404, notFound());
      res.writeHead(200, {
        "content-type": file.type,
        "cache-control": "no-cache",
        ...(file.type.startsWith("text/html") ? { "content-security-policy": CSP } : {}),
      });
      res.end(req.method === "HEAD" ? undefined : file.body);
      return;
    }

    const route = /^\/v1\/([a-z][a-z.]{0,40})$/.exec(path);
    const origin = header(req, "origin");
    if (req.method === "OPTIONS" && route) {
      if (origin && api.preflightAllowed(origin)) {
        res.writeHead(204, {
          "access-control-allow-origin": origin,
          "access-control-allow-methods": "POST",
          "access-control-allow-headers": "authorization, content-type",
          "access-control-max-age": "600",
          vary: "Origin",
        });
      } else {
        res.writeHead(403);
      }
      res.end();
      return;
    }
    if (req.method !== "POST" || !route) return sendJson(res, 404, notFound());

    if (!/^application\/json\b/i.test(header(req, "content-type") ?? "")) {
      return sendJson(res, 415, { error: { code: "json_only", message: "Cardboard only speaks JSON.", hint: "Send Content-Type: application/json." } });
    }
    let body: unknown;
    try {
      body = await readJson(req);
    } catch (err) {
      const out = errorResponse(err);
      return sendJson(res, out.status, out.body, { connection: "close" });
    }

    const apiReq: ApiRequest = {
      op: route[1]!,
      authorization: header(req, "authorization"),
      origin,
      host: header(req, "host"),
      ip: clientIp(req, info.trustProxy),
      body,
    };
    const tapeCall = /^Bearer\s+cbt_/i.test(apiReq.authorization ?? "");
    if (tapeCall && apiReq.op === "watch") return watch(apiReq, res);
    if (tapeCall && apiReq.op === "dock.watch") return watchDock(apiReq, res);
    const out = apiReq.op === "host.shake" ? await api.hostShake(apiReq) : api.call(apiReq);
    sendJson(res, out.status, out.body, out.headers);
  }

  /** Server-sent events: one sealed `change` event per committed write. */
  function watch(apiReq: ApiRequest, res: ServerResponse) {
    let auth: ReturnType<Api["authorizeWatch"]>;
    try {
      auth = api.authorizeWatch(apiReq);
    } catch (err) {
      const out = errorResponse(err);
      return sendJson(res, out.status, out.body);
    }
    openStream(res, auth.cors);
    res.write(`event: ready\ndata: ${JSON.stringify({ box: auth.box.id })}\n\n`);
    stream(res, `box:${auth.box.id}`, auth.box.id, auth.tape.id, (_change: Omit<Change, "boxId">) => true, "change");
  }

  /** Server-sent events: one `parcel` event per parcel addressed to this app at the dock. */
  function watchDock(apiReq: ApiRequest, res: ServerResponse) {
    let auth: ReturnType<Api["authorizeDockWatch"]>;
    try {
      auth = api.authorizeDockWatch(apiReq);
    } catch (err) {
      const out = errorResponse(err);
      return sendJson(res, out.status, out.body);
    }
    openStream(res, auth.cors);
    res.write(`event: ready\ndata: ${JSON.stringify({ me: auth.berth.tag })}\n\n`);
    const me = auth.berth.tag;
    stream(res, `dock:${auth.dock.id}`, auth.box.id, auth.tape.id, (p: Parcel) => p.from !== me && (p.to === null || p.to === me), "parcel");
  }

  function openStream(res: ServerResponse, cors: Record<string, string>) {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      ...cors,
    });
  }

  function stream(res: ServerResponse, channel: string, boxId: string, tapeId: string, accept: (event: any) => boolean, eventName: string) {
    const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
    const unsubscribe = hub.subscribe({
      channel,
      boxId,
      tapeId,
      accept,
      send: (event) => res.write(`event: ${eventName}\ndata: ${JSON.stringify(event)}\n\n`),
      close: () => {
        clearInterval(ping);
        res.end();
      },
    });
    res.on("close", () => {
      clearInterval(ping);
      unsubscribe();
    });
  }

  const server: Server = options.tls
    ? createHttpsServer({ cert: readFileSync(options.tls.cert), key: readFileSync(options.tls.key) }, handler)
    : createHttpServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  info.port = (server.address() as AddressInfo).port;
  const displayHost = host.includes(":") ? `[${host}]` : host;
  const localUrl = `${options.tls ? "https" : "http"}://${displayHost === "0.0.0.0" ? "127.0.0.1" : displayHost}:${info.port}`;
  info.publicUrl = (options.publicUrl ?? process.env["CARDBOARD_PUBLIC_URL"] ?? localUrl).replace(/\/+$/, "");

  // The very first start makes one invite, so whoever runs Cardboard can make their own account right away.
  // Until someone has made an account, every start shows a fresh invite (and the previous one stops
  // working), so stopping Cardboard before you used it can't lock you out.
  let firstInvite: string | undefined;
  if (info.signup === "invite" && accounts.list().length === 0) {
    for (const old of accounts.invites()) if (old.usedAt === null && old.createdBy === null && old.note === "first account") accounts.revokeInvite(old.id);
    firstInvite = `${info.publicUrl}/#invite=${accounts.createInvite({ note: "first account" }).code}`;
  }

  const sweeper = setInterval(() => {
    try {
      for (const [boxId, count] of vault.sweep().expired) {
        const box = vault.box(boxId);
        if (box) audit.record({ accountId: box.accountId, boxId, actor: "system", action: "expire", count });
      }
      docks.sweep();
      oauth.sweep();
      accounts.sweep();
      sharing.sweep();
      if (backupEveryMs) api.backupIfDue(backupEveryMs);
      audit.prune();
    } catch (err) {
      console.error("[cardboard] housekeeping failed:", err);
    }
  }, options.sweepEveryMs ?? 60_000);
  sweeper.unref();

  const shake = options.shake === false ? null : await api.runShake();

  return {
    url: localUrl,
    publicUrl: info.publicUrl,
    host,
    port: info.port,
    paths,
    firstRun,
    hostToken,
    firstInvite,
    shake,
    api,
    close: async () => {
      clearInterval(sweeper);
      hub.closeWhere(() => true);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    },
  };
}

function loadStatics(): Map<string, { body: Buffer; type: string }> {
  const files = new Map<string, { body: Buffer; type: string }>();
  for (const [path, type] of Object.entries(STATIC)) {
    try {
      files.set(path, { body: readFileSync(join(PUBLIC_DIR, path.slice(1))), type });
    } catch {
      // Dashboard files are optional (e.g. when embedding the server).
    }
  }
  return files;
}

/**
 * The dashboard's crypto is the same code as the SDK's (src/client, src/shared,
 * src/sdk), served to the browser with its types stripped. From an installed
 * package, the compiled dist/ files are served instead.
 */
/** A URL path for one of the dashboard's modules, e.g. client/account.ts. (URL paths always use "/", on Windows too.) */
export function isModulePath(path: string): boolean {
  return /^(client|shared|sdk)\/[a-z0-9-]+\.(ts|js)$/.test(path) && posix.normalize(path) === path;
}

function clientModule(path: string, cache: Map<string, Buffer | null>): Buffer | null {
  if (!isModulePath(path)) return null;
  if (cache.has(path)) return cache.get(path)!;
  let body: Buffer | null = null;
  const source = join(ROOT, "src", path.replace(/\.js$/, ".ts"));
  const built = join(ROOT, "dist", path.replace(/\.ts$/, ".js"));
  try {
    if (existsSync(source)) {
      body = Buffer.from(stripTypeScriptTypes(readFileSync(source, "utf8"), { mode: "strip" }));
    } else if (existsSync(built)) {
      body = readFileSync(built);
    }
  } catch (err) {
    console.error(`[cardboard] couldn't prepare ${path} for the dashboard:`, err);
  }
  cache.set(path, body);
  return body;
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    // The last entry is the one your own proxy added; anything before it, the client could have made up.
    const forwarded = header(req, "x-forwarded-for")?.split(",").at(-1)?.trim();
    if (forwarded) return forwarded;
  }
  return (req.socket.remoteAddress ?? "unknown").replace(/^::ffff:/, "");
}

function notFound() {
  return { error: { code: "not_found", message: "Nothing here.", hint: "The API is POST /v1/<operation> with a JSON body. The dashboard is at /." } };
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(json),
    ...headers,
  });
  res.end(json);
}

function readJson(req: IncomingMessage): Promise<unknown> {
  const tooLarge = () => fail("too_large", 413, "That request is too large.", `Cardboard accepts up to ${MAX_BODY / 1024 / 1024} MB per request.`);
  if (Number(header(req, "content-length") ?? 0) > MAX_BODY) {
    req.resume();
    return Promise.reject(tooLarge());
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        req.removeAllListeners("data");
        req.resume();
        reject(tooLarge());
      } else {
        chunks.push(chunk);
      }
    });
    req.on("end", () => {
      if (size > MAX_BODY) return;
      const text = Buffer.concat(chunks).toString("utf8");
      if (text.trim() === "") return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new CardboardError("bad_json", 400, "The request body isn't valid JSON."));
      }
    });
    req.on("error", reject);
  });
}
