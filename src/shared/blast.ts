import { describeDuration, relativeTime } from "./duration.ts";
import { formatBytes } from "./size.ts";
import { describeCounts } from "./detect.ts";
import type { Inventory } from "./labels.ts";

export interface BlastRadius {
  summary: string;
  active: boolean;
  read: boolean;
  write: boolean;
  reach: { items: number; bytes: number };
  sensitive: Inventory["sensitive"];
}

export interface TapeShape {
  read: boolean;
  write: boolean;
  idleMs: number | null;
  expiresAt: number | null;
}

/**
 * "If this tape leaks, someone could…": exactly what a leaked tape would
 * expose, in one paragraph. A tape carries its box's key, so a leak is about
 * reach, not just access: it's worked out on your device from your opened data.
 */
export function blastRadius(tape: TapeShape, state: string, box: { name: string; historyDays: number }, reach: Inventory, now: number): BlastRadius {
  const base = { active: state === "active", read: tape.read, write: tape.write, reach: { items: reach.items, bytes: reach.bytes }, sensitive: reach.sensitive };
  if (state !== "active") return { ...base, summary: `This tape ${state}. It can't open anything any more.` };

  const verb = tape.read && tape.write ? "read and change" : tape.read ? "read" : "overwrite or delete (but not read)";
  const what = reach.items === 0 ? `anything stored in ${box.name} (it's empty right now)` : `${reach.items} item${reach.items === 1 ? "" : "s"} (${formatBytes(reach.bytes)}) in ${box.name}`;
  const sensitive = tape.read ? describeCounts(reach.sensitive) : "";

  let summary = `If this tape leaks, someone could ${verb} ${what}${sensitive ? `, including ${sensitive}` : ""}.`;
  if (tape.write) {
    summary += box.historyDays > 0 ? ` Changes they make can be undone for ${box.historyDays} days.` : " This box keeps no history, so their changes couldn't be undone.";
  }
  if (tape.expiresAt !== null) summary += ` It expires ${relativeTime(tape.expiresAt, now)}.`;
  else if (tape.idleMs !== null) summary += ` It switches itself off after ${describeDuration(tape.idleMs)} without use.`;
  else summary += " It never expires on its own, so revoke it once you're done with it.";
  summary += " Revoking it stops it at once and deletes the sealed copy of the box key it opens.";
  return { ...base, summary };
}
