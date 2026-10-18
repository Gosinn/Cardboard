import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { fail } from "../shared/errors.ts";
import { base64url, hmac, newId, newSecret, sameBytes, seal, sha256, unseal } from "./crypto.ts";
import { getMeta, setMeta, transaction, type DB } from "./db.ts";
import type { ServerKeys } from "./setup.ts";
import type { Tapes } from "./tapes.ts";
import type { Vault } from "./vault.ts";

/**
 * Sign in with Cardboard: an OpenID Connect provider, so any app that supports
 * "generic OpenID Connect" can connect without custom code.
 *
 * What makes it Cardboard-shaped:
 *  - Every app gets a *private ID* for you (pairwise subject), so two apps can
 *    never match you up.
 *  - Apps that send their own public key (`cardboard_key`, the SDK does) can get
 *    a box in YOUR Cardboard (`box` scope) and your name/email. Your browser
 *    seals the box key and profile to the app's key; the server only relays the
 *    sealed bundle and never sees either.
 *  - OAuth 2.1 rules: PKCE (S256) always, exact redirect matching, one-time codes,
 *    rotating refresh tokens with reuse detection, ES256-signed ID tokens.
 *
 * Saying yes happens in your dashboard (it has your keys): /oauth/authorize
 * checks the request and sends your browser there.
 */

export const SCOPES = ["openid", "profile", "email", "box", "offline_access"] as const;
export type Scope = (typeof SCOPES)[number];

const ACCESS_TTL = 60 * 60 * 1000;
const REFRESH_IDLE = 30 * 24 * 60 * 60 * 1000;
const CODE_TTL = 60 * 1000;
const REQUEST_TTL = 10 * 60 * 1000;
const UNUSED_CLIENT_TTL = 7 * 24 * 60 * 60 * 1000;
const MAX_BUNDLE = 4096;

export interface Client {
  id: string;
  name: string;
  redirectUris: string[];
  clientUri: string | null;
  confidential: boolean;
  /** "self" (the app registered itself), "shake", or the account that added it. */
  registeredBy: string;
  createdAt: number;
  lastUsedAt: number | null;
}

export interface Grant {
  id: string;
  accountId: string;
  clientId: string;
  sector: string;
  scopes: Scope[];
  boxId: string | null;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

export interface AuthRequest {
  client: Client;
  redirectUri: string;
  /** Whether the app named redirect_uri (if not, it may leave it out of the token request too). */
  redirectUriGiven: boolean;
  scopes: Scope[];
  state: string | null;
  codeChallenge: string;
  nonce: string | null;
  prompt: string | null;
  /** The app's ECDH P-256 public key, if it can receive sealed things. */
  appKey: Buffer | null;
}

export type AuthorizeCheck =
  | { kind: "ok"; request: AuthRequest }
  | { kind: "page"; message: string; hint?: string }
  | { kind: "redirect"; location: string };

export interface TokenSet {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
  id_token?: string;
  /** The box key (and your name/email, if you allowed it), sealed by your browser to the app's own key. */
  cardboard_bundle?: string;
  cardboard_box?: string;
}

export interface Claims {
  name?: string;
  email?: string;
}

interface ClientRow {
  id: string;
  secret_hash: Uint8Array | null;
  name: string;
  redirect_uris: string;
  client_uri: string | null;
  registered_by: string;
  created_at: number;
  last_used_at: number | null;
}

interface GrantRow {
  id: string;
  account_id: string;
  client_id: string;
  sector: string;
  scopes: string;
  box_id: string | null;
  claims: Uint8Array | null;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

interface PendingCode {
  clientId: string;
  redirectUri: string;
  redirectUriGiven: boolean;
  codeChallenge: string;
  grantId: string;
  nonce: string | null;
  bundle: Buffer | null;
  authTime: number;
  expiresAt: number;
}

/** OAuth error, rendered as { error, error_description } by the token endpoint. */
export class OAuthError extends Error {
  readonly error: string;
  readonly status: number;
  constructor(error: string, description: string, status = 400) {
    super(description);
    this.error = error;
    this.status = status;
  }
}

export class OAuth {
  private readonly db: DB;
  private readonly vault: Vault;
  private readonly tapes: Tapes;
  private readonly issuer: () => string;
  private readonly keys: ServerKeys;
  private readonly codes = new Map<string, PendingCode>();
  private readonly usedCodes = new Map<string, { grantId: string; expiresAt: number }>();
  private readonly requests = new Map<string, { request: AuthRequest; expiresAt: number }>();
  private signingKey: { privateKey: KeyObject; jwk: Record<string, string> } | null = null;
  /** Called when a grant is revoked (so live streams of its tapes can be closed). */
  onRevoke: (tapeIds: string[]) => void = () => {};
  /** Called when something looks like an attack (a replayed code or refresh token). */
  onAlarm: (grant: Grant, message: string) => void = () => {};

