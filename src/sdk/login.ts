/**
 * Sign in with Cardboard, from the app's side. Zero dependencies; works in Node
 * and browsers. Any standard OpenID Connect library works too, but only this
 * SDK can receive a box and the person's name: those are sealed by their
 * browser to a key your app makes for each sign-in, so the Cardboard server
 * relays them without being able to read them.
 *
 *   const pending = await startSignIn(config);      // → send the user to pending.url
 *   const session = await finishSignIn(config, callbackUrl, pending);
 *   session.user.id                                 // your private ID for this person
 *   await session.box().put("prefs", { theme: "dark" });  // stored, sealed, in THEIR Cardboard
 *   saveSomewhereSafe(session.save());              // later: resumeSession(config, saved)
 */
import { ctx } from "../shared/contexts.ts";
import { exportPrivateKey, fromB64u, importPrivateKey, keyPair, openWith, toB64u, utf8 } from "../client/crypto.ts";
import { readBundle } from "../client/keys.ts";
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
  /** Keep these until the callback (e.g. in the session or a cookie). `key` is a private key: keep it server-side or in sessionStorage. */
  state: string;
  verifier: string;
  nonce: string;
  key: string;
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
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
  /** Your app's box in the person's Cardboard. Tokens refresh by themselves. */
  box(): Box;
  /** Gets fresh tokens. Concurrent calls share one refresh, so rotation can't trip over itself. */
  refresh(): Promise<CardboardSession>;
  /** Disconnects your app from their Cardboard. */
  signOut(): Promise<void>;
  /** Everything resumeSession needs, including the box key. Store it like a password. */
  save(): string;
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  revocation_endpoint: string;
}

interface SessionKeys {
  boxId: string;
  box: Uint8Array;
  names: Uint8Array;
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
  // A key just for this sign-in: the person's browser seals the box key and their profile to it.
  const pair = await keyPair(true);
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
    cardboard_key: toB64u(pair.publicKey),
  }).toString();
  // Again in the fragment, which browsers never send to servers: the person's dashboard checks the
  // two match, so a server that swapped in its own key (to read the box key) would be caught.
  url.hash = `cardboard_key=${toB64u(pair.publicKey)}`;
  return { url: url.toString(), state, verifier, nonce, key: `${toB64u(pair.publicKey)}.${await exportPrivateKey(pair.privateKey)}` };
}

export async function finishSignIn(config: SignInConfig, callbackUrl: string | URL, pending: Pick<PendingSignIn, "state" | "verifier" | "nonce" | "key">): Promise<CardboardSession> {
  const fetchImpl = config.fetch ?? globalThis.fetch.bind(globalThis);
  const discovery = await discover(config.issuer, fetchImpl);
  const params = new URL(callbackUrl).searchParams;
  if (params.get("error")) throw new CardboardError(params.get("error")!, 0, params.get("error_description") ?? "Sign-in didn't complete.");
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
  let keys: SessionKeys | null = null;
  let profile: { name?: string; email?: string } = {};
  if (tokens.cardboard_bundle) {
    const [pub, priv] = pending.key.split(".");
    const pair = { publicKey: fromB64u(pub ?? ""), privateKey: await importPrivateKey(priv ?? "") };
    const sealed = JSON.parse(utf8.decode(await openWith(pair, fromB64u(tokens.cardboard_bundle), ctx.signIn(config.clientId)))) as {
      v: 1;
      box?: unknown;
      profile?: { name?: unknown; email?: unknown };
    };
    if (sealed.box) {
      keys = readBundle(sealed.box);
      if (tokens.cardboard_box && keys.boxId !== tokens.cardboard_box) throw new CardboardError("wrong_box", 0, "The box key that came back is for a different box.");
    }
    if (typeof sealed.profile?.name === "string") profile.name = sealed.profile.name;
    if (typeof sealed.profile?.email === "string") profile.email = sealed.profile.email;
  }
  return makeSession(config, discovery, fetchImpl, tokens, pending.nonce, keys, profile);
}

