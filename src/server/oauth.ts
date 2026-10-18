import { createHmac, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { fail } from "../shared/errors.ts";
import { base64url, newId, newSecret, sameBytes, seal, sha256, unseal } from "./crypto.ts";
import { getMeta, setMeta, transaction, type DB } from "./db.ts";
import type { Tapes } from "./tapes.ts";
import type { Box, Vault } from "./vault.ts";

/**
 * Sign in with Cardboard: an OpenID Connect provider, so any app that supports
 * "generic OpenID Connect" (most auth libraries and self-hosted apps do) can
 * connect without custom code.
 *
 * What makes it Cardboard-shaped:
 *  - Every app gets a *private ID* for you (pairwise subject): an HMAC of the
 *    app's web origin, so two apps can never match you up.
 *  - With the `box` scope, the app keeps its data about you in a box in YOUR
 *    Cardboard instead of its own database. Disconnect any time, shred if you like.
 *  - OAuth 2.1 rules: PKCE (S256) always, exact redirect matching, one-time codes,
 *    rotating refresh tokens with reuse detection, ES256-signed ID tokens.
 */

export const SCOPES = ["openid", "profile", "email", "box", "offline_access"] as const;
export type Scope = (typeof SCOPES)[number];

const ACCESS_TTL = 60 * 60 * 1000;
const REFRESH_IDLE = 30 * 24 * 60 * 60 * 1000;
const CODE_TTL = 60 * 1000;
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000;
const UNUSED_CLIENT_TTL = 7 * 24 * 60 * 60 * 1000;

export interface Client {
  id: string;
  name: string;
  redirectUris: string[];
  clientUri: string | null;
  confidential: boolean;
  registeredBy: "self" | "owner" | "shake";
  createdAt: number;
  lastUsedAt: number | null;
}

export interface Grant {
  id: string;
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
  redirectUriGiven?: boolean;
  scopes: Scope[];
  state: string | null;
  codeChallenge: string;
  nonce: string | null;
  prompt: string | null;
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
}

export interface OwnerProfile {
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
  client_id: string;
  sector: string;
  scopes: string;
  box_id: string | null;
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
  private readonly codes = new Map<string, PendingCode>();
  private readonly usedCodes = new Map<string, { grantId: string; expiresAt: number }>();
  private readonly subjectKey: Buffer;
  private readonly csrfKey: Buffer;
  private signingKey: { privateKey: KeyObject; jwk: Record<string, string> } | null = null;
  /** Called when a grant is revoked (so live streams of its tapes can be closed). */
  onRevoke: (tapeIds: string[]) => void = () => {};
  /** Called when something looks like an attack (a replayed code or refresh token). */
  onAlarm: (message: string) => void = () => {};

  constructor(db: DB, vault: Vault, tapes: Tapes, issuer: () => string) {
    this.db = db;
    this.vault = vault;
    this.tapes = tapes;
    this.issuer = issuer;
    this.subjectKey = vault.systemSubkey("oidc-subject");
    this.csrfKey = vault.systemSubkey("oidc-csrf");
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
      const wrapKey = this.vault.systemSubkey("oidc-signing-key");
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
  subjectFor(sector: string): string {
    return base64url(createHmac("sha256", this.subjectKey).update(sector).digest()).slice(0, 27);
  }

  // ── Owner profile (what apps may see, if you allow it) ───────────────────

  profile(): OwnerProfile {
    const stored = getMeta(this.db, "owner_profile");
    if (!stored) return {};
    return JSON.parse(unseal(this.vault.systemSubkey("owner-profile"), Buffer.from(stored, "base64"), "owner-profile").toString()) as OwnerProfile;
  }

  setProfile(patch: Record<string, unknown>): OwnerProfile {
    const next: OwnerProfile = { ...this.profile() };
    for (const [field, value] of Object.entries(patch)) {
      if (field !== "name" && field !== "email") throw fail("bad_profile", 400, `Unknown profile field "${field}". Use name and email.`);
      if (value === null || value === "") {
        delete next[field];
        continue;
      }
      if (typeof value !== "string" || value.length > 120) throw fail("bad_profile", 400, `\`${field}\` must be text of at most 120 characters.`);
      if (field === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw fail("bad_profile", 400, "That doesn't look like an email address.");
      next[field] = value;
    }
    setMeta(this.db, "owner_profile", seal(this.vault.systemSubkey("owner-profile"), JSON.stringify(next), "owner-profile").toString("base64"));
    return next;
  }

  // ── Clients ──────────────────────────────────────────────────────────────

  /** RFC 7591 dynamic client registration, also used by the owner to add apps by hand. */
  register(meta: Record<string, unknown>, by: Client["registeredBy"]): { client: Client; secret: string | null; response: Record<string, unknown> } {
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
      .prepare(
        "INSERT INTO oauth_clients (id, secret_hash, name, redirect_uris, client_uri, registered_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
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

  clients(): Client[] {
    return (this.db.prepare("SELECT * FROM oauth_clients WHERE registered_by != 'shake' ORDER BY created_at DESC").all() as unknown as ClientRow[]).map(toClient);
  }

  forgetClient(id: string) {
    for (const grant of this.grantsOf(id)) this.revokeGrant(grant.id);
    this.db.prepare("DELETE FROM oauth_clients WHERE id = ?").run(id);
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
    const requested = (params.get("scope") ?? "openid").split(/\s+/).filter(Boolean);
    const scopes = SCOPES.filter((s) => requested.includes(s));
    if (scopes.length === 0) return back("invalid_scope", `Ask for at least one of: ${SCOPES.join(", ")}.`);
    return {
      kind: "ok",
      request: {
        client,
        redirectUri,
        redirectUriGiven: asked !== null,
        scopes,
        state,
        codeChallenge: challenge,
        nonce: params.get("nonce"),
        prompt: params.get("prompt"),
      },
    };
  }

  redirectWith(redirectUri: string, params: Record<string, string | null | undefined>): string {
    const url = new URL(redirectUri);
    for (const [key, value] of Object.entries(params)) {
      if (value !== null && value !== undefined) url.searchParams.set(key, value);
    }
    url.searchParams.set("iss", this.issuer());
    return url.toString();
  }

  /** An active grant for this client that already covers every scope asked for. */
  existingGrant(clientId: string, scopes: Scope[]): Grant | undefined {
    return this.grantsOf(clientId).find((g) => g.revokedAt === null && scopes.every((s) => g.scopes.includes(s)));
  }

  /**
   * You said yes. Creates or widens the grant, and for the `box` scope gives the
   * app a box (the same one again if this app has been connected before).
   */
  consent(request: Pick<AuthRequest, "client" | "redirectUri" | "scopes">, options: { internal?: boolean } = {}): Grant {
    const { client, redirectUri, scopes } = request;
    const sector = new URL(redirectUri).origin === "null" ? redirectUri.split(":")[0]! : new URL(redirectUri).origin;
    return transaction(this.db, () => {
      const existing = this.grantsOf(client.id).find((g) => g.revokedAt === null);
      const now = this.now();
      let grant: Grant;
      if (existing) {
        const merged = SCOPES.filter((s) => existing.scopes.includes(s) || scopes.includes(s));
        this.db.prepare("UPDATE oauth_grants SET scopes = ? WHERE id = ?").run(merged.join(" "), existing.id);
        grant = { ...existing, scopes: merged };
      } else {
        grant = { id: newId("grant"), clientId: client.id, sector, scopes, boxId: null, createdAt: now, lastUsedAt: null, revokedAt: null };
        this.db
          .prepare("INSERT INTO oauth_grants (id, client_id, sector, scopes, created_at) VALUES (?, ?, ?, ?, ?)")
          .run(grant.id, client.id, sector, scopes.join(" "), now);
      }
      if (grant.scopes.includes("box") && !(grant.boxId && this.vault.getBox(grant.boxId))) {
        const box = this.previousBox(sector) ?? this.newAppBox(client, options.internal);
        this.db.prepare("UPDATE oauth_grants SET box_id = ? WHERE id = ?").run(box.id, grant.id);
        grant = { ...grant, boxId: box.id };
      }
      return grant;
    });
  }

  private previousBox(sector: string): Box | undefined {
    const rows = this.db
      .prepare("SELECT box_id FROM oauth_grants WHERE sector = ? AND box_id IS NOT NULL ORDER BY created_at DESC")
      .all(sector) as Array<{ box_id: string }>;
    for (const row of rows) {
      const box = this.vault.getBox(row.box_id);
      if (box) return box;
    }
    return undefined;
  }

  private newAppBox(client: Client, internal = false): Box {
    const base = internal ? `__shake-oauth-${randomBytes(3).toString("hex")}` : slug(client.name);
    let name = base;
    for (let i = 2; this.vault.findBox(name); i++) name = `${base.slice(0, 58)}-${i}`;
    const box = this.vault.createBox(name, { system: internal });
    this.vault.updateProfile(box.id, { title: client.name, ...(client.clientUri ? { url: client.clientUri } : {}) });
    return box;
  }

  issueCode(grant: Grant, request: Pick<AuthRequest, "client" | "redirectUri" | "codeChallenge" | "nonce" | "redirectUriGiven">, authTime: number): string {
    const code = randomBytes(32).toString("base64url");
    this.codes.set(sha256(code).toString("hex"), {
      clientId: request.client.id,
      redirectUri: request.redirectUri,
      redirectUriGiven: request.redirectUriGiven ?? true,
      codeChallenge: request.codeChallenge,
      grantId: grant.id,
      nonce: request.nonce,
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
        this.onAlarm(`A sign-in code for ${client.name} was used twice. Cardboard revoked the tokens it produced.`);
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
    return this.issueTokens(grant, client, { nonce: pending.nonce, authTime: pending.authTime });
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
      this.onAlarm(`A refresh token for ${client.name} was used twice, so Cardboard disconnected it.`);
      throw new OAuthError("invalid_grant", "That refresh token was already used, so Cardboard disconnected the app to be safe. Sign in again.");
    }
    if (grant.revokedAt !== null) throw new OAuthError("invalid_grant", "You disconnected this app.");
    if (row.expires_at <= this.now()) throw new OAuthError("invalid_grant", "The connection went unused for 30 days and expired. Sign in again.");
    this.db.prepare("UPDATE oauth_tokens SET used_at = ? WHERE hash = ?").run(this.now(), sha256(input.refreshToken!));
    return this.issueTokens(grant, client, { nonce: null, authTime: null });
  }

  private issueTokens(grant: Grant, client: Client, ctx: { nonce: string | null; authTime: number | null }): TokenSet {
    const now = this.now();
    let box = grant.boxId ? this.vault.getBox(grant.boxId) : undefined;
    if (!box && grant.scopes.includes("box")) {
      // You shredded its box but kept it connected: it starts over with an empty one.
      box = this.newAppBox(client, client.registeredBy === "shake");
      this.db.prepare("UPDATE oauth_grants SET box_id = ? WHERE id = ?").run(box.id, grant.id);
    }
    const access = box
      ? this.tapes.create(box.id, { label: `signed in: ${client.name}`.slice(0, 60), idleMs: null, expiresAt: now + ACCESS_TTL, grantId: grant.id }).secret
      : newSecret("cbt");
    const refresh = newSecret("cbr");
    const insert = this.db.prepare("INSERT INTO oauth_tokens (hash, grant_id, kind, expires_at, created_at) VALUES (?, ?, ?, ?, ?)");
    insert.run(sha256(access), grant.id, "access", now + ACCESS_TTL, now);
    insert.run(sha256(refresh), grant.id, "refresh", now + REFRESH_IDLE, now);
    this.db.prepare("UPDATE oauth_grants SET last_used_at = ? WHERE id = ?").run(now, grant.id);
    this.db.prepare("UPDATE oauth_clients SET last_used_at = ? WHERE id = ?").run(now, client.id);

    const tokens: TokenSet = {
      access_token: access,
      token_type: "Bearer",
      expires_in: ACCESS_TTL / 1000,
      refresh_token: refresh,
      scope: grant.scopes.join(" "),
    };
    if (grant.scopes.includes("openid")) {
      tokens.id_token = this.signJwt({
        iss: this.issuer(),
        sub: this.subjectFor(grant.sector),
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

  private claims(grant: Grant): Record<string, string> {
    const profile = this.profile();
    const out: Record<string, string> = {};
    if (grant.scopes.includes("profile") && profile.name) out["name"] = profile.name;
    if (grant.scopes.includes("email") && profile.email) out["email"] = profile.email;
    return out;
  }

  /** The grant behind a valid, unexpired access token. */
  checkAccess(token: string | null): Grant {
    const row = token
      ? (this.db.prepare("SELECT * FROM oauth_tokens WHERE hash = ? AND kind = 'access'").get(sha256(token)) as
          | { grant_id: string; expires_at: number }
          | undefined)
      : undefined;
    const grant = row ? this.grant(row.grant_id) : undefined;
    if (!row || !grant || grant.revokedAt !== null || row.expires_at <= this.now()) {
      throw new OAuthError("invalid_token", "The access token is invalid or expired.", 401);
    }
    return grant;
  }

  userinfo(token: string | null): Record<string, string> {
    const grant = this.checkAccess(token);
    return { sub: this.subjectFor(grant.sector), ...this.claims(grant) };
  }

  /** RFC 7009. Revoking a refresh token disconnects the app; an access token, just that token. */
  revokeToken(token: string, clientId?: string) {
    const row = this.db.prepare("SELECT * FROM oauth_tokens WHERE hash = ?").get(sha256(token)) as
      | { grant_id: string; kind: string }
      | undefined;
    if (!row) return;
    const grant = this.grant(row.grant_id);
    if (clientId && grant && grant.clientId !== clientId) return;
    if (row.kind === "refresh") {
      this.revokeGrant(row.grant_id);
    } else {
      this.db.prepare("DELETE FROM oauth_tokens WHERE hash = ?").run(sha256(token));
      const tape = this.db.prepare("SELECT id FROM tapes WHERE secret_hash = ?").get(sha256(token)) as { id: string } | undefined;
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
    this.db.prepare("UPDATE oauth_grants SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?").run(this.now(), grantId);
    this.revokeTokens(grantId);
  }

  grant(id: string): Grant | undefined {
    const row = this.db.prepare("SELECT * FROM oauth_grants WHERE id = ?").get(id) as GrantRow | undefined;
    return row && toGrant(row);
  }

  grantsOf(clientId: string): Grant[] {
    return (this.db.prepare("SELECT * FROM oauth_grants WHERE client_id = ? ORDER BY created_at DESC").all(clientId) as unknown as GrantRow[]).map(
      toGrant,
    );
  }

  /** Active connections, newest first. */
  grants(): Array<Grant & { client: Client }> {
    const rows = this.db
      .prepare(
        `SELECT g.* FROM oauth_grants g JOIN oauth_clients c ON c.id = g.client_id
         WHERE g.revoked_at IS NULL AND c.registered_by != 'shake' ORDER BY g.created_at DESC`,
      )
      .all() as unknown as GrantRow[];
    return rows.map((row) => ({ ...toGrant(row), client: this.client(row.client_id)! }));
  }

  // ── Browser sessions (for the sign-in and consent pages) ─────────────────

  createSession(): string {
    const value = newSecret("cbk");
    const now = this.now();
    this.db.prepare("INSERT INTO sessions (hash, created_at, expires_at) VALUES (?, ?, ?)").run(sha256(value), now, now + SESSION_TTL);
    return value;
  }

  checkSession(value: string | undefined): { hash: string; createdAt: number } | null {
    if (!value) return null;
    const row = this.db.prepare("SELECT * FROM sessions WHERE hash = ?").get(sha256(value)) as
      | { created_at: number; expires_at: number }
      | undefined;
    if (!row || row.expires_at <= this.now()) return null;
    this.db.prepare("UPDATE sessions SET last_seen_at = ? WHERE hash = ?").run(this.now(), sha256(value));
    return { hash: sha256(value).toString("hex"), createdAt: row.created_at };
  }

  endSession(value: string | undefined) {
    if (value) this.db.prepare("DELETE FROM sessions WHERE hash = ?").run(sha256(value));
  }

  /** Ties the consent form to this browser session and app. */
  csrf(sessionHash: string, clientId: string): string {
    return base64url(createHmac("sha256", this.csrfKey).update(`${sessionHash}|${clientId}`).digest());
  }

  // ── Housekeeping ─────────────────────────────────────────────────────────

  sweep() {
    const now = this.now();
    for (const [id, code] of this.codes) if (code.expiresAt <= now) this.codes.delete(id);
    for (const [id, used] of this.usedCodes) if (used.expiresAt <= now) this.usedCodes.delete(id);
    this.db.prepare("DELETE FROM oauth_tokens WHERE expires_at <= ?").run(now - 24 * 60 * 60 * 1000);
    this.db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now);
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

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || "connected-app"
  );
}

function toClient(row: ClientRow): Client {
  return {
    id: row.id,
    name: row.name,
    redirectUris: JSON.parse(row.redirect_uris) as string[],
    clientUri: row.client_uri,
    confidential: row.secret_hash !== null,
    registeredBy: row.registered_by as Client["registeredBy"],
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

function toGrant(row: GrantRow): Grant {
  return {
    id: row.id,
    clientId: row.client_id,
    sector: row.sector,
    scopes: row.scopes.split(" ").filter(Boolean) as Scope[],
    boxId: row.box_id,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}