  constructor(db: DB, vault: Vault, tapes: Tapes, keys: ServerKeys, issuer: () => string) {
    this.db = db;
    this.vault = vault;
    this.tapes = tapes;
    this.keys = keys;
    this.issuer = issuer;
  }

  private now() {
    return this.vault.now();
  }

  // ── Discovery & keys ─────────────────────────────────────────────────────

  discovery() {
    const iss = this.issuer();
    return {
      issuer: iss,
      authorization_endpoint: `${iss}/oauth/authorize`,
      token_endpoint: `${iss}/oauth/token`,
      userinfo_endpoint: `${iss}/oauth/userinfo`,
      jwks_uri: `${iss}/oauth/jwks`,
      registration_endpoint: `${iss}/oauth/register`,
      revocation_endpoint: `${iss}/oauth/revoke`,
      scopes_supported: [...SCOPES],
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      subject_types_supported: ["pairwise"],
      id_token_signing_alg_values_supported: ["ES256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"],
      claims_supported: ["sub", "iss", "aud", "exp", "iat", "auth_time", "nonce", "name", "email"],
      authorization_response_iss_parameter_supported: true,
      service_documentation: `${iss}/`,
    };
  }

  private key() {
    if (!this.signingKey) {
      const wrapKey = this.keys.subkey("oidc-signing-key");
      const stored = getMeta(this.db, "oidc_signing_key");
      let privateKey: KeyObject;
      if (stored) {
        privateKey = createPrivateKey({ key: unseal(wrapKey, Buffer.from(stored, "base64"), "oidc-key"), format: "der", type: "pkcs8" });
      } else {
        privateKey = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
        const der = privateKey.export({ format: "der", type: "pkcs8" });
        setMeta(this.db, "oidc_signing_key", seal(wrapKey, der, "oidc-key").toString("base64"));
      }
      const pub = createPublicKey(privateKey).export({ format: "jwk" }) as Record<string, string>;
      // RFC 7638 thumbprint: required members in lexicographic order.
      const kid = base64url(sha256(JSON.stringify({ crv: pub["crv"], kty: pub["kty"], x: pub["x"], y: pub["y"] }))).slice(0, 16);
      this.signingKey = { privateKey, jwk: { kty: pub["kty"]!, crv: pub["crv"]!, x: pub["x"]!, y: pub["y"]!, kid, use: "sig", alg: "ES256" } };
    }
    return this.signingKey;
  }

  jwks() {
    return { keys: [this.key().jwk] };
  }

  private signJwt(payload: Record<string, unknown>): string {
    const { privateKey, jwk } = this.key();
    const header = base64url(JSON.stringify({ alg: "ES256", typ: "JWT", kid: jwk["kid"] }));
    const body = base64url(JSON.stringify(payload));
    const signature = sign("sha256", Buffer.from(`${header}.${body}`), { key: privateKey, dsaEncoding: "ieee-p1363" });
    return `${header}.${body}.${base64url(signature)}`;
  }

  /** Your private ID at one app (well, one web origin). Stable for that app; meaningless anywhere else. */
  subjectFor(accountId: string, sector: string): string {
    return base64url(hmac(this.keys.subkey("oidc-subject"), `${accountId}|${sector}`)).slice(0, 27);
  }

