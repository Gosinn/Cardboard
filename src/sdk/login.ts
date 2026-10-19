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
 *
 * In a browser, pass `storage` (e.g. localStorage) instead of saving by hand:
 * the session stays up to date after every refresh, and tabs share it.
 */
import { ctx } from "../shared/contexts.ts";
import { exportPrivateKey, fromB64u, importPrivateKey, keyPair, openWith, toB64u, utf8 } from "../client/crypto.ts";
import { readBundle } from "../client/keys.ts";
import { Box, CardboardError } from "./index.ts";

export type SignInScope = "openid" | "profile" | "email" | "box";

/** Somewhere the session lives between page loads, e.g. localStorage. Holds the box key: keep it like a password. */
export interface SessionStorage {
  get(): string | null | Promise<string | null>;
  set(value: string): void | Promise<void>;
}

export interface SignInConfig {
  /** The person's Cardboard, e.g. https://cardboard.example.com */
  issuer: string;
  clientId: string;
  /** Only for apps with a server. Never put a client secret in a browser app. */
  clientSecret?: string;
  redirectUri: string;
  /** Defaults to ["openid", "box"]: recognise them, and keep your data about them in their Cardboard. */
  scopes?: SignInScope[];
  /**
   * Where to keep the session (e.g. `{ get: () => localStorage.getItem("cardboard"), set: (v) => localStorage.setItem("cardboard", v) }`).
   * It's rewritten after every refresh, and tabs take turns refreshing through it: refresh tokens
   * work once, and Cardboard disconnects an app that reuses one (that's how copied tokens get caught).
   */
  storage?: SessionStorage;
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

interface SessionState {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
  user: CardboardUser;
}

/** What session.save() writes (older saves had only refreshToken, keys and profile; a bare refresh token works too). */
interface SavedSession {
  refreshToken: string;
  accessToken?: string;
  expiresAt?: number;
  scopes?: string[];
  user?: CardboardUser;
  keys?: { boxId: string; box: string; names: string } | null;
  profile?: { name?: string; email?: string };
}

function parseSaved(raw: string | null | undefined): SavedSession | null {
  const text = raw?.trim();
  if (!text) return null;
  if (!text.startsWith("{")) return { refreshToken: text };
  try {
    const saved = JSON.parse(text) as SavedSession;
    return typeof saved.refreshToken === "string" ? saved : null;
  } catch {
    return null;
  }
}

/** Only one tab refreshes at a time (Web Locks, where the browser has them). */
function oneAtATime<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const locks = (globalThis as { navigator?: { locks?: { request(name: string, fn: () => Promise<T>): Promise<T> } } }).navigator?.locks;
  return locks ? locks.request(name, fn) : fn();
}

const EARLY_MS = 30_000;

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

/**
 * The invite in a link like https://yourapp.example/#cardboard_invite=cbi_…,
 * made in Cardboard with "Invite a friend to <your app>". Pass it to
 * startSignIn and a friend without a Cardboard account makes one on the way
 * in. Takes it out of the address bar, so it isn't bookmarked or shared on.
 */
