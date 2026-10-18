import { CardboardError } from "../shared/errors.ts";
import { fromB64u, random, toB64u } from "./crypto.ts";

/**
 * Face ID, Touch ID, Windows Hello or a phone's fingerprint, through a passkey.
 *
 * Cardboard doesn't use the passkey to log in to the server. It asks it for a
 * secret (WebAuthn's PRF extension) that only that passkey can make, and only
 * after your face, finger or PIN; this device's copy of your account key is
 * sealed by a key made from it. The passkey is tied to this site, so a
 * look-alike site can't ask for the same secret. Browser-only.
 */

interface PrfOutput {
  enabled?: boolean;
  results?: { first?: ArrayBuffer | ArrayBufferView };
}

interface PasskeyCredential {
  rawId: ArrayBuffer;
  getClientExtensionResults(): { prf?: PrfOutput };
}

interface Credentials {
  create(options: unknown): Promise<PasskeyCredential | null>;
  get(options: unknown): Promise<PasskeyCredential | null>;
}

interface PublicKeyCredentialStatic {
  isUserVerifyingPlatformAuthenticatorAvailable?: () => Promise<boolean>;
  getClientCapabilities?: () => Promise<Record<string, boolean | undefined>>;
}

const TIMEOUT_MS = 2 * 60 * 1000;

function webauthn(): Credentials {
  const g = globalThis as { navigator?: { credentials?: Credentials }; PublicKeyCredential?: unknown };
  if (!g.navigator?.credentials || !g.PublicKeyCredential) throw unsupported();
  return g.navigator.credentials;
}

function unsupported() {
  return new CardboardError(
    "passkey_unsupported",
    0,
    "This browser can't lock Cardboard with a passkey.",
    "It needs passkeys with the PRF extension: Safari 18+ (iPhone, iPad, Mac), Chrome or Edge 132+, Firefox 135+, or a security key that supports hmac-secret.",
  );
}

function cancelled(err: unknown): never {
  const name = (err as { name?: string } | null)?.name;
  if (name === "NotAllowedError" || name === "AbortError") {
    throw new CardboardError("passkey_cancelled", 0, "Face ID (or your passkey) was cancelled, or took too long.", "Try again.");
  }
  if (name === "InvalidStateError") throw new CardboardError("passkey_exists", 0, "This passkey is already set up here.", "Try again, or pick another passkey.");
  if (name === "SecurityError") throw new CardboardError("passkey_insecure", 0, "Passkeys only work on a named HTTPS site (or localhost).", "Open Cardboard on its https:// address, or at localhost instead of 127.0.0.1.");
  throw err;
}

function bytesOf(value: ArrayBuffer | ArrayBufferView): Uint8Array {
  return value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

/**
 * Why a passkey lock can't work here, in a sentence, or null if it's worth
 * trying (setting one up checks for real).
 */
export async function passkeyBlocker(): Promise<string | null> {
  const g = globalThis as { navigator?: { credentials?: unknown }; PublicKeyCredential?: PublicKeyCredentialStatic; isSecureContext?: boolean; location?: { hostname: string } };
  if (!g.PublicKeyCredential || !g.navigator?.credentials) return unsupported().reason;
  const host = g.location?.hostname ?? "";
  if (/^[\d.]+$|^\[|:/.test(host)) return "Passkeys need a site name, not an IP address. Open Cardboard at localhost (or its https:// address).";
  if (g.isSecureContext === false) return "Passkeys only work over HTTPS. Open Cardboard on its https:// address.";
  try {
    const caps = await g.PublicKeyCredential.getClientCapabilities?.();
    if (caps && caps["extension:prf"] === false) return unsupported().reason;
  } catch {
    // Older browsers don't say; setting one up will tell.
  }
  return null;
}

/** True when this device has a built-in one (Face ID, Touch ID, Windows Hello), not just security keys or a phone nearby. */
export async function hasBuiltInPasskeys(): Promise<boolean> {
  const g = globalThis as { PublicKeyCredential?: PublicKeyCredentialStatic };
  try {
    return (await g.PublicKeyCredential?.isUserVerifyingPlatformAuthenticatorAvailable?.()) ?? false;
  } catch {
    return false;
  }
}

/**
 * Makes a new passkey for this device and returns the secret it makes. Shows
 * Face ID (or whatever this device uses) once, or twice where the browser
 * only hands out the secret on a second ask.
 */
export async function createPasskey(options: { name: string; site?: string }): Promise<{ credential: string; salt: string; secret: Uint8Array }> {
  const salt = random(32);
  const created = await webauthn()
    .create({
      publicKey: {
        rp: { name: options.site ?? "Cardboard" },
        user: { id: random(16), name: options.name, displayName: options.name },
        challenge: random(32),
        pubKeyCredParams: [
          { type: "public-key", alg: -7 },
          { type: "public-key", alg: -8 },
          { type: "public-key", alg: -257 },
        ],
        authenticatorSelection: { userVerification: "required", residentKey: "preferred" },
        hints: ["client-device"],
        extensions: { prf: { eval: { first: salt } } },
        timeout: TIMEOUT_MS,
      },
    })
    .catch(cancelled);
  if (!created) throw new CardboardError("passkey_cancelled", 0, "No passkey was made.", "Try again.");
  const prf = created.getClientExtensionResults().prf;
  if (!prf || prf.enabled === false) throw unsupported();
  const credential = toB64u(new Uint8Array(created.rawId));
  const first = prf.results?.first;
  const secret = first ? bytesOf(first) : await passkeySecret({ credential, salt: toB64u(salt) });
  return { credential, salt: toB64u(salt), secret };
}

/** Asks for the passkey (Face ID…) and returns its secret. */
export async function passkeySecret(lock: { credential: string; salt: string }): Promise<Uint8Array> {
  const got = await webauthn()
    .get({
      publicKey: {
        challenge: random(32),
        allowCredentials: [{ type: "public-key", id: fromB64u(lock.credential) }],
        userVerification: "required",
        extensions: { prf: { eval: { first: fromB64u(lock.salt) } } },
        timeout: TIMEOUT_MS,
      },
    })
    .catch(cancelled);
  const first = got?.getClientExtensionResults().prf?.results?.first;
  if (!first) throw unsupported();
  const secret = bytesOf(first);
  if (secret.byteLength < 32) throw unsupported();
  return secret;
}
