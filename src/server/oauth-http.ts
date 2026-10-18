import type { IncomingMessage, ServerResponse } from "node:http";
import { CardboardError } from "../shared/errors.ts";
import type { Api } from "./api.ts";
import { OAuthError, type AuthRequest, type OAuth } from "./oauth.ts";
import { consentPage, errorPage, loginPage } from "./pages.ts";

/**
 * HTTP side of Sign in with Cardboard: the standard endpoints (discovery, JWKS,
 * dynamic registration, authorize, token, userinfo, revoke) plus the cookie
 * session that the sign-in and consent pages use.
 */

const COOKIE = "cardboard_session";
const MAX_FORM = 64 * 1024;
/** form-action also governs where a submitted form may redirect, so it names the app being signed into. */
function pageCsp(formTargets: string[]): string {
  return [
    "default-src 'none'",
    "style-src 'self'",
    "img-src 'self' data:",
    `form-action 'self'${formTargets.map((t) => ` ${t}`).join("")}`,
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** The CSP source for a redirect URI: its origin, or its scheme for native apps. */
function formTarget(redirectUri: string): string {
  const url = new URL(redirectUri);
  return url.origin !== "null" ? url.origin : url.protocol;
}

export interface OAuthHttpDeps {
  oauth: OAuth;
  api: Api;
  /** Whether cookies should be Secure (Cardboard is served over https). */
  secure: () => boolean;
  ip: (req: IncomingMessage) => string;
}

export function createOAuthHandler(deps: OAuthHttpDeps) {
  const { oauth, api } = deps;
  const registrations = new Map<string, number[]>();

  const log = (action: string, outcome: "ok" | "denied", detail: Record<string, unknown>, boxId: string | null = null) =>
    api.ctx.audit.record(boxId, "owner", action, outcome, detail);
  oauth.onAlarm = (message) => api.ctx.audit.record(null, "system", "app.alarm", "denied", { note: message });

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
        api.ctx.audit.record(null, "system", "app.register", "ok", { name: client.name, note: client.redirectUris.join(", ") });
        return json(res, 201, response, cors);
      }

      if (path === "/oauth/authorize" && method === "GET") return authorize(req, res, new URL(req.url ?? "/", "http://x").searchParams);
      if (path === "/oauth/authorize" && method === "POST") {
        if (!sameOrigin(req)) return html(res, 403, errorPage("That form came from another site, so Cardboard ignored it."));
        return decide(req, res, new URLSearchParams((await readBody(req)).toString()));
      }

      if (path === "/oauth/login" && method === "POST") {
        if (!sameOrigin(req)) return html(res, 403, errorPage("That form came from another site, so Cardboard ignored it."));
        const form = new URLSearchParams((await readBody(req)).toString());
        const returnTo = safeReturn(form.get("return_to"));
        const pending = oauth.checkAuthorize(new URL(returnTo, "http://cardboard.local").searchParams);
        const targets = pending.kind === "ok" ? [formTarget(pending.request.redirectUri)] : [];
        if (!api.verifyOwnerSecret(form.get("token")?.trim(), deps.ip(req))) {
          return html(res, 401, loginPage({ returnTo, error: "That isn't the owner token for this Cardboard." }), targets);
        }
        startSession(res);
        log("session", "ok", { ip: deps.ip(req) });
        return redirect(res, 303, returnTo);
      }

      // The dashboard calls this after you sign in, so "Sign in with Cardboard" works in the same browser.
      if (path === "/oauth/session" && method === "POST") {
        const token = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "")?.[1];
        if (!sameOrigin(req) || !api.verifyOwnerSecret(token, deps.ip(req))) return json(res, 401, { error: "not_owner" });
        startSession(res);
        return json(res, 200, { ok: true });
      }
      if (path === "/oauth/logout" && method === "POST") {
        oauth.endSession(cookie(req, COOKIE));
        res.setHeader("set-cookie", sessionCookie("", 0));
        return json(res, 200, { ok: true });
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
        if (path === "/oauth/authorize" || path === "/oauth/login") return html(res, err.status, errorPage(err.reason, err.hint));
        return json(res, err.status, { error: err.code, error_description: err.message }, cors);
      }
      if (err instanceof SyntaxError) return json(res, 400, { error: "invalid_request", error_description: "The request body isn't valid." }, cors);
      throw err;
    }
  };

  function authorize(req: IncomingMessage, res: ServerResponse, params: URLSearchParams): boolean {
    const check = oauth.checkAuthorize(params);
    if (check.kind === "page") return html(res, 400, errorPage(check.message, check.hint));
    if (check.kind === "redirect") return redirect(res, 302, check.location);
    const { request } = check;
    const session = oauth.checkSession(cookie(req, COOKIE));
    if (!session) {
      if (request.prompt === "none") return redirect(res, 302, oauth.redirectWith(request.redirectUri, { error: "login_required", state: request.state }));
      return html(res, 200, loginPage({ returnTo: `/oauth/authorize?${params.toString()}`, appName: request.client.name }), [
        formTarget(request.redirectUri),
      ]);
    }
    const existing = oauth.existingGrant(request.client.id, request.scopes);
    if (existing && request.prompt !== "consent") {
      // Already said yes to all of this: straight back to the app. It remembers you.
      return redirect(res, 302, codeRedirect(request, existing, session.createdAt));
    }
    if (request.prompt === "none") return redirect(res, 302, oauth.redirectWith(request.redirectUri, { error: "consent_required", state: request.state }));
    const previous = oauth.grantsOf(request.client.id).find((g) => g.boxId);
    const boxName = previous?.boxId ? (api.ctx.vault.getBox(previous.boxId)?.name ?? null) : null;
    return html(
      res,
      200,
      consentPage({ request, profile: oauth.profile(), boxName, csrf: oauth.csrf(session.hash, request.client.id), now: api.ctx.vault.now() }),
      [formTarget(request.redirectUri)],
    );
  }

  function decide(req: IncomingMessage, res: ServerResponse, form: URLSearchParams): boolean {
    const session = oauth.checkSession(cookie(req, COOKIE));
    if (!session) return html(res, 401, errorPage("Your sign-in expired.", "Go back to the app and try again."));
    const check = oauth.checkAuthorize(new URLSearchParams([...form.entries(), ["response_type", "code"]]));
    if (check.kind === "page") return html(res, 400, errorPage(check.message, check.hint));
    if (check.kind === "redirect") return redirect(res, 303, check.location);
    const { request } = check;
    if (form.get("csrf") !== oauth.csrf(session.hash, request.client.id)) {
      return html(res, 403, errorPage("That form is out of date or didn't come from this page.", "Go back to the app and try again."));
    }
    if (form.get("decision") !== "allow") {
      log("app.deny", "ok", { name: request.client.name });
      return redirect(res, 303, oauth.redirectWith(request.redirectUri, { error: "access_denied", error_description: "You said no.", state: request.state }));
    }
    const grant = oauth.consent(request);
    log("app.connect", "ok", { name: request.client.name, note: grant.scopes.join(" ") }, grant.boxId);
    return redirect(res, 303, codeRedirect(request, grant, session.createdAt));
  }

  function codeRedirect(request: AuthRequest, grant: Parameters<OAuth["issueCode"]>[0], authTime: number): string {
    const code = oauth.issueCode(grant, request, authTime);
    return oauth.redirectWith(request.redirectUri, { code, state: request.state });
  }

  function startSession(res: ServerResponse) {
    res.setHeader("set-cookie", sessionCookie(oauth.createSession(), 30 * 24 * 60 * 60));
  }

  function sessionCookie(value: string, maxAge: number): string {
    return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${deps.secure() ? "; Secure" : ""}`;
  }
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): true {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text), ...headers });
  res.end(text);
  return true;
}

function html(res: ServerResponse, status: number, body: string, formTargets: string[] = []): true {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": pageCsp(formTargets),
    "cache-control": "no-store",
    // no-referrer would make browsers send "Origin: null" on our own forms; same-origin still tells other sites nothing.
    "referrer-policy": "same-origin",
  });
  res.end(body);
  return true;
}

function redirect(res: ServerResponse, status: 302 | 303, location: string): true {
  res.writeHead(status, { location, "cache-control": "no-store" });
  res.end();
  return true;
}

function cookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}

/** Browsers send Origin on form posts; it has to be this Cardboard. */
function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

/** Only ever bounce back into our own authorize flow, never to an arbitrary URL. */
function safeReturn(value: string | null): string {
  return value && value.startsWith("/oauth/authorize?") ? value : "/";
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
