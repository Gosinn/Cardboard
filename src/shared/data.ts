import { fail } from "./errors.ts";

/** Plain helpers for JSON data, shared by the SDK, the dashboard and the server. */

export interface Item<T = unknown> {
  key: string;
  value: T;
  version: number;
  size: number;
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null;
}

const MAX_KEY = 1024;

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !ArrayBuffer.isView(value);
}

export function validateKey(key: unknown): asserts key is string {
  if (typeof key !== "string" || key.length === 0) {
    throw fail("bad_key", 400, 'Every item needs a key: a non-empty string like "notes/groceries".');
  }
  if (key.length > MAX_KEY) throw fail("bad_key", 400, `Keys can be at most ${MAX_KEY} characters long.`);
  if (/[\x00-\x1f\x7f]/.test(key)) throw fail("bad_key", 400, "Keys can't contain control characters.");
}

const BYTES = 0x00;

/**
 * What gets sealed for a value: JSON text, or, for a Uint8Array, a zero byte
 * and the bytes themselves (JSON text never starts with a zero byte). So
 * files take their real size, not a third more as base64.
 */
export function encodeValue(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) {
    const out = new Uint8Array(value.length + 1);
    out[0] = BYTES;
    out.set(value, 1);
    return out;
  }
  return new TextEncoder().encode(JSON.stringify(value));
}

export function decodeValue(plain: Uint8Array): unknown {
  return plain[0] === BYTES ? plain.slice(1) : JSON.parse(new TextDecoder().decode(plain));
}

/** JSON Merge Patch (RFC 7386): nested objects merge, `null` removes a field. */
export function mergePatch(target: unknown, patch: unknown): unknown {
  if (!isPlainObject(patch)) return patch;
  const result: Record<string, unknown> = isPlainObject(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key];
    // defineProperty, not assignment: a "__proto__" key must stay plain data.
    else Object.defineProperty(result, key, { value: mergePatch(result[key], value), enumerable: true, writable: true, configurable: true });
  }
  return result;
}

export function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/** Time-sortable id for collection documents: creation order == key order. */
export function sortableId(now: number): string {
  const tail = [...globalThis.crypto.getRandomValues(new Uint8Array(6))].map((b) => b.toString(16).padStart(2, "0")).join("");
  return now.toString(36).padStart(9, "0") + tail;
}
