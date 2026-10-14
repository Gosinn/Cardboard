import { fail } from "./errors.ts";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const UNITS: Array<[RegExp, number]> = [
  [/^(s|secs?|seconds?)$/, SECOND],
  [/^(m|mins?|minutes?)$/, MINUTE],
  [/^(h|hrs?|hours?)$/, HOUR],
  [/^(d|days?)$/, DAY],
  [/^(w|weeks?)$/, 7 * DAY],
  [/^(y|years?)$/, 365 * DAY],
];

/** A duration like "30d", "12h", "90 minutes", or a number of seconds. */
export type Duration = string | number;

/** Parses a human duration into milliseconds. */
export function parseDuration(input: Duration): number {
  if (typeof input === "number") {
    if (!Number.isFinite(input) || input <= 0) throw badDuration(String(input));
    return input * SECOND;
  }
  const match = /^\s*(\d+(?:\.\d+)?)\s*([a-z]+)\s*$/i.exec(input);
  if (match) {
    const amount = Number(match[1]);
    const unit = match[2]!.toLowerCase();
    for (const [pattern, ms] of UNITS) {
      if (pattern.test(unit) && amount > 0) return Math.round(amount * ms);
    }
  }
  throw badDuration(input);
}

function badDuration(input: string) {
  return fail(
    "bad_duration",
    400,
    `"${input}" isn't a duration Cardboard understands.`,
    'Try something like "30s", "10m", "12h", "30d", "2w" or "1y".',
  );
}

/** "3 days", "1 hour", "45 seconds". */
export function describeDuration(ms: number): string {
  const abs = Math.abs(ms);
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (abs < MINUTE) return plural(Math.max(1, Math.round(abs / SECOND)), "second");
  if (abs < HOUR) return plural(Math.round(abs / MINUTE), "minute");
  if (abs < DAY) return plural(Math.round(abs / HOUR), "hour");
  return plural(Math.round(abs / DAY), "day");
}

/** "2 minutes ago", "in 3 days". */
export function relativeTime(at: number, now: number): string {
  if (Math.abs(now - at) < 5 * SECOND) return "just now";
  return at <= now ? `${describeDuration(now - at)} ago` : `in ${describeDuration(at - now)}`;
}
