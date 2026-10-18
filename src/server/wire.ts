import { fail } from "../shared/errors.ts";
import { parseDuration } from "../shared/duration.ts";

/**
 * Reading request bodies. Sealed things arrive as base64url strings and are
 * stored as bytes; the server checks their size and shape, never their content.
 */

export type Body = Record<string, unknown>;

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asBody(body: unknown): Body {
  if (body === undefined || body === null) return {};
  if (!isPlainObject(body)) throw fail("bad_request", 400, "Send a JSON object as the request body.");
  return body;
}

export function requireString(body: Body, field: string, max = 1000): string {
  const value = body[field];
  if (typeof value !== "string" || value.length === 0) throw fail("bad_request", 400, `\`${field}\` is required and must be a string.`);
  if (value.length > max) throw fail("bad_request", 400, `\`${field}\` is too long.`);
  return value;
}

export function optString(body: Body, field: string, max = 1000): string | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw fail("bad_request", 400, `\`${field}\` must be a string.`);
  if (value.length > max) throw fail("bad_request", 400, `\`${field}\` is too long.`);
  return value;
}

export function optNumber(body: Body, field: string): number | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw fail("bad_request", 400, `\`${field}\` must be a number.`);
  return value;
}

export function optBoolean(body: Body, field: string): boolean | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw fail("bad_request", 400, `\`${field}\` must be true or false.`);
  return value;
}

const B64U = /^[A-Za-z0-9_-]*$/;

/** A sealed blob (or hash, or public key) sent as base64url. */
export function requireBlob(body: Body, field: string, maxBytes: number, minBytes = 1): Buffer {
  const value = body[field];
  if (typeof value !== "string" || !B64U.test(value) || value.length % 4 === 1) {
    throw fail("bad_request", 400, `\`${field}\` must be base64url-encoded bytes.`, "The Cardboard SDK and CLI do this for you.");
  }
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length < minBytes) throw fail("bad_request", 400, `\`${field}\` is too short.`);
  if (bytes.length > maxBytes) throw fail("too_large", 413, `\`${field}\` is too large (${bytes.length} bytes, at most ${maxBytes}).`);
  return bytes;
}

export function optBlob(body: Body, field: string, maxBytes: number): Buffer | undefined {
  if (body[field] === undefined || body[field] === null) return undefined;
  return requireBlob(body, field, maxBytes);
}

/** A keyed hash of a name: exactly 32 bytes. */
export function requireIndex(body: Body, field = "idx"): Buffer {
  const value = body[field];
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw fail("bad_request", 400, `\`${field}\` must be a 32-byte keyed hash (43 base64url characters).`, "The Cardboard SDK computes it for you.");
  }
  return Buffer.from(value, "base64url");
}

/** Ids that devices choose themselves (so they can seal things to an id before the server has seen it). */
export function requireClientId(body: Body, field: string, prefix: "box" | "dock" | "pcl" | "mem"): string {
  const value = body[field];
  if (typeof value !== "string" || !new RegExp(`^${prefix}_[A-Za-z0-9]{12,32}$`).test(value)) {
    throw fail("bad_request", 400, `\`${field}\` must look like ${prefix}_ followed by 12–32 letters and digits.`);
  }
  return value;
}

export function b64(bytes: Uint8Array | null | undefined): string | null {
  return bytes ? Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64url") : null;
}

/** "never" / null → null (never), undefined → undefined (default), else a duration. */
export function optDuration(body: Body, field: string): number | null | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (value === null || value === "never") return null;
  return parseDuration(value as string | number);
}

export function bearer(header: string | undefined): string | null {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header ?? "");
  return match ? match[1]! : null;
}
