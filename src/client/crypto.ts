import { CardboardError } from "../shared/errors.ts";

/**
 * The key-holding side of Cardboard's crypto. This runs on YOUR devices (the
 * browser dashboard, the CLI, the SDK inside your apps), never on the server:
 * the server only ever stores what comes out of seal() and sealTo().
 *
 * Built only on WebCrypto, so the same code runs in Node and in browsers, and
 * kept deliberately boring: AES-256-GCM, HKDF-SHA256, HMAC-SHA256, ECDH P-256.
 *
 *   account key ──HKDF──► wrap key ──AES-GCM──► box keys, dock keys
 *               ├─HKDF──► meta key ──AES-GCM──► box names, dock names, labels, profile
 *               └─HKDF──► index key ─HMAC────► box-name lookups
 *   box key     ──HKDF──► seal key ──AES-GCM──► item names and values
 *               └─HKDF──► index key ─HMAC────► item-name lookups (the server never sees names)
 */

const subtle = globalThis.crypto.subtle;
type Subtle = typeof subtle;
export type CryptoKey = Awaited<ReturnType<Subtle["importKey"]>>;
/** Raw key bytes, or a WebCrypto key (e.g. a non-extractable device key in a browser). */
export type KeyLike = Uint8Array | CryptoKey;

const SEALED = 1;
const SEALED_TO = 2;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const PUBLIC_KEY_BYTES = 65;

export const utf8 = {
  encode: (text: string): Uint8Array => new TextEncoder().encode(text),
  decode: (bytes: Uint8Array): string => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
};

export function random(bytes: number): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(bytes));
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

/** Compares without stopping at the first difference. */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

// ── base64url ─────────────────────────────────────────────────────────────

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const B64_INDEX = new Map([...B64].map((c, i) => [c, i]));

export function toB64u(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!;
    if (i + 1 < bytes.length) out += B64[(n >> 6) & 63]!;
    if (i + 2 < bytes.length) out += B64[n & 63]!;
  }
  return out;
}

export function fromB64u(text: string): Uint8Array {
  if (typeof text !== "string" || text.length % 4 === 1) throw badEncoding();
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let bits = 0;
  let value = 0;
  let at = 0;
  for (const c of text) {
    const v = B64_INDEX.get(c);
    if (v === undefined) throw badEncoding();
    value = (value << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[at++] = (value >> bits) & 0xff;
    }
  }
  return out;
}

function badEncoding() {
  return new CardboardError("bad_encoding", 400, "Some data wasn't valid base64url.");
}

// ── Symmetric ─────────────────────────────────────────────────────────────

const aesKeys = new WeakMap<Uint8Array, Promise<CryptoKey>>();

function aesKey(key: KeyLike): Promise<CryptoKey> {
  if (!(key instanceof Uint8Array)) return Promise.resolve(key);
  if (key.byteLength !== 32) throw new CardboardError("bad_key", 500, "Cardboard keys are 32 bytes.");
  let cached = aesKeys.get(key);
  if (!cached) {
    cached = subtle.importKey("raw", key, "AES-GCM", false, ["encrypt", "decrypt"]);
    aesKeys.set(key, cached);
  }
  return cached;
}

/** A fresh AES-256-GCM key that can't be exported, e.g. to keep in a browser's IndexedDB. */
export function lockedKey(): Promise<CryptoKey> {
  return subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]) as Promise<CryptoKey>;
}

/**
 * Encrypts `plaintext` with AES-256-GCM. `context` is authenticated but not
 * stored: a sealed value only opens with the same context, so the server can't
 * move it to another key, item or box without that being noticed.
 */
export async function seal(key: KeyLike, plaintext: Uint8Array | string, context: string): Promise<Uint8Array> {
  const iv = random(IV_BYTES);
  const data = typeof plaintext === "string" ? utf8.encode(plaintext) : plaintext;
  const body = await subtle.encrypt({ name: "AES-GCM", iv, additionalData: utf8.encode(`cardboard/${context}`) }, await aesKey(key), data);
  return concat(Uint8Array.of(SEALED), iv, new Uint8Array(body));
}

export async function open(key: KeyLike, sealed: Uint8Array, context: string): Promise<Uint8Array> {
  if (!(sealed instanceof Uint8Array) || sealed.byteLength < 1 + IV_BYTES + TAG_BYTES || sealed[0] !== SEALED) throw locked();
  try {
    const plain = await subtle.decrypt(
      { name: "AES-GCM", iv: sealed.subarray(1, 1 + IV_BYTES), additionalData: utf8.encode(`cardboard/${context}`) },
      await aesKey(key),
      sealed.subarray(1 + IV_BYTES),
    );
    return new Uint8Array(plain);
  } catch {
    throw locked();
  }
}

export async function sealJson(key: KeyLike, value: unknown, context: string): Promise<Uint8Array> {
  return seal(key, JSON.stringify(value), context);
}