  // ── Clients ──────────────────────────────────────────────────────────────

  /** RFC 7591 dynamic client registration, also used by people to add apps by hand. */
  register(meta: Record<string, unknown>, by: string): { client: Client; secret: string | null; response: Record<string, unknown> } {
    const bad = (description: string) => new OAuthError("invalid_client_metadata", description);
    const name = meta["client_name"] === undefined ? "Unnamed app" : meta["client_name"];
    if (typeof name !== "string" || name.trim().length === 0 || name.length > 80) throw bad("client_name must be 1 to 80 characters.");
    const uris = meta["redirect_uris"];
    if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10) throw new OAuthError("invalid_redirect_uri", "redirect_uris must list 1 to 10 URLs.");
    for (const uri of uris) {
      if (typeof uri !== "string" || !isAllowedRedirect(uri)) {
        throw new OAuthError(
          "invalid_redirect_uri",
          `${JSON.stringify(uri)} can't be a redirect URI. Use https://, http://localhost, or an app scheme like com.example.app:/callback.`,
        );
      }
    }
    const clientUri = meta["client_uri"];
    if (clientUri !== undefined && (typeof clientUri !== "string" || !/^https?:\/\//.test(clientUri) || clientUri.length > 300)) {
      throw bad("client_uri must be an http(s) URL.");
    }
    const method = meta["token_endpoint_auth_method"] ?? "client_secret_basic";
    if (method !== "none" && method !== "client_secret_basic" && method !== "client_secret_post") {
      throw bad("token_endpoint_auth_method must be none, client_secret_basic or client_secret_post.");
    }
    for (const [field, allowed] of [
      ["grant_types", ["authorization_code", "refresh_token"]],
      ["response_types", ["code"]],
    ] as const) {
      const value = meta[field];
      if (value !== undefined && (!Array.isArray(value) || value.some((v) => !(allowed as readonly string[]).includes(v)))) {
        throw bad(`${field} may only contain ${allowed.join(", ")}.`);
      }
    }

    const confidential = method !== "none";
    const secret = confidential ? newSecret("cbs") : null;
    const client: Client = {
      id: newId("cbc"),
      name: name.trim(),
      redirectUris: uris as string[],
      clientUri: (clientUri as string | undefined) ?? null,
      confidential,
      registeredBy: by,
      createdAt: this.now(),
      lastUsedAt: null,
    };
    this.db
      .prepare("INSERT INTO oauth_clients (id, secret_hash, name, redirect_uris, client_uri, registered_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(client.id, secret ? sha256(secret) : null, client.name, JSON.stringify(client.redirectUris), client.clientUri, by, client.createdAt);
    const response: Record<string, unknown> = {
      client_id: client.id,
      client_id_issued_at: Math.floor(client.createdAt / 1000),
      client_name: client.name,
      redirect_uris: client.redirectUris,
      token_endpoint_auth_method: method,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    };
    if (client.clientUri) response["client_uri"] = client.clientUri;
    if (secret) {
      response["client_secret"] = secret;
      response["client_secret_expires_at"] = 0;
    }
    return { client, secret, response };
  }

  client(id: string): Client | undefined {
    const row = this.db.prepare("SELECT * FROM oauth_clients WHERE id = ?").get(id) as ClientRow | undefined;
    return row && toClient(row);
  }

  /** Apps this account added by hand. */
  clientsOf(accountId: string): Client[] {
    return (this.db.prepare("SELECT * FROM oauth_clients WHERE registered_by = ? ORDER BY created_at DESC").all(accountId) as unknown as ClientRow[]).map(toClient);
  }

  /** Forgets an app you added: it can't sign anyone in any more. Apps that registered themselves just lose your connection. */
  forgetClient(accountId: string, id: string): Client {
    const client = this.client(id);
    if (!client || (client.registeredBy !== accountId && !this.grantsOf(id).some((g) => g.accountId === accountId))) {
      throw fail("no_such_app", 404, "Cardboard doesn't know that app.");
    }
    for (const grant of this.grantsOf(id)) if (grant.accountId === accountId) this.revokeGrant(grant.id);
    if (client.registeredBy === accountId) this.db.prepare("DELETE FROM oauth_clients WHERE id = ?").run(id);
    return client;
  }

  /** Checks client credentials at the token endpoint. */
  authenticateClient(clientId: string | undefined, secret: string | undefined): Client {
    const client = clientId ? this.client(clientId) : undefined;
    if (!client) throw new OAuthError("invalid_client", "Unknown client_id.", 401);
    if (client.confidential) {
      const row = this.db.prepare("SELECT secret_hash FROM oauth_clients WHERE id = ?").get(client.id) as { secret_hash: Uint8Array };
      if (!secret || !sameBytes(sha256(secret), row.secret_hash)) throw new OAuthError("invalid_client", "Wrong or missing client secret.", 401);
    }
    return client;
  }

  // ── Authorization requests ───────────────────────────────────────────────

  /**
   * Validates an authorization request. Problems with the client or redirect URI
   * are shown on Cardboard's own page: we never redirect to a URI we can't vouch for.
   */
  checkAuthorize(params: URLSearchParams): AuthorizeCheck {
    const clientId = params.get("client_id");
    const client = clientId ? this.client(clientId) : undefined;
    if (!client) return { kind: "page", message: "This sign-in link is for an app Cardboard doesn't know.", hint: "The app may need to register again." };
    const asked = params.get("redirect_uri");
    const redirectUri = asked ?? (client.redirectUris.length === 1 ? client.redirectUris[0]! : null);
    if (!redirectUri || !client.redirectUris.includes(redirectUri)) {
      return {
        kind: "page",
        message: `${client.name} asked Cardboard to send you somewhere it never registered.`,
        hint: "That's how sign-in links get hijacked, so Cardboard stopped here.",
      };
    }
    const state = params.get("state");
    const back = (error: string, description: string): AuthorizeCheck => ({
      kind: "redirect",
      location: this.redirectWith(redirectUri, { error, error_description: description, state }),
    });
    if (params.get("response_type") !== "code") return back("unsupported_response_type", "Cardboard only supports response_type=code.");
    const challenge = params.get("code_challenge");
    if (!challenge || params.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) {
      return back("invalid_request", "PKCE is required: send code_challenge with code_challenge_method=S256.");
    }
    const resource = params.get("resource");
    if (resource !== null && resource !== this.issuer()) return back("invalid_target", `Cardboard only issues tokens for ${this.issuer()}.`);
    const requested = (params.get("scope") ?? "openid").split(/\s+/).filter(Boolean);
    const scopes = SCOPES.filter((s) => requested.includes(s));
    if (scopes.length === 0) return back("invalid_scope", `Ask for at least one of: ${SCOPES.join(", ")}.`);
    let appKey: Buffer | null = null;
    const key = params.get("cardboard_key");
    if (key !== null) {
      appKey = /^[A-Za-z0-9_-]{87}$/.test(key) ? Buffer.from(key, "base64url") : null;
      if (!appKey || appKey.length !== 65 || appKey[0] !== 4) return back("invalid_request", "cardboard_key must be a P-256 public key (65 bytes, base64url).");
    }
    if (scopes.includes("box") && !appKey) {
      return back("invalid_scope", "The box scope needs cardboard_key: your app's public key, so the box key can be sealed to it. The Cardboard SDK sends it for you.");
    }
    return {
      kind: "ok",
      request: { client, redirectUri, redirectUriGiven: asked !== null, scopes, state, codeChallenge: challenge, nonce: params.get("nonce"), prompt: params.get("prompt"), appKey },
    };
  }

  /** Parks a checked request while your dashboard asks you about it. */
  startRequest(request: AuthRequest): string {
    const id = randomBytes(18).toString("base64url");
    this.requests.set(id, { request, expiresAt: this.now() + REQUEST_TTL });
    return id;
  }

  pendingRequest(id: string): AuthRequest {
    const entry = this.requests.get(id);
    if (!entry || entry.expiresAt <= this.now()) {
      throw fail("no_such_request", 404, "That sign-in request expired.", "Go back to the app and start signing in again.");
    }
    return entry.request;
  }

  finishRequest(id: string) {
    this.requests.delete(id);
  }

  redirectWith(redirectUri: string, params: Record<string, string | null | undefined>): string {
    const url = new URL(redirectUri);
    for (const [key, value] of Object.entries(params)) {
      if (value !== null && value !== undefined) url.searchParams.set(key, value);
    }
    url.searchParams.set("iss", this.issuer());
    return url.toString();
  }

  /** The web origin an app signs in from: it decides your private ID there and which box it gets back. */
  sectorOf(redirectUri: string): string {
    const url = new URL(redirectUri);
    return url.origin === "null" ? redirectUri.split(":")[0]! : url.origin;
  }

  /** This account's active grant for a client, if any. */
  activeGrant(accountId: string, clientId: string): Grant | undefined {
    return this.grantsOf(clientId).find((g) => g.accountId === accountId && g.revokedAt === null);
  }

  /** The box an app from this origin had before, so reconnecting gets the same box back. */
  previousBox(accountId: string, sector: string): string | null {
    const rows = this.db
      .prepare("SELECT box_id FROM oauth_grants WHERE account_id = ? AND sector = ? AND box_id IS NOT NULL ORDER BY created_at DESC")
      .all(accountId, sector) as Array<{ box_id: string }>;
    for (const row of rows) if (this.vault.box(row.box_id)?.accountId === accountId) return row.box_id;
    return null;
  }

  /**
   * You said yes. Creates or widens the grant. For the `box` scope your device
   * picked (or made) the box and sealed its key to the app; `claims` is a
   * name/email you chose to pass in the clear to an app that can't take sealed data.
   */
  consent(accountId: string, request: Pick<AuthRequest, "client" | "redirectUri" | "scopes">, options: { boxId?: string | null; claims?: Claims | null } = {}): Grant {
    const { client, redirectUri, scopes } = request;
    const sector = this.sectorOf(redirectUri);
    return transaction(this.db, () => {
      const existing = this.activeGrant(accountId, client.id);
      const now = this.now();
      let grant: Grant;
      if (existing) {
        const merged = SCOPES.filter((s) => existing.scopes.includes(s) || scopes.includes(s));
        this.db.prepare("UPDATE oauth_grants SET scopes = ? WHERE id = ?").run(merged.join(" "), existing.id);
        grant = { ...existing, scopes: merged };
      } else {
        grant = { id: newId("grant"), accountId, clientId: client.id, sector, scopes, boxId: null, createdAt: now, lastUsedAt: null, revokedAt: null };
        this.db
          .prepare("INSERT INTO oauth_grants (id, account_id, client_id, sector, scopes, created_at) VALUES (?, ?, ?, ?, ?, ?)")
          .run(grant.id, accountId, client.id, sector, scopes.join(" "), now);
      }
      if (options.boxId) {
        this.vault.ownBox(accountId, options.boxId);
        this.db.prepare("UPDATE oauth_grants SET box_id = ? WHERE id = ?").run(options.boxId, grant.id);
        grant = { ...grant, boxId: options.boxId };
      }
      if (options.claims !== undefined) {
        const sealed = options.claims && Object.keys(options.claims).length > 0 ? seal(this.keys.subkey("oidc-claims"), JSON.stringify(options.claims), `claims|${grant.id}`) : null;
        this.db.prepare("UPDATE oauth_grants SET claims = ? WHERE id = ?").run(sealed, grant.id);
      }
      return grant;
    });
  }

  issueCode(grant: Grant, request: Pick<AuthRequest, "client" | "redirectUri" | "codeChallenge" | "nonce" | "redirectUriGiven">, authTime: number, bundle: Buffer | null): string {
    if (bundle && bundle.length > MAX_BUNDLE) throw fail("too_large", 413, "That sealed bundle is too large.");
    const code = randomBytes(32).toString("base64url");
    this.codes.set(sha256(code).toString("hex"), {
      clientId: request.client.id,
      redirectUri: request.redirectUri,
      redirectUriGiven: request.redirectUriGiven,
      codeChallenge: request.codeChallenge,
      grantId: grant.id,
      nonce: request.nonce,
      bundle,
      authTime,
      expiresAt: this.now() + CODE_TTL,
    });
    return code;
  }

  // ── Tokens ───────────────────────────────────────────────────────────────

  exchangeCode(input: { code?: string; redirectUri?: string; verifier?: string; clientId?: string; clientSecret?: string }): TokenSet {
    const client = this.authenticateClient(input.clientId, input.clientSecret);
    if (!input.code) throw new OAuthError("invalid_request", "code is required.");
    const id = sha256(input.code).toString("hex");
    const pending = this.codes.get(id);
    if (!pending) {
      const used = this.usedCodes.get(id);
      if (used) {
        // A code used twice means someone else has it: revoke what it produced.
        this.revokeTokens(used.grantId);
        const grant = this.grant(used.grantId);
        if (grant) this.onAlarm(grant, `A sign-in code for ${client.name} was used twice. Cardboard revoked the tokens it produced.`);
        throw new OAuthError("invalid_grant", "That code was already used. Cardboard revoked the tokens it produced, to be safe.");
      }
      throw new OAuthError("invalid_grant", "That code is unknown or expired.");
    }
    this.codes.delete(id);
    this.usedCodes.set(id, { grantId: pending.grantId, expiresAt: this.now() + 10 * 60 * 1000 });
    if (pending.expiresAt <= this.now()) throw new OAuthError("invalid_grant", "That code expired. Codes last one minute.");
    if (pending.clientId !== client.id) throw new OAuthError("invalid_grant", "That code was issued to a different app.");
    if (input.redirectUri !== undefined ? input.redirectUri !== pending.redirectUri : pending.redirectUriGiven) {
      throw new OAuthError("invalid_grant", "redirect_uri doesn't match the one used to sign in.");
    }
    const verifier = input.verifier ?? "";
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || base64url(sha256(verifier)) !== pending.codeChallenge) {
      throw new OAuthError("invalid_grant", "PKCE check failed: code_verifier doesn't match the code_challenge.");
    }
    const grant = this.grant(pending.grantId);
    if (!grant || grant.revokedAt !== null) throw new OAuthError("invalid_grant", "You disconnected this app.");
    const tokens = this.issueTokens(grant, client, { nonce: pending.nonce, authTime: pending.authTime });
    if (pending.bundle) tokens.cardboard_bundle = pending.bundle.toString("base64url");
    return tokens;
  }

