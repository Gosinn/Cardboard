import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { fail } from "../shared/errors.ts";

/**
 * Cardboard's crypto, kept deliberately boring: AES-256-GCM, HKDF and HMAC
 * from Node's built-in OpenSSL bindings. No custom primitives.
 *
 *   master key ──HKDF──► wrap key ──AES-GCM──► wrapped box key (stored in DB)
 *   box key    ──HKDF──► enc key   (values, key names, audit details)
 *              └─HKDF──► index key (HMAC blind index, so key names can be looked
 *                                   up without being stored in plain text)
 */

const FORMAT = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface BoxKeys {
  enc: Buffer;
  idx: Buffer;
}

export function randomKey(): Buffer {
  return randomBytes(32);
}

export function derive(key: Buffer, purpose: string): Buffer {
  return Buffer.from(hkdfSync("sha256", key, Buffer.alloc(0), `cardboard/${purpose}/v1`, 32));
}

export function deriveBoxKeys(boxKey: Buffer): BoxKeys {
  return { enc: derive(boxKey, "box-enc"), idx: derive(boxKey, "box-idx") };
}

/**
 * Encrypts `plaintext`. The `context` string is authenticated but not stored:
 * a ciphertext only opens with the same context, so a value can't be moved to
 * another key or another box, even by someone with write access to the DB.
 */
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
  const iv = buf.subarray(1, 1 + IV_BYTES);
  const tag = buf.subarray(buf.length - TAG_BYTES);
  const body = buf.subarray(1 + IV_BYTES, buf.length - TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    throw tampered();
  }
}

function tampered() {
  return fail(
    "tampered",
    500,
    "Stored data failed its integrity check, so Cardboard refused to read it.",
    "The database file was modified outside Cardboard, or it is being opened with the wrong master key.",
  );
}

/** Deterministic, keyed fingerprint of a key name. Reveals nothing without the box key. */
export function blindIndex(idxKey: Buffer, name: string): Buffer {
  return createHmac("sha256", idxKey).update(name).digest();
}

export function sha256(input: string): Buffer {
  return createHash("sha256").update(input).digest();
}

export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}

/** Secrets look like `cbt_…` (app tape) or `cbo_…` (owner) so scanners can spot them. */
export function newSecret(prefix: "cbt" | "cbo"): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString("base64url").replace(/[-_]/g, "x")}`;
}

/** Time-sortable id for collection documents: creation order == key order. */
export function sortableId(now: number): string {
  return now.toString(36).padStart(9, "0") + randomBytes(6).toString("hex");
}