export async function openJson<T = unknown>(key: KeyLike, sealed: Uint8Array, context: string): Promise<T> {
  return JSON.parse(utf8.decode(await open(key, sealed, context))) as T;
}

export async function openText(key: KeyLike, sealed: Uint8Array, context: string): Promise<string> {
  return utf8.decode(await open(key, sealed, context));
}

function locked() {
  return new CardboardError(
    "locked",
    422,
    "This data didn't open with your key.",
    "It was changed by someone without the key, or it belongs somewhere else. Cardboard refused to use it.",
  );
}

/** A key for one purpose, derived with HKDF-SHA256. Different purposes give unrelated keys. */
/** A key from a short secret (a PIN): PBKDF2-SHA-256, slow enough to make each guess cost, quick enough to type and go. */
export async function stretch(secret: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const base = await subtle.importKey("raw", utf8.encode(secret), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, base, 256));
}

export async function derive(key: Uint8Array, purpose: string): Promise<Uint8Array> {
  const base = await subtle.importKey("raw", key, "HKDF", false, ["deriveBits"]);
  const bits = await subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: utf8.encode(`cardboard/${purpose}/v1`) },
    base,
    256,
  );
  return new Uint8Array(bits);
}

/** Keyed fingerprint, e.g. of a key name: lookups work, but it reveals nothing without the key. */
export async function hmac(key: Uint8Array, data: Uint8Array | string): Promise<Uint8Array> {
  const k = await subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await subtle.sign("HMAC", k, typeof data === "string" ? utf8.encode(data) : data));
}

export async function sha256(data: Uint8Array | string): Promise<Uint8Array> {
  return new Uint8Array(await subtle.digest("SHA-256", typeof data === "string" ? utf8.encode(data) : data));
}

// ── Public key (sealing to a device or app that isn't here yet) ───────────

export interface KeyPair {
  privateKey: CryptoKey;
  /** Uncompressed P-256 point, 65 bytes. Safe to send anywhere. */
  publicKey: Uint8Array;
}

/** An ECDH key pair. `extractable` only when the private key has to survive a redirect. */
export async function keyPair(extractable = false): Promise<KeyPair> {
  const pair = (await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, extractable, ["deriveBits"])) as {
    privateKey: CryptoKey;
    publicKey: CryptoKey;
  };
  return { privateKey: pair.privateKey, publicKey: new Uint8Array(await subtle.exportKey("raw", pair.publicKey)) };
}

export async function exportPrivateKey(privateKey: CryptoKey): Promise<string> {
  return toB64u(new Uint8Array(await subtle.exportKey("pkcs8", privateKey)));
}

export async function importPrivateKey(pkcs8: string): Promise<CryptoKey> {
  return subtle.importKey("pkcs8", fromB64u(pkcs8), { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
}

async function sharedKey(privateKey: CryptoKey, publicKey: Uint8Array, ephemeral: Uint8Array, recipient: Uint8Array): Promise<Uint8Array> {
  if (publicKey.byteLength !== PUBLIC_KEY_BYTES || publicKey[0] !== 4) {
    throw new CardboardError("bad_public_key", 400, "That isn't a P-256 public key.");
  }
  let pub: CryptoKey;
  try {
    pub = await subtle.importKey("raw", publicKey, { name: "ECDH", namedCurve: "P-256" }, false, []);
  } catch {
    throw new CardboardError("bad_public_key", 400, "That isn't a valid P-256 public key.");
  }
  const secret = new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: pub }, privateKey, 256));
  // Both public keys go into the derivation, so the result belongs to this exact exchange.
  return derive(concat(secret, ephemeral, recipient), "sealed-to");
}

/**
 * Encrypts for the holder of `publicKey` only (ECIES: a throwaway ECDH key +
 * AES-256-GCM). Used to hand a key to a new device or an app that signs in.
 */
export async function sealTo(publicKey: Uint8Array, plaintext: Uint8Array | string, context: string): Promise<Uint8Array> {
  const eph = await keyPair();
  const key = await sharedKey(eph.privateKey, publicKey, eph.publicKey, publicKey);
  return concat(Uint8Array.of(SEALED_TO), eph.publicKey, await seal(key, plaintext, context));
}

export async function openWith(pair: KeyPair, sealed: Uint8Array, context: string): Promise<Uint8Array> {
  if (!(sealed instanceof Uint8Array) || sealed.byteLength < 1 + PUBLIC_KEY_BYTES || sealed[0] !== SEALED_TO) throw locked();
  const eph = sealed.subarray(1, 1 + PUBLIC_KEY_BYTES);
  let key: Uint8Array;
  try {
    key = await sharedKey(pair.privateKey, eph, eph, pair.publicKey);
  } catch {
    throw locked();
  }
  return open(key, sealed.subarray(1 + PUBLIC_KEY_BYTES), context);
}

