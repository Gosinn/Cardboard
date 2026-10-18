import type { IncomingMessage, ServerResponse } from "node:http";
import { CardboardError } from "../shared/errors.ts";
import type { Api } from "./api.ts";
import { OAuthError, type OAuth } from "./oauth.ts";
import { errorPage } from "./pages.ts";

/**
 * HTTP side of Sign in with Cardboard: the standard endpoints (discovery, JWKS,
 * dynamic registration, authorize, token, userinfo, revoke). /oauth/authorize
 * checks the request, then hands your browser to the dashboard, which has your
 * keys and asks you.
 */

const MAX_FORM = 64 * 1024;
const PAGE_CSP = ["default-src 'none'", "style-src 'self'", "img-src 'self' data:", "form-action 'none'", "base-uri 'none'", "frame-ancestors 'none'"].join("; ");

export interface OAuthHttpDeps {
  oauth: OAuth;
  api: Api;
  ip: (req: IncomingMessage) => string;
}

export function createOAuthHandler(deps: OAuthHttpDeps) {
  const { oauth, api } = deps;
  const registrations = new Map<string, number[]>();

  return async function handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
    const method = req.method ?? "GET";
    const isOAuth = path.startsWith("/oauth/") || path.startsWith("/.well-known/");
    if (!isOAuth) return false;

    const corsOpen = ["/oauth/token", "/oauth/userinfo", "/oauth/jwks", "/oauth/register", "/oauth/revoke"].includes(path) || path.startsWith("/.well-known/");
    if (method === "OPTIONS" && corsOpen) {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST",
        "access-control-allow-headers": "authorization, content-type",
        "access-control-max-age": "600",
      });
      res.end();
      return true;
    }
    const cors: Record<string, string> = corsOpen ? { "access-control-allow-origin": "*" } : {};

    try {
      if (method === "GET" && (path === "/.well-known/openid-configuration" || path === "/.well-known/oauth-authorization-server")) {
        return json(res, 200, oauth.discovery(), { ...cors, "cache-control": "public, max-age=300" });
      }
      if (method === "GET" && path === "/oauth/jwks") return json(res, 200, oauth.jwks(), { ...cors, "cache-control": "public, max-age=300" });

      if (method === "POST" && path === "/oauth/register") {
        const ip = deps.ip(req);
        const now = api.ctx.vault.now();
        const recent = (registrations.get(ip) ?? []).filter((t) => t > now - 60 * 60 * 1000);
        if (recent.length >= 30) return json(res, 429, { error: "slow_down", error_description: "Too many registrations from your address." }, cors);
        registrations.set(ip, [...recent, now]);
        const meta = JSON.parse((await readBody(req)).toString() || "{}") as Record<string, unknown>;
        const { client, response } = oauth.register(meta, "self");
        api.ctx.audit.record({ accountId: null, actor: "anonymous", action: "app.register", note: client.name });
        return json(res, 201, response, cors);
      }

      if (path === "/oauth/authorize" && method === "GET") {
        const check = oauth.checkAuthorize(new URL(req.url ?? "/", "http://x").searchParams);
        if (check.kind === "page") return html(res, 400, errorPage(check.message, check.hint));
        if (check.kind === "redirect") return redirect(res, check.location);
        // Your keys live in your dashboard, so that's where you say yes or no. No fragment in
        // this redirect, so the browser keeps the app's own (#cardboard_key=…), which the server
        // never sees: the dashboard checks the server didn't swap the app's key.
        return redirect(res, `/?connect=${oauth.startRequest(check.request)}`);
      }

      if (path === "/oauth/token" && method === "POST") {
        const form = new URLSearchParams((await readBody(req)).toString());
        const creds = clientCredentials(req, form);
        const grantType = form.get("grant_type");
        const tokens =
          grantType === "authorization_code"
            ? oauth.exchangeCode({
                code: form.get("code") ?? undefined,
                redirectUri: form.get("redirect_uri") ?? undefined,
                verifier: form.get("code_verifier") ?? undefined,
                ...creds,
              })
            : grantType === "refresh_token"
              ? oauth.refresh({ refreshToken: form.get("refresh_token") ?? undefined, ...creds })
              : (() => {
                  throw new OAuthError("unsupported_grant_type", "Use authorization_code or refresh_token.");
                })();
        return json(res, 200, tokens, { ...cors, "cache-control": "no-store", pragma: "no-cache" });
      }

      if (path === "/oauth/userinfo" && (method === "GET" || method === "POST")) {
        const token = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "")?.[1] ?? null;
        return json(res, 200, oauth.userinfo(token), { ...cors, "cache-control": "no-store" });
      }

      if (path === "/oauth/revoke" && method === "POST") {
        const form = new URLSearchParams((await readBody(req)).toString());
        const token = form.get("token");
        if (token) oauth.revokeToken(token, clientCredentials(req, form).clientId);
        return json(res, 200, {}, cors);
      }

      return json(res, 404, { error: "not_found", error_description: "No such OAuth endpoint. Discovery is at /.well-known/openid-configuration." }, cors);
    } catch (err) {
      if (err instanceof OAuthError) {
        const headers: Record<string, string> = { ...cors, "cache-control": "no-store" };
        if (err.status === 401) headers["www-authenticate"] = path === "/oauth/userinfo" ? `Bearer error="${err.error}"` : 'Basic realm="cardboard"';
        return json(res, err.status, { error: err.error, error_description: err.message }, headers);
      }
      if (err instanceof CardboardError) {
        if (path === "/oauth/authorize") return html(res, err.status, errorPage(err.reason, err.hint));
        return json(res, err.status, { error: err.code, error_description: err.message }, cors);
      }
      if (err instanceof SyntaxError) return json(res, 400, { error: "invalid_request", error_description: "The request body isn't valid." }, cors);
      throw err;
    }
  };
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): true {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text), ...headers });
  res.end(text);
  return true;
}

function html(res: ServerResponse, status: number, body: string): true {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "content-security-policy": PAGE_CSP, "cache-control": "no-store" });
  res.end(body);
  return true;
}

function redirect(res: ServerResponse, location: string): true {
  res.writeHead(302, { location, "cache-control": "no-store" });
  res.end();
  return true;
}

function clientCredentials(req: IncomingMessage, form: URLSearchParams): { clientId?: string; clientSecret?: string } {
  const basic = /^Basic\s+(\S+)$/i.exec(req.headers.authorization ?? "")?.[1];
  if (basic) {
    const [id, ...secret] = Buffer.from(basic, "base64").toString().split(":");
    return { clientId: decodeURIComponent(id ?? ""), clientSecret: decodeURIComponent(secret.join(":")) };
  }
  return { clientId: form.get("client_id") ?? undefined, clientSecret: form.get("client_secret") ?? undefined };
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_FORM) {
        req.removeAllListeners("data");
        req.resume();
        reject(new OAuthError("invalid_request", "That request is too large."));
      } else chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
