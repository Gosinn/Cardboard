import { describeCounts, scan, SECRET_KINDS, type SensitiveKind } from "./detect.ts";
import type { Item } from "./vault.ts";

/**
 * Labels: Cardboard works out what each box holds by looking at the data, so
 * apps never have to declare a schema. Nothing here is stored; it's computed
 * on demand from the decrypted items.
 */

export interface FieldLabel {
  name: string;
  types: string[];
  /** In how many documents of the collection the field appears. */
  count: number;
  sensitive: SensitiveKind[];
}

export interface CollectionLabel {
  name: string;
  items: number;
  bytes: number;
  fields: FieldLabel[];
  sensitive: Partial<Record<SensitiveKind, number>>;
}

export interface Inventory {
  items: number;
  bytes: number;
  collections: CollectionLabel[];
  /** Number of items containing each kind of sensitive data. */
  sensitive: Partial<Record<SensitiveKind, number>>;
  /** Where secrets live ("settings/ai → apiKey"), never what they are. */
  secretPaths: string[];
  summary: string;
}

const MAX_ITEMS = 20_000;
const LOOSE = "(loose items)";

export function inventory(items: Item[]): Inventory {
  const collections = new Map<
    string,
    { items: number; bytes: number; fields: Map<string, { types: Set<string>; count: number; sensitive: Set<SensitiveKind> }>; sensitive: Partial<Record<SensitiveKind, number>> }
  >();
  const sensitive: Partial<Record<SensitiveKind, number>> = {};
  const secretPaths: string[] = [];
  let bytes = 0;

  for (const item of items.slice(0, MAX_ITEMS)) {
    bytes += item.size;
    const slash = item.key.indexOf("/");
    const name = slash > 0 ? item.key.slice(0, slash) : LOOSE;
    let col = collections.get(name);
    if (!col) collections.set(name, (col = { items: 0, bytes: 0, fields: new Map(), sensitive: {} }));
    col.items++;
    col.bytes += item.size;

    if (item.value && typeof item.value === "object" && !Array.isArray(item.value)) {
      for (const [field, v] of Object.entries(item.value)) {
        let f = col.fields.get(field);
        if (!f) col.fields.set(field, (f = { types: new Set(), count: 0, sensitive: new Set() }));
        f.types.add(typeName(v));
        f.count++;
      }
    }

    const kindsHere = new Set<SensitiveKind>();
    for (const finding of scan(item.value)) {
      kindsHere.add(finding.kind);
      const root = finding.path.split(/[.[]/)[0]!;
      col.fields.get(root)?.sensitive.add(finding.kind);
      if (SECRET_KINDS.has(finding.kind) && secretPaths.length < 20) {
        secretPaths.push(`${item.key} → ${finding.path}`);
      }
    }
    for (const kind of kindsHere) {
      sensitive[kind] = (sensitive[kind] ?? 0) + 1;
      col.sensitive[kind] = (col.sensitive[kind] ?? 0) + 1;
    }
  }

  const labels: CollectionLabel[] = [...collections.entries()]
    .sort(([a], [b]) => (a === LOOSE ? 1 : b === LOOSE ? -1 : a.localeCompare(b)))
    .map(([name, col]) => ({
      name,
      items: col.items,
      bytes: col.bytes,
      sensitive: col.sensitive,
      fields: [...col.fields.entries()]
        .sort(([, a], [, b]) => b.count - a.count)
        .slice(0, 40)
        .map(([fieldName, f]) => ({
          name: fieldName,
          types: [...f.types].sort(),
          count: f.count,
          sensitive: [...f.sensitive],
        })),
    }));

  return {
    items: items.length,
    bytes,
    collections: labels,
    sensitive,
    secretPaths,
    summary: summarize(items.length, labels, sensitive),
  };
}

function typeName(v: unknown): string {
  if (v === null) return "empty";
  if (Array.isArray(v)) return "list";
  if (typeof v === "object") return "object";
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(v)) return "date";
  return typeof v;
}

function summarize(count: number, labels: CollectionLabel[], sensitive: Partial<Record<SensitiveKind, number>>): string {
  if (count === 0) return "Empty.";
  const named = labels.filter((l) => l.name !== LOOSE).map((l) => l.name);
  const parts = [`${count} item${count === 1 ? "" : "s"}`];
  if (named.length > 0) {
    const shown = named.slice(0, 4).join(", ") + (named.length > 4 ? `, +${named.length - 4} more` : "");
    parts[0] += ` in ${named.length} collection${named.length === 1 ? "" : "s"} (${shown})`;
  }
  const sens = describeCounts(sensitive);
  return `${parts.join("")}.${sens ? ` Holds ${sens}.` : " Nothing sensitive spotted."}`;
}