// ── Shamir secret sharing over GF(256), for "trusted friends" recovery ───

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    // Multiply by the generator 3 in GF(2^8) with the AES polynomial x^8+x^4+x^3+x+1.
    x ^= (x << 1) ^ (x & 0x80 ? 0x11b : 0);
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!;
}

function gfMul(a: number, b: number): number {
  return a === 0 || b === 0 ? 0 : EXP[LOG[a]! + LOG[b]!]!;
}

function gfDiv(a: number, b: number): number {
  if (b === 0) throw new Error("division by zero");
  return a === 0 ? 0 : EXP[LOG[a]! + 255 - LOG[b]!]!;
}

/**
 * Splits `secret` into `count` shares; any `threshold` of them rebuild it and
 * fewer reveal nothing at all. Each share is [x, ...y bytes].
 */
export function splitSecret(secret: Uint8Array, count: number, threshold: number): Uint8Array[] {
  if (threshold < 2 || threshold > count || count > 255) throw new CardboardError("bad_split", 400, "Pick a threshold of at least 2 and at most the number of shares.");
  const shares = Array.from({ length: count }, (_, i) => {
    const share = new Uint8Array(secret.byteLength + 1);
    share[0] = i + 1;
    return share;
  });
  for (let byte = 0; byte < secret.byteLength; byte++) {
    const coefficients = [secret[byte]!, ...random(threshold - 1)];
    for (const share of shares) {
      const x = share[0]!;
      let y = 0;
      for (let c = coefficients.length - 1; c >= 0; c--) y = gfMul(y, x) ^ coefficients[c]!;
      share[byte + 1] = y;
    }
  }
  return shares;
}

export function combineShares(shares: Uint8Array[]): Uint8Array {
  const xs = shares.map((s) => s[0]!);
  if (shares.length < 2 || new Set(xs).size !== xs.length || xs.includes(0) || shares.some((s) => s.byteLength !== shares[0]!.byteLength)) {
    throw new CardboardError("bad_shares", 400, "Those pieces don't fit together.", "Use pieces from the same set, each one only once.");
  }
  const secret = new Uint8Array(shares[0]!.byteLength - 1);
  for (let byte = 0; byte < secret.byteLength; byte++) {
    let value = 0;
    for (let i = 0; i < shares.length; i++) {
      // Lagrange basis polynomial for share i, evaluated at x = 0.
      let basis = 1;
      for (let j = 0; j < shares.length; j++) if (j !== i) basis = gfMul(basis, gfDiv(xs[j]!, xs[j]! ^ xs[i]!));
      value ^= gfMul(shares[i]![byte + 1]!, basis);
    }
    secret[byte] = value;
  }
  return secret;
}

// ── Human codes (recovery kit, pairing, friends' pieces) ──────────────────

/** Crockford base32: no I, L, O or U, so codes survive being read aloud or handwritten. */
const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Bytes → "K7Q2-9XMA-…" with a 2-character checksum at the end, so a typo is
 * caught before anyone tries the code.
 */
export function toCode(bytes: Uint8Array, group = 4): string {
  let chars = "";
  let value = 0;
  let bits = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      chars += B32[(value >> bits) & 31];
    }
  }
  if (bits > 0) chars += B32[(value << (5 - bits)) & 31];
  const check = checksum(bytes);
  chars += B32[(check >> 5) & 31]! + B32[check & 31]!;
  return chars.match(new RegExp(`.{1,${group}}`, "g"))!.join("-");
}

/** Reads a code typed by a person: case, spaces, dashes and look-alikes (O/0, I/L/1) don't matter. */
export function fromCode(text: string, byteLength: number): Uint8Array {
  const clean = String(text)
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  const expected = Math.ceil((byteLength * 8) / 5) + 2;
  if (clean.length !== expected || [...clean].some((c) => !B32.includes(c))) {
    throw new CardboardError("bad_code", 400, "That code doesn't look right.", `It should be ${expected} letters and digits.`);
  }
  const out = new Uint8Array(byteLength);
  let value = 0;
  let bits = 0;
  let at = 0;
  for (const c of clean.slice(0, -2)) {
    value = (value << 5) | B32.indexOf(c);
    bits += 5;
    if (bits >= 8 && at < byteLength) {
      bits -= 8;
      out[at++] = (value >> bits) & 0xff;
    }
  }
  const check = checksum(out);
  if (clean.slice(-2) !== B32[(check >> 5) & 31]! + B32[check & 31]!) {
    throw new CardboardError("bad_code", 400, "That code has a typo in it.", "Check each group of letters and try again.");
  }
  return out;
}

/** CRC-16/CCITT, cut to 10 bits (two code characters). */
function checksum(bytes: Uint8Array): number {
  let crc = 0xffff;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc & 0x3ff;
}