  refresh(input: { refreshToken?: string; clientId?: string; clientSecret?: string }): TokenSet {
    const client = this.authenticateClient(input.clientId, input.clientSecret);
    const row = input.refreshToken
      ? (this.db.prepare("SELECT * FROM oauth_tokens WHERE hash = ? AND kind = 'refresh'").get(sha256(input.refreshToken)) as
          | { grant_id: string; expires_at: number; used_at: number | null }
          | undefined)
      : undefined;
    if (!row) throw new OAuthError("invalid_grant", "Unknown refresh token.");
    const grant = this.grant(row.grant_id);
    if (!grant || grant.clientId !== client.id) throw new OAuthError("invalid_grant", "That refresh token belongs to a different app.");
    if (row.used_at !== null) {
      // Refresh tokens rotate, so a second use means it was copied. Disconnect the app.
      this.revokeGrant(grant.id);
      this.onAlarm(grant, `A refresh token for ${client.name} was used twice, so Cardboard disconnected it.`);
      throw new OAuthError("invalid_grant", "That refresh token was already used, so Cardboard disconnected the app to be safe. Sign in again.");
    }
    if (grant.revokedAt !== null) throw new OAuthError("invalid_grant", "You disconnected this app.");
    if (row.expires_at <= this.now()) throw new OAuthError("invalid_grant", "The connection went unused for 30 days and expired. Sign in again.");
    this.db.prepare("UPDATE oauth_tokens SET used_at = ? WHERE hash = ?").run(this.now(), sha256(input.refreshToken!));
    return this.issueTokens(grant, client, { nonce: null, authTime: null });
  }

