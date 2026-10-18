/**
 * Sign in with Cardboard, from the app's side. Zero dependencies; works in Node
 * and browsers. Any standard OpenID Connect library works too. This is just
 * the shortest path:
 *
 *   const pending = await startSignIn(config);      // → send the user to pending.url
 *   const session = await finishSignIn(config, callbackUrl, pending);
 *   session.user.id                                 // your private ID for this person
 *   await session.box().put("prefs", { theme: "dark" });  // stored in THEIR Cardboard
 */
import { Box, CardboardError } from "./index.ts";

export type SignInScope = "openid" | "profile" | "email" | "box";

export interface SignInConfig {
  /** The person's Cardboard, e.g. https://cardboard.example.com */
  issuer: string;
  clientId: string;
  /** Only for apps with a server. Never put a client secret in a browser app. */
  clientSecret?: string;
  redirectUri: string;
  /** Defaults to ["openid", "box"]: recognise them, and keep your data about them in their Cardboard. */
  scopes?: SignInScope[];
  fetch?: typeof fetch;
}

export interface PendingSignIn {
  /** Send the person here. */
  url: string;
  /** Keep these three until the callback (e.g. in the session or a cookie). */
  state: string;
  verifier: string;
  nonce: string;
}

export interface CardboardUser {
  /** A private ID for this person, made only for your app. It never changes for your app. */
  id: string;
  name?: string;
  email?: string;
}

export interface CardboardSession {
  user: CardboardUser;
  accessToken: string;
  /** Store this to stay signed in (resumeSession). Treat it like a password. */
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
  /** Your app's box in the person's Cardboard. Tokens refresh by themselves. */
  box(): Box;
  /** Gets fresh tokens. Concurrent calls share one refresh, so rotation can't trip over itself. */
  refresh(): Promise<CardboardSession>;
  /** Disconnects your app from their Cardboard. */
  signOut(): Promise<void>;
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  revocation_endpoint: string;
}

const discoveries = new Map<string, Promise<Discovery>>();

function discover(issuer: string, fetchImpl: typeof fetch): Promise<Discovery> {
  const base = issuer.replace(/\/+$/, "");
  let found = discoveries.get(base);
  if (!found) {
    found = fetchImpl(`${base}/.well-known/openid-configuration`).then(async (res) => {
      if (!res.ok) throw new CardboardError("no_cardboard", res.status, `Couldn't find a Cardboard at ${base}.`);
      return (await res.json()) as Discovery;
    });
    found.catch(() => discoveries.delete(base));
    discoveries.set(base, found);
  }
  return found;
}

/** Registers your app with someone's Cardboard (do it once and keep the clientId). */
export async function registerApp(
  issuer: string,
  app: { name: string; redirectUris: string[]; clientUri?: string; hasServer?: boolean },
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<{ clientId: string; clientSecret?: string }> {
  const { registration_endpoint } = await discover(issuer, fetchImpl);
  const res = await fetchImpl(registration_endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: app.name,
      redirect_uris: app.redirectUris,
      client_uri: app.clientUri,
      token_endpoint_auth_method: app.hasServer ? "client_secret_basic" : "none",
    }),
  });
  const data = (await res.json()) as { client_id?: string; client_secret?: string; error?: string; error_description?: string };
  if (!res.ok || !data.client_id) throw new CardboardError(data.error ?? "registration_failed", res.status, data.error_description ?? "Registration failed.");
  return data.client_secret ? { clientId: data.client_id, clientSecret: data.client_secret } : { clientId: data.client_id };
}

export async function startSignIn(config: SignInConfig): Promise<PendingSignIn> {
  const fetchImpl = config.fetch ?? globalThis.fetch.bind(globalThis);
  const { authorization_endpoint } = await discover(config.issuer, fetchImpl);
  const verifier = randomString(32);
  const state = randomString(16);
  const nonce = randomString(16);
  const url = new URL(authorization_endpoint);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: (config.scopes ?? ["openid", "box"]).join(" "),
    state,
    nonce,
    code_challenge: await challengeFor(verifier),
    code_challenge_method: "S256",
  }).toString();
  return { url: url.toString(), state, verifier, nonce };
}

