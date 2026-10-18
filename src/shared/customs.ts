import { fail } from "./errors.ts";
import { formatBytes } from "./size.ts";
import { kindName, notice, scan, SECRET_KINDS, type SensitiveKind } from "./detect.ts";
import { byteLength, isPlainObject } from "./data.ts";

/**
 * Customs: every parcel crossing a dock is inspected here before anyone else
 * sees it. Nothing that fails is stored, so a rejected parcel can't leak later.
 *
 *  1. No booby traps: `__proto__` keys and absurd nesting are refused, so a
 *     parcel can't "infect" an app that merges it naively.
 *  2. Manifest: if the dock has a shape, required fields must be there with the
 *     right type, and anything not on the manifest is stripped.
 *  3. Secrets (API keys, passwords, private keys, login tokens) are refused.
 *  4. Personal data (emails, phones, card numbers, kennitölur…) is redacted,
 *     refused or let through, as the dock says.
 *  5. Size.
 */

export type FieldType = "string" | "number" | "boolean" | "object" | "list" | "any";
/** e.g. { item: "string", qty: "number?", tags: "list?" }. A trailing ? means optional. */
export type DockShape = Record<string, string>;

const TYPES: readonly FieldType[] = ["string", "number", "boolean", "object", "list", "any"];
const PERSONAL: ReadonlySet<SensitiveKind> = new Set(["email", "phone", "card-number", "iban", "kennitala", "ssn"]);
const MAX_DEPTH = 32;

export interface CustomsPolicy {
  maxParcelBytes: number;
  secrets: "block" | "allow";
  personal: "redact" | "block" | "allow";
  shape: DockShape | null;
}

export interface Cleared {
  body: unknown;
  json: string;
  size: number;
  /** Paths whose values were replaced, e.g. ["contact.email"]. */
  redacted: string[];
  /** Fields removed because they aren't on the dock's manifest. */
  stripped: string[];
}

export function validateShape(shape: unknown): DockShape | null {
  if (shape === null || shape === undefined) return null;
  if (!isPlainObject(shape) || Object.keys(shape).length === 0) {
    throw fail("bad_shape", 400, 'A manifest maps field names to types, like { "item": "string", "qty": "number?" }.');
  }
  for (const [field, type] of Object.entries(shape)) {
    if (typeof type !== "string" || !TYPES.includes(type.replace(/\?$/, "") as FieldType)) {
      throw fail("bad_shape", 400, `"${field}" has type ${JSON.stringify(type)}. Use ${TYPES.join(", ")} (add ? for optional).`);
    }
    if (field === "__proto__") throw fail("bad_shape", 400, "A field can't be called __proto__.");
  }
  return shape as DockShape;
}

export function inspect(body: unknown, policy: CustomsPolicy): Cleared {
  if (body === undefined) throw fail("empty_parcel", 400, "That parcel is empty.", "Send it as { dock, body }.");
  checkSafe(body, 0, "");

  let shaped: unknown = body;
  const stripped: string[] = [];
  if (policy.shape) shaped = applyShape(body, policy.shape, stripped);

  const findings = scan(shaped);
  if (policy.secrets === "block") {
    const secret = findings.find((f) => SECRET_KINDS.has(f.kind));
    if (secret) {
      throw fail(
        "secret_at_customs",
        422,
        `Customs stopped this parcel: ${notice(secret)}`,
        "Secrets never cross a dock. Send a reference instead, or have the owner set the dock's secrets to allow.",
      );
    }
  }

  const redacted: string[] = [];
  const personal = findings.filter((f) => PERSONAL.has(f.kind));
  if (personal.length > 0) {
    if (policy.personal === "block") {
      throw fail(
        "personal_at_customs",
        422,
        `Customs stopped this parcel: "${personal[0]!.path}" contains ${kindName(personal[0]!.kind)} data, and this dock doesn't carry personal data.`,
      );
    }
    if (policy.personal === "redact") shaped = redact(shaped, null, "", redacted);
  }

  const json = JSON.stringify(shaped);
  const size = byteLength(json);
  if (size > policy.maxParcelBytes) {
    throw fail(
      "parcel_too_large",
      413,
      `That parcel is ${formatBytes(size)}; this dock carries up to ${formatBytes(policy.maxParcelBytes)}.`,
      "Split it up, or raise maxParcelBytes in the dock settings.",
    );
  }
  return { body: shaped, json, size, redacted, stripped };
}

/** Refuses prototype-pollution keys and absurd nesting anywhere in the parcel. */
function checkSafe(node: unknown, depth: number, path: string) {
  if (depth > MAX_DEPTH) {
    throw fail("unsafe_parcel", 422, `Customs stopped this parcel: it's nested more than ${MAX_DEPTH} levels deep.`);
  }
  if (Array.isArray(node)) {
    node.forEach((child, i) => checkSafe(child, depth + 1, `${path}[${i}]`));
  } else if (isPlainObject(node)) {
    for (const [key, child] of Object.entries(node)) {
      const here = path ? `${path}.${key}` : key;
      if (key === "__proto__" || (key === "constructor" && isPlainObject(child) && "prototype" in child)) {
        throw fail(
          "unsafe_parcel",
          422,
          `Customs stopped this parcel: "${here}" is the kind of key used to infect apps that merge objects.`,
        );
      }
      checkSafe(child, depth + 1, here);
    }
  }
}

function typeOf(value: unknown): FieldType {
  if (Array.isArray(value)) return "list";
  if (value === null) return "any";
  return typeof value === "object" ? "object" : (typeof value as FieldType);
}

function applyShape(body: unknown, shape: DockShape, stripped: string[]): Record<string, unknown> {
  if (!isPlainObject(body)) {
    throw fail("shape_mismatch", 422, "This dock has a manifest, so parcels must be objects.", `Expected fields: ${describe(shape)}.`);
  }
  const out: Record<string, unknown> = {};
  for (const [field, spec] of Object.entries(shape)) {
    const optional = spec.endsWith("?");
    const type = spec.replace(/\?$/, "") as FieldType;
    const value = body[field];
    if (value === undefined || value === null) {
      if (!optional) {
        throw fail("shape_mismatch", 422, `This dock's manifest needs "${field}" (${type}).`, `Expected fields: ${describe(shape)}.`);
      }
      continue;
    }
    if (type !== "any" && typeOf(value) !== type) {
      throw fail("shape_mismatch", 422, `"${field}" should be ${type}, but it's ${typeOf(value)}.`, `Expected fields: ${describe(shape)}.`);
    }
    out[field] = value;
  }
  for (const field of Object.keys(body)) {
    if (!(field in shape)) stripped.push(field);
  }
  return out;
}

function describe(shape: DockShape): string {
  return Object.entries(shape)
    .map(([field, type]) => `${field}: ${type}`)
    .join(", ");
}

/** Replaces personal values with a label, keeping the parcel's structure. */
function redact(node: unknown, field: string | null, path: string, out: string[]): unknown {
  if (typeof node === "string" || typeof node === "number") {
    const found = scan(field ? { [field]: node } : node).find((f) => PERSONAL.has(f.kind));
    if (!found) return node;
    out.push(path || "(body)");
    return `[redacted ${kindName(found.kind)}]`;
  }
  if (Array.isArray(node)) return node.map((child, i) => redact(child, field, `${path}[${i}]`, out));
  if (isPlainObject(node)) {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(node)) {
      result[key] = redact(child, key, path ? `${path}.${key}` : key, out);
    }
    return result;
  }
  return node;
}