  private issueTokens(grant: Grant, client: Client, ctx: { nonce: string | null; authTime: number | null }): TokenSet {
    const now = this.now();
    const box = grant.boxId ? this.vault.box(grant.boxId) : undefined;
    // With a box, the access token is a short-lived tape for it (token half only: the app got the key sealed).
    const access = newSecret("cbt");
    if (box) {
      this.tapes.create(grant.accountId, box.id, {
        tokenHash: sha256(access),
        bundle: null,
        label: null,
        kind: "grant",
        idleMs: null,
        expiresAt: now + ACCESS_TTL,
        grantId: grant.id,
      });
    }
    const refresh = newSecret("cbr");
    const insert = this.db.prepare("INSERT INTO oauth_tokens (hash, grant_id, kind, expires_at, created_at) VALUES (?, ?, ?, ?, ?)");
    insert.run(sha256(access), grant.id, "access", now + ACCESS_TTL, now);
    insert.run(sha256(refresh), grant.id, "refresh", now + REFRESH_IDLE, now);
    this.db.prepare("UPDATE oauth_grants SET last_used_at = ? WHERE id = ?").run(now, grant.id);
    this.db.prepare("UPDATE oauth_clients SET last_used_at = ? WHERE id = ?").run(now, client.id);

    const tokens: TokenSet = { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL / 1000, refresh_token: refresh, scope: grant.scopes.join(" ") };
    if (box) tokens.cardboard_box = box.id;
    if (grant.scopes.includes("openid")) {
      tokens.id_token = this.signJwt({
        iss: this.issuer(),
        sub: this.subjectFor(grant.accountId, grant.sector),
        aud: client.id,
        iat: Math.floor(now / 1000),
        exp: Math.floor((now + ACCESS_TTL) / 1000),
        ...(ctx.authTime ? { auth_time: Math.floor(ctx.authTime / 1000) } : {}),
        ...(ctx.nonce ? { nonce: ctx.nonce } : {}),
        ...this.claims(grant),
      });
    }
    return tokens;
  }