export async function finishSignIn(
  config: SignInConfig,
  callbackUrl: string | URL,
  pending: Pick<PendingSignIn, "state" | "verifier" | "nonce">,
): Promise<CardboardSession> {
  const fetchImpl = config.fetch ?? globalThis.fetch.bind(globalThis);
  const discovery = await discover(config.issuer, fetchImpl);
  const params = new URL(callbackUrl).searchParams;
  if (params.get("error")) {
    throw new CardboardError(params.get("error")!, 0, params.get("error_description") ?? "Sign-in didn't complete.");
  }
  if (params.get("state") !== pending.state) throw new CardboardError("bad_state", 0, "This sign-in didn't start here (state mismatch).");
  const iss = params.get("iss");
  if (iss && iss !== discovery.issuer) throw new CardboardError("bad_issuer", 0, "This answer came from a different Cardboard.");
  const code = params.get("code");
  if (!code) throw new CardboardError("no_code", 0, "The callback has no code.");
  const tokens = await tokenRequest(config, discovery, fetchImpl, {
    grant_type: "authorization_code",
    code,
    redirect_uri: config.redirectUri,
    code_verifier: pending.verifier,
  });
  return makeSession(config, discovery, fetchImpl, tokens, pending.nonce);
}

/** Picks up where a stored refresh token left off (e.g. after your server restarts). */
export async function resumeSession(config: SignInConfig, refreshToken: string): Promise<CardboardSession> {
  const fetchImpl = config.fetch ?? globalThis.fetch.bind(globalThis);
  const discovery = await discover(config.issuer, fetchImpl);
  const tokens = await tokenRequest(config, discovery, fetchImpl, { grant_type: "refresh_token", refresh_token: refreshToken });
  return makeSession(config, discovery, fetchImpl, tokens, null);
}

interface Tokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
  id_token?: string;
}

async function tokenRequest(config: SignInConfig, discovery: Discovery, fetchImpl: typeof fetch, form: Record<string, string>): Promise<Tokens> {
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  const body = new URLSearchParams({ ...form, client_id: config.clientId });
  if (config.clientSecret) {
    headers["authorization"] = `Basic ${btoa(`${encodeURIComponent(config.clientId)}:${encodeURIComponent(config.clientSecret)}`)}`;
  }
  const res = await fetchImpl(discovery.token_endpoint, { method: "POST", headers, body: body.toString() });
  const data = (await res.json()) as Tokens & { error?: string; error_description?: string };
  if (!res.ok) throw new CardboardError(data.error ?? "token_failed", res.status, data.error_description ?? "Cardboard refused the token request.");
  return data;
}

function makeSession(config: SignInConfig, discovery: Discovery, fetchImpl: typeof fetch, tokens: Tokens, nonce: string | null): CardboardSession {
  const claims = tokens.id_token ? decodeJwt(tokens.id_token) : {};
  if (tokens.id_token) {
    // Received straight from the token endpoint over TLS, so the claims are what matter (OIDC Core 3.1.3.7).
    if (claims["iss"] !== discovery.issuer) throw new CardboardError("bad_id_token", 0, "The ID token is from a different issuer.");
    if (claims["aud"] !== config.clientId) throw new CardboardError("bad_id_token", 0, "The ID token is for a different app.");
    if (nonce && claims["nonce"] !== nonce) throw new CardboardError("bad_id_token", 0, "The ID token's nonce doesn't match.");
  }
  let current = tokens;
  let inflight: Promise<CardboardSession> | null = null;
  let box: Box | null = null;

  const session: CardboardSession = {
    user: {
      id: String(claims["sub"] ?? ""),
      ...(typeof claims["name"] === "string" ? { name: claims["name"] } : {}),
      ...(typeof claims["email"] === "string" ? { email: claims["email"] } : {}),
    },
    accessToken: current.access_token,
    refreshToken: current.refresh_token,
    expiresAt: Date.now() + current.expires_in * 1000,
    scopes: current.scope.split(" "),
    box() {
      if (!session.scopes.includes("box")) {
        throw new CardboardError("no_box_scope", 0, "This sign-in didn't ask for the box scope.", 'Add "box" to scopes.');
      }
      box ??= new Box({
        url: discovery.issuer,
        tape: session.accessToken,
        fetch: fetchImpl,
        refresh: async () => (await session.refresh()).accessToken,
      });
      return box;
    },
    refresh() {
      inflight ??= tokenRequest(config, discovery, fetchImpl, { grant_type: "refresh_token", refresh_token: session.refreshToken })
        .then((fresh) => {
          current = fresh;
          session.accessToken = fresh.access_token;
          session.refreshToken = fresh.refresh_token;
          session.expiresAt = Date.now() + fresh.expires_in * 1000;
          return session;
        })
        .finally(() => {
          inflight = null;
        });
      return inflight;
    },
    async signOut() {
      await fetchImpl(discovery.revocation_endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: session.refreshToken, client_id: config.clientId }).toString(),
      });
    },
  };
  return session;
}

function randomString(bytes: number): string {
  return toBase64url(globalThis.crypto.getRandomValues(new Uint8Array(bytes)));
}

async function challengeFor(verifier: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return toBase64url(new Uint8Array(digest));
}

function toBase64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeJwt(jwt: string): Record<string, unknown> {
  const part = jwt.split(".")[1] ?? "";
  const binary = atob(part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "="));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
}
