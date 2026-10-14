import { readFileSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { CardboardError, fail } from "../shared/errors.ts";
import { VERSION } from "../shared/version.ts";
import { Api, errorResponse, type ApiRequest } from "./api.ts";
import { Audit } from "./audit.ts";
import { Hub } from "./hub.ts";
import type { ServerInfo } from "./insights.ts";
import { openStore, resolvePaths, type Paths } from "./setup.ts";
import type { ShakeReport } from "./shake.ts";
import { Tapes } from "./tapes.ts";
import type { Vault } from "./vault.ts";

export interface StartOptions {
  dataDir?: string;
  keyFile?: string;
  host?: string;
  port?: number;
  /** Paths to a certificate and private key to serve HTTPS directly. */
  tls?: { cert: string; key: string };
  /** Trust X-Forwarded-For (only when Cardboard sits behind your own reverse proxy). */
  trustProxy?: boolean;
  /** Run the shake test on startup (default true). */
  shake?: boolean;
  sweepEveryMs?: number;
  now?: () => number;
}

export interface RunningCardboard {
  url: string;
  host: string;
  port: number;
  paths: Paths;
  firstRun: boolean;
  /** Printed once, on the very first start. */
  ownerToken?: string;
  shake: ShakeReport | null;
  api: Api;
  vault: Vault;
  close(): Promise<void>;
}

const MAX_BODY = 16 * 1024 * 1024;
const PUBLIC_DIR = join(import.meta.dirname, "..", "..", "public");
const STATIC: Record<string, string> = {
  "/index.html": "text/html; charset=utf-8",
  "/app.js": "text/javascript; charset=utf-8",
  "/style.css": "text/css; charset=utf-8",
  "/favicon.svg": "image/svg+xml",
};
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

export async function startServer(options: StartOptions = {}): Promise<RunningCardboard> {
  const now = options.now ?? Date.now;
  const paths = resolvePaths(options);
  const { db, vault, firstRun, ownerToken } = openStore(paths, now);

  // A crash mid-shake could leave its throwaway boxes behind.
  for (const box of vault.listBoxes({ includeSystem: true })) {
    if (box.system && box.name.startsWith("__shake-")) vault.shredBox(box.id);
  }

  const tapes = new Tapes(db, now);
  const audit = new Audit(db, vault, tapes);
  const hub = new Hub();
  const host = options.host ?? process.env["CARDBOARD_HOST"] ?? "127.0.0.1";
  const port = options.port ?? Number(process.env["CARDBOARD_PORT"] ?? 8787);
  const info: ServerInfo = {
    version: VERSION,
    dataDir: paths.dataDir,
    dbFile: paths.dbFile,
    keyFile: paths.keyFile,
    host,
    port,
    tls: Boolean(options.tls),
    trustProxy: Boolean(options.trustProxy),
    startedAt: now(),
  };
  const api = new Api({ db, vault, tapes, audit, hub, info });
  const statics = loadStatics();

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

    if (req.method === "GET" || req.method === "HEAD") {
      if (path === "/health") return sendJson(res, 200, { ok: true, version: VERSION });
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

    const route = /^\/v1\/(admin\/)?([a-z][a-z.]{0,40})$/.exec(path);
    const origin = header(req, "origin");
    if (req.method === "OPTIONS" && route) {
      if (origin && !route[1] && api.preflightAllowed(origin)) {
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
      return sendJson(res, 415, {
        error: { code: "json_only", message: "Cardboard only speaks JSON.", hint: "Send Content-Type: application/json." },
      });
    }
    let body: unknown;
    try {
      body = await readJson(req);
    } catch (err) {
      const out = errorResponse(err);
      return sendJson(res, out.status, out.body, { connection: "close" });
    }

    const apiReq: ApiRequest = {
      op: route[2]!,
      admin: Boolean(route[1]),
      authorization: header(req, "authorization"),
      origin,
      host: header(req, "host"),
      ip: clientIp(req, info.trustProxy),
      body,
    };
    if (!apiReq.admin && apiReq.op === "watch") return watch(apiReq, res);
    const out = api.call(apiReq);
    sendJson(res, out.status, out.body, out.headers);
  }

  /** Server-sent events: one `change` event per committed write under the watched prefix. */
  function watch(apiReq: ApiRequest, res: ServerResponse) {
    let auth: ReturnType<Api["authorizeWatch"]>;
    try {
      auth = api.authorizeWatch(apiReq);
    } catch (err) {
      const out = errorResponse(err);
      return sendJson(res, out.status, out.body);
    }
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      ...auth.cors,
    });
    res.write(`event: ready\ndata: ${JSON.stringify({ box: auth.box.name, prefix: auth.prefix })}\n\n`);
    const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
    const unsubscribe = hub.subscribe({
      boxId: auth.box.id,
      tapeId: auth.tape.id,
      prefix: auth.prefix,
      send: (change) => res.write(`event: change\ndata: ${JSON.stringify(change)}\n\n`),
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

  const sweeper = setInterval(() => {
    try {
      for (const [boxId, count] of vault.sweep().expired) audit.record(boxId, "system", "expire", "ok", { count });
      audit.prune();
    } catch (err) {
      console.error("[cardboard] housekeeping failed:", err);
    }
  }, options.sweepEveryMs ?? 60_000);
  sweeper.unref();

  const shake = options.shake === false ? null : api.runShake();
  const displayHost = host.includes(":") ? `[${host}]` : host;

  return {
    url: `${options.tls ? "https" : "http"}://${displayHost === "0.0.0.0" ? "127.0.0.1" : displayHost}:${info.port}`,
    host,
    port: info.port,
    paths,
    firstRun,
    ownerToken,
    shake,
    api,
    vault,
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

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = header(req, "x-forwarded-for")?.split(",")[0]?.trim();
    if (forwarded) return forwarded;
  }
  return (req.socket.remoteAddress ?? "unknown").replace(/^::ffff:/, "");
}

function notFound() {
  return {
    error: {
      code: "not_found",
      message: "Nothing here.",
      hint: "The API is POST /v1/<operation> with a JSON body. The dashboard is at /.",
    },
  };
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