  /** Only what you chose to pass in the clear. Apps with a key get your profile sealed instead. */
  private claims(grant: Grant): Claims {
    const row = this.db.prepare("SELECT claims FROM oauth_grants WHERE id = ?").get(grant.id) as { claims: Uint8Array | null } | undefined;
    if (!row?.claims) return {};
    const all = JSON.parse(unseal(this.keys.subkey("oidc-claims"), row.claims, `claims|${grant.id}`).toString()) as Claims;
    const out: Claims = {};
    if (grant.scopes.includes("profile") && all.name) out.name = all.name;
    if (grant.scopes.includes("email") && all.email) out.email = all.email;
    return out;
  }

  /** The grant behind a valid, unexpired access token. */
  checkAccess(token: string | null): Grant {
    const row = token
      ? (this.db.prepare("SELECT * FROM oauth_tokens WHERE hash = ? AND kind = 'access'").get(sha256(token)) as { grant_id: string; expires_at: number } | undefined)
      : undefined;
    const grant = row ? this.grant(row.grant_id) : undefined;
    if (!row || !grant || grant.revokedAt !== null || row.expires_at <= this.now()) {
      throw new OAuthError("invalid_token", "The access token is invalid or expired.", 401);
    }
    return grant;
  }

  userinfo(token: string | null): Record<string, string> {
    const grant = this.checkAccess(token);
    return { sub: this.subjectFor(grant.accountId, grant.sector), ...this.claims(grant) };
  }

