import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { fail } from "../shared/errors.ts";

/**
 * The server's own crypto. Note what's NOT here: nothing in this file can open
 * anything a person stored. Your data is sealed on your devices with keys the
 * server never gets (see src/client/crypto.ts); the server only hashes tokens,
 * computes pseudonyms, signs sign-in tokens, and seals its own few secrets
 * (the sign-in signing key, names you chose to pass to an app in the clear).
 */

const FORMAT = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export function randomKey(): Buffer {
  return randomBytes(32);
}

export function derive(key: Buffer, purpose: string): Buffer {
  return Buffer.from(hkdfSync("sha256", key, Buffer.alloc(0), `cardboard/${purpose}/v1`, 32));
}

export function seal(key: Buffer, plaintext: Buffer | string, context: string): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(context));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from([FORMAT]), iv, body, cipher.getAuthTag()]);
}

export function unseal(key: Buffer, sealed: Uint8Array, context: string): Buffer {
  const buf = Buffer.from(sealed.buffer, sealed.byteOffset, sealed.byteLength);
  if (buf.length < 1 + IV_BYTES + TAG_BYTES || buf[0] !== FORMAT) throw tampered();
  const decipher = createDecipheriv("aes-256-gcm", key, buf.subarray(1, 1 + IV_BYTES));
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(buf.subarray(buf.length - TAG_BYTES));
  try {
    return Buffer.concat([decipher.update(buf.subarray(1 + IV_BYTES, buf.length - TAG_BYTES)), decipher.final()]);
  } catch {
    throw tampered();
  }
}

function tampered() {
  return fail(
    "tampered",
    500,
    "A server secret failed its integrity check, so Cardboard refused to use it.",
    "The database was modified outside Cardboard, or it's being opened with the wrong server key.",
  );
}

export function hmac(key: Buffer, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

export function sha256(input: string | Uint8Array): Buffer {
  return createHash("sha256").update(input).digest();
}

export function base64url(input: Buffer | Uint8Array | string): string {
  return (typeof input === "string" ? Buffer.from(input) : Buffer.from(input.buffer, input.byteOffset, input.byteLength)).toString("base64url");
}

export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}

/**
 * Secrets carry a prefix so scanners (and Cardboard's own radar) can spot them:
 * cbt_ app tape, cbd_ device, cbh_ host, cbi_ invite, cbr_ refresh token, cbs_ client secret.
 */
export type SecretKind = "cbt" | "cbd" | "cbh" | "cbi" | "cbr" | "cbs";

export function newSecret(prefix: SecretKind): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString("base64url").replace(/[-_]/g, "x")}`;
}