export function takeInvite(): string | null {
  const g = globalThis as { location?: { hash: string; pathname: string; search: string }; history?: { replaceState(data: unknown, unused: string, url: string): void } };
  const loc = g.location;
  if (!loc) return null;
  const match = /[#&]cardboard_invite=(cbi_[A-Za-z0-9_-]{43})/.exec(loc.hash);
  if (!match) return null;
  const rest = loc.hash.replace(match[0], "").replace(/^[#&]+/, "");
  g.history?.replaceState(null, "", `${loc.pathname}${loc.search}${rest ? `#${rest}` : ""}`);
  return match[1]!;
}

export async function startSignIn(config: SignInConfig, options: { invite?: string | null } = {}): Promise<PendingSignIn> {
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
  // An invite for a friend who has no account yet: it stays in the fragment too, so only their browser sees it.
  if (options.invite) {
    const invite = /cbi_[A-Za-z0-9_-]{43}/.exec(options.invite)?.[0];
    if (!invite) throw new CardboardError("bad_invite", 0, "That doesn't look like a Cardboard invite.", "It starts with cbi_, as in the link #cardboard_invite=cbi_…");
    url.hash += `&invite=${invite}`;
  }
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
  const session = makeSession(config, discovery, fetchImpl, stateFrom(config, discovery, tokens, pending.nonce, profile), keys);
  await config.storage?.set(session.save());
  return session;
}

/**
 * Picks up where session.save() left off (after a page load, or your server
 * restarting). With `storage` in the config, `saved` can be left out. Uses the
 * saved access token while it's good, and refreshes only when it isn't.
 */
export async function resumeSession(config: SignInConfig, saved?: string | null): Promise<CardboardSession> {
  const fetchImpl = config.fetch ?? globalThis.fetch.bind(globalThis);
  const discovery = await discover(config.issuer, fetchImpl);
  const data = parseSaved(saved ?? (await config.storage?.get()) ?? null);
  if (!data) throw new CardboardError("not_signed_in", 0, "There's no saved Cardboard session.", "Sign in with Cardboard again.");
  const keys = data.keys ? { boxId: data.keys.boxId, box: fromB64u(data.keys.box), names: fromB64u(data.keys.names) } : null;
  const user: CardboardUser = data.user ?? { id: "", ...data.profile };
  const session = makeSession(config, discovery, fetchImpl, { accessToken: data.accessToken ?? "", refreshToken: data.refreshToken, expiresAt: data.expiresAt ?? 0, scopes: data.scopes ?? [], user }, keys);
  if (!data.accessToken || !user.id || session.expiresAt <= Date.now() + EARLY_MS) await session.refresh();
  return session;
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

/** Fresh tokens into session state, checking the ID token (if any) is really for this app. */
function stateFrom(config: SignInConfig, discovery: Discovery, tokens: Tokens, nonce: string | null, profile: { name?: string; email?: string }, previous?: CardboardUser): SessionState {
  const claims = tokens.id_token ? decodeJwt(tokens.id_token) : {};
  if (tokens.id_token) {
    // Received straight from the token endpoint over TLS, so the claims are what matter (OIDC Core 3.1.3.7).
    if (claims["iss"] !== discovery.issuer) throw new CardboardError("bad_id_token", 0, "The ID token is from a different issuer.");
    if (claims["aud"] !== config.clientId) throw new CardboardError("bad_id_token", 0, "The ID token is for a different app.");
    if (nonce && claims["nonce"] !== nonce) throw new CardboardError("bad_id_token", 0, "The ID token's nonce doesn't match.");
  }
  const name = profile.name ?? previous?.name ?? (typeof claims["name"] === "string" ? claims["name"] : undefined);
  const email = profile.email ?? previous?.email ?? (typeof claims["email"] === "string" ? claims["email"] : undefined);
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: Date.now() + tokens.expires_in * 1000,
    scopes: tokens.scope.split(" "),
    user: { id: typeof claims["sub"] === "string" ? claims["sub"] : (previous?.id ?? ""), ...(name ? { name } : {}), ...(email ? { email } : {}) },
  };
}

function makeSession(config: SignInConfig, discovery: Discovery, fetchImpl: typeof fetch, state: SessionState, keys: SessionKeys | null): CardboardSession {
  let inflight: Promise<CardboardSession> | null = null;
  let box: Box | null = null;
  const adopt = (next: SessionState) => {
    session.accessToken = next.accessToken;
    session.refreshToken = next.refreshToken;
    session.expiresAt = next.expiresAt;
    if (next.scopes.length) session.scopes = next.scopes;
    if (next.user.id) session.user = next.user;
  };

  const session: CardboardSession = {
    ...state,
    box() {
      if (!keys) {
        throw new CardboardError("no_box_scope", 0, "This sign-in didn't get a box.", 'Add "box" to scopes (the person can still say no).');
      }
      box ??= new Box({ url: discovery.issuer, tape: session.accessToken, keys, fetch: fetchImpl, refresh: async () => (await session.refresh()).accessToken });
      return box;
    },
    refresh() {
      inflight ??= oneAtATime(`cardboard-refresh:${config.issuer}:${config.clientId}`, async () => {
        if (config.storage) {
          // Another tab may have refreshed already: carry on with its tokens rather than reusing ours.
          const latest = parseSaved(await config.storage.get());
          if (latest?.accessToken && latest.refreshToken !== session.refreshToken) {
            adopt({ accessToken: latest.accessToken, refreshToken: latest.refreshToken, expiresAt: latest.expiresAt ?? 0, scopes: latest.scopes ?? [], user: latest.user ?? session.user });
            if (session.expiresAt > Date.now() + EARLY_MS) return session;
          }
        }
        const fresh = await tokenRequest(config, discovery, fetchImpl, { grant_type: "refresh_token", refresh_token: session.refreshToken });
        adopt(stateFrom(config, discovery, fresh, null, {}, session.user));
        await config.storage?.set(session.save());
        return session;
      }).finally(() => {
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
      await config.storage?.set("");
    },
    save() {
      const saved: SavedSession = {
        refreshToken: session.refreshToken,
        accessToken: session.accessToken,
        expiresAt: session.expiresAt,
        scopes: session.scopes,
        user: session.user,
        keys: keys ? { boxId: keys.boxId, box: toB64u(keys.box), names: toB64u(keys.names) } : null,
      };
      return JSON.stringify(saved);
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