  /** RFC 7009. Revoking a refresh token disconnects the app; an access token, just that token. */
  revokeToken(token: string, clientId?: string) {
    const row = this.db.prepare("SELECT * FROM oauth_tokens WHERE hash = ?").get(sha256(token)) as { grant_id: string; kind: string } | undefined;
    if (!row) return;
    const grant = this.grant(row.grant_id);
    if (clientId && grant && grant.clientId !== clientId) return;
    if (row.kind === "refresh") {
      this.revokeGrant(row.grant_id);
    } else {
      this.db.prepare("DELETE FROM oauth_tokens WHERE hash = ?").run(sha256(token));
      const tape = this.db.prepare("SELECT id FROM tapes WHERE token_hash = ?").get(sha256(token)) as { id: string } | undefined;
      if (tape) {
        this.tapes.revoke(tape.id);
        this.onRevoke([tape.id]);
      }
    }
  }

  private revokeTokens(grantId: string) {
    this.db.prepare("DELETE FROM oauth_tokens WHERE grant_id = ?").run(grantId);
    this.onRevoke(this.tapes.revokeGrant(grantId));
  }

  /** Disconnects an app: the grant and every token it ever got stop working now. */
  revokeGrant(grantId: string) {
    this.db.prepare("UPDATE oauth_grants SET revoked_at = COALESCE(revoked_at, ?), claims = NULL WHERE id = ?").run(this.now(), grantId);
    this.revokeTokens(grantId);
  }