/** Picks up where session.save() left off (e.g. after your server restarts). */
export async function resumeSession(config: SignInConfig, saved: string): Promise<CardboardSession> {
  const fetchImpl = config.fetch ?? globalThis.fetch.bind(globalThis);
  const discovery = await discover(config.issuer, fetchImpl);
  let refreshToken = saved;
  let keys: SessionKeys | null = null;
  let profile: { name?: string; email?: string } = {};
  if (saved.trim().startsWith("{")) {
    const data = JSON.parse(saved) as { refreshToken: string; keys?: { boxId: string; box: string; names: string } | null; profile?: { name?: string; email?: string } };
    refreshToken = data.refreshToken;
    if (data.keys) keys = { boxId: data.keys.boxId, box: fromB64u(data.keys.box), names: fromB64u(data.keys.names) };
    profile = data.profile ?? {};
  }
  const tokens = await tokenRequest(config, discovery, fetchImpl, { grant_type: "refresh_token", refresh_token: refreshToken });
  return makeSession(config, discovery, fetchImpl, tokens, null, keys, profile);
}

interface Tokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
  id_token?: string;
  cardboard_bundle?: string;
  cardboard_box?: string;
}

async function tokenRequest(config: SignInConfig, discovery: Discovery, fetchImpl: typeof fetch, form: Record<string, string>): Promise<Tokens> {
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  const body = new URLSearchParams({ ...form, client_id: config.clientId });
  if (config.clientSecret) headers["authorization"] = `Basic ${btoa(`${encodeURIComponent(config.clientId)}:${encodeURIComponent(config.clientSecret)}`)}`;
  const res = await fetchImpl(discovery.token_endpoint, { method: "POST", headers, body: body.toString() });
  const data = (await res.json()) as Tokens & { error?: string; error_description?: string };
  if (!res.ok) throw new CardboardError(data.error ?? "token_failed", res.status, data.error_description ?? "Cardboard refused the token request.");
  return data;
}

function makeSession(
  config: SignInConfig,
  discovery: Discovery,
  fetchImpl: typeof fetch,
  tokens: Tokens,
  nonce: string | null,
  keys: SessionKeys | null,
  profile: { name?: string; email?: string },
): CardboardSession {
  const claims = tokens.id_token ? decodeJwt(tokens.id_token) : {};
  if (tokens.id_token) {
    // Received straight from the token endpoint over TLS, so the claims are what matter (OIDC Core 3.1.3.7).
    if (claims["iss"] !== discovery.issuer) throw new CardboardError("bad_id_token", 0, "The ID token is from a different issuer.");
    if (claims["aud"] !== config.clientId) throw new CardboardError("bad_id_token", 0, "The ID token is for a different app.");
    if (nonce && claims["nonce"] !== nonce) throw new CardboardError("bad_id_token", 0, "The ID token's nonce doesn't match.");
  }
  let inflight: Promise<CardboardSession> | null = null;
  let box: Box | null = null;
  const name = profile.name ?? (typeof claims["name"] === "string" ? claims["name"] : undefined);
  const email = profile.email ?? (typeof claims["email"] === "string" ? claims["email"] : undefined);

  const session: CardboardSession = {
    user: { id: String(claims["sub"] ?? ""), ...(name ? { name } : {}), ...(email ? { email } : {}) },
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: Date.now() + tokens.expires_in * 1000,
    scopes: tokens.scope.split(" "),
    box() {
      if (!keys) {
        throw new CardboardError("no_box_scope", 0, "This sign-in didn't get a box.", 'Add "box" to scopes (the person can still say no).');
      }
      box ??= new Box({ url: discovery.issuer, tape: session.accessToken, keys, fetch: fetchImpl, refresh: async () => (await session.refresh()).accessToken });
      return box;
    },
    refresh() {
      inflight ??= tokenRequest(config, discovery, fetchImpl, { grant_type: "refresh_token", refresh_token: session.refreshToken })
        .then((fresh) => {
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
    save() {
      return JSON.stringify({
        refreshToken: session.refreshToken,
        keys: keys ? { boxId: keys.boxId, box: toB64u(keys.box), names: toB64u(keys.names) } : null,
        profile: { ...(name ? { name } : {}), ...(email ? { email } : {}) },
      });
    },
  };
  return session;
}

function randomString(bytes: number): string {
  return toB64u(globalThis.crypto.getRandomValues(new Uint8Array(bytes)));
}

async function challengeFor(verifier: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return toB64u(new Uint8Array(digest));
}

function decodeJwt(jwt: string): Record<string, unknown> {
  return JSON.parse(utf8.decode(fromB64u(jwt.split(".")[1] ?? ""))) as Record<string, unknown>;
}
