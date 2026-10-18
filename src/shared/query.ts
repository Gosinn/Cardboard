import { fail } from "./errors.ts";

/**
 * A small, forgiving query language over JSON documents:
 *
 *   { done: false }                          equality
 *   { tags: "work" }                         arrays match if they contain the value
 *   { "author.name": "Gosinn" }              dot paths
 *   { stars: { $gte: 4 } }                   $eq $ne $gt $gte $lt $lte $in $nin $exists
 *   { title: { $contains: "lasagna" } }      case-insensitive substring / array contains
 *   { title: { $startsWith: "Re" } }
 *   { $or: [{ a: 1 }, { b: 2 }] }            $or, $and, $not
 */
export type Where = Record<string, unknown>;

const OPERATORS = ["$eq", "$ne", "$gt", "$gte", "$lt", "$lte", "$in", "$nin", "$exists", "$contains", "$startsWith"];

export function getPath(doc: unknown, path: string): unknown {
  let node: unknown = doc;
  for (const part of path.split(".")) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

export function matches(doc: unknown, where: Where | undefined): boolean {
  if (!where) return true;
  if (typeof where !== "object" || Array.isArray(where)) {
    throw badQuery("`where` must be an object, like { done: false }.");
  }
  for (const [field, condition] of Object.entries(where)) {
    if (field === "$or" || field === "$and") {
      if (!Array.isArray(condition)) throw badQuery(`${field} takes a list, like { ${field}: [{ a: 1 }, { b: 2 }] }.`);
      const results = condition.map((sub) => matches(doc, sub as Where));
      if (field === "$or" ? !results.some(Boolean) : !results.every(Boolean)) return false;
      continue;
    }
    if (field === "$not") {
      if (matches(doc, condition as Where)) return false;
      continue;
    }
    if (!matchField(getPath(doc, field), condition)) return false;
  }
  return true;
}

function isOperatorObject(condition: unknown): condition is Record<string, unknown> {
  if (!condition || typeof condition !== "object" || Array.isArray(condition)) return false;
  const keys = Object.keys(condition);
  return keys.length > 0 && keys.every((k) => k.startsWith("$"));
}

function matchField(value: unknown, condition: unknown): boolean {
  if (!isOperatorObject(condition)) return equalsOrContains(value, condition);
  for (const [op, arg] of Object.entries(condition)) {
    if (!applyOperator(op, value, arg)) return false;
  }
  return true;
}

function applyOperator(op: string, value: unknown, arg: unknown): boolean {
  switch (op) {
    case "$eq":
      return equalsOrContains(value, arg);
    case "$ne":
      return !equalsOrContains(value, arg);
    case "$gt":
      return compare(value, arg) > 0;
    case "$gte":
      return compare(value, arg) >= 0;
    case "$lt":
      return compare(value, arg) < 0;
    case "$lte":
      return compare(value, arg) <= 0;
    case "$in":
      if (!Array.isArray(arg)) throw badQuery("$in takes a list, like { status: { $in: ['open', 'draft'] } }.");
      return arg.some((candidate) => equalsOrContains(value, candidate));
    case "$nin":
      if (!Array.isArray(arg)) throw badQuery("$nin takes a list.");
      return !arg.some((candidate) => equalsOrContains(value, candidate));
    case "$exists":
      return (value !== undefined) === Boolean(arg);
    case "$contains":
      if (typeof value === "string" && typeof arg === "string") return value.toLowerCase().includes(arg.toLowerCase());
      if (Array.isArray(value)) return value.some((v) => deepEqual(v, arg));
      return false;
    case "$startsWith":
      return typeof value === "string" && typeof arg === "string" && value.startsWith(arg);
    default:
      throw badQuery(`Unknown operator ${op}. Cardboard understands ${OPERATORS.join(", ")}, $or, $and and $not.`);
  }
}

function equalsOrContains(value: unknown, expected: unknown): boolean {
  if (Array.isArray(value) && !Array.isArray(expected)) return value.some((v) => deepEqual(v, expected));
  return deepEqual(value, expected);
}

/** NaN when the two values can't be ordered (different types), which makes every comparison false. */
function compare(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  return Number.NaN;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return (
    ka.length === kb.length &&
    ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
  );
}

export interface Sortable {
  key: string;
  value: unknown;
  createdAt: number;
  updatedAt: number;
}

/** "-stars", "title", or ["-stars", "title"]. `$key`, `$createdAt`, `$updatedAt` sort by metadata. */
export function sortItems<T extends Sortable>(items: T[], sort: string | string[] | undefined): T[] {
  if (!sort || (Array.isArray(sort) && sort.length === 0)) return items;
  const specs = (Array.isArray(sort) ? sort : sort.split(","))
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (s.startsWith("-") ? { path: s.slice(1), dir: -1 } : { path: s.replace(/^\+/, ""), dir: 1 }));

  const pick = (item: T, path: string): unknown => {
    if (path === "$key") return item.key;
    if (path === "$createdAt") return item.createdAt;
    if (path === "$updatedAt") return item.updatedAt;
    return getPath(item.value, path);
  };

  return [...items].sort((x, y) => {
    for (const { path, dir } of specs) {
      const a = pick(x, path);
      const b = pick(y, path);
      if (a === undefined && b === undefined) continue;
      if (a === undefined) return 1; // missing values always last
      if (b === undefined) return -1;
      const c = compare(a, b);
      if (c !== 0 && !Number.isNaN(c)) return c * dir;
    }
    return x.key < y.key ? -1 : x.key > y.key ? 1 : 0;
  });
}

function badQuery(message: string) {
  return fail("bad_query", 400, message);
}