  grant(id: string): Grant | undefined {
    const row = this.db.prepare("SELECT * FROM oauth_grants WHERE id = ?").get(id) as GrantRow | undefined;
    return row && toGrant(row);
  }

  grantsOf(clientId: string): Grant[] {
    return (this.db.prepare("SELECT * FROM oauth_grants WHERE client_id = ? ORDER BY created_at DESC").all(clientId) as unknown as GrantRow[]).map(toGrant);
  }

  /** An account's active connections, newest first. */
  grants(accountId: string): Array<Grant & { client: Client }> {
    const rows = this.db
      .prepare("SELECT * FROM oauth_grants WHERE account_id = ? AND revoked_at IS NULL ORDER BY created_at DESC")
      .all(accountId) as unknown as GrantRow[];
    return rows.map((row) => ({ ...toGrant(row), client: this.client(row.client_id)! }));
  }

  // ── Housekeeping ─────────────────────────────────────────────────────────

  sweep() {
    const now = this.now();
    for (const [id, code] of this.codes) if (code.expiresAt <= now) this.codes.delete(id);
    for (const [id, used] of this.usedCodes) if (used.expiresAt <= now) this.usedCodes.delete(id);
    for (const [id, entry] of this.requests) if (entry.expiresAt <= now) this.requests.delete(id);
    this.db.prepare("DELETE FROM oauth_tokens WHERE expires_at <= ?").run(now - 24 * 60 * 60 * 1000);
    // Apps that registered themselves but never got a yes are forgotten after a week.
    this.db
      .prepare(
        `DELETE FROM oauth_clients WHERE registered_by = 'self' AND created_at < ?
         AND NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.client_id = oauth_clients.id)`,
      )
      .run(now - UNUSED_CLIENT_TTL);
    this.tapes.sweepGrantTapes();
  }
}

/** https anywhere, http only on this machine, or a native app scheme with a dot (RFC 8252). */
export function isAllowedRedirect(uri: string): boolean {
  if (uri.length > 500 || uri.includes("#")) return false;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  if (url.protocol === "http:") return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  return /^[a-z][a-z0-9+-]*(\.[a-z0-9+-]+)+:$/.test(url.protocol);
}

function toClient(row: ClientRow): Client {
  return {
    id: row.id,
    name: row.name,
    redirectUris: JSON.parse(row.redirect_uris) as string[],
    clientUri: row.client_uri,
    confidential: row.secret_hash !== null,
    registeredBy: row.registered_by,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

function toGrant(row: GrantRow): Grant {
  return {
    id: row.id,
    accountId: row.account_id,
    clientId: row.client_id,
    sector: row.sector,
    scopes: row.scopes.split(" ").filter(Boolean) as Scope[],
    boxId: row.box_id,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}
