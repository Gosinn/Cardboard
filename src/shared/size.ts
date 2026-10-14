import { fail } from "./errors.ts";

const UNITS: Record<string, number> = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 };

/** "500MB", "1.5 GB", "2048" (bytes) → bytes. */
export function parseSize(input: string | number): number {
  if (typeof input === "number" && Number.isFinite(input) && input > 0) return Math.round(input);
  const match = /^\s*(\d+(?:\.\d+)?)\s*([kmgt]?b)?\s*$/i.exec(String(input));
  if (match) {
    const bytes = Math.round(Number(match[1]) * UNITS[(match[2] ?? "b").toLowerCase()]!);
    if (bytes > 0) return bytes;
  }
  throw fail("bad_size", 400, `"${input}" isn't a size Cardboard understands.`, 'Try "500KB", "100MB" or "2GB".');
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = "B";
  for (const u of units) {
    if (value < 1024) break;
    value /= 1024;
    unit = u;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${unit}`;
}
