import { describeDuration, relativeTime } from "../shared/duration.ts";
import { formatBytes } from "../shared/size.ts";
import { describeCounts } from "./detect.ts";
import type { Inventory } from "./labels.ts";
import type { Tape } from "./tapes.ts";
import type { Box } from "./vault.ts";

export interface BlastRadius {
  summary: string;
  active: boolean;
  read: boolean;
  write: boolean;
  prefix: string | null;
  reach: { items: number; bytes: number };
  sensitive: Inventory["sensitive"];
}

/** "If this tape leaks, someone could…": exactly what a leaked tape would expose, in one paragraph. */
export function blastRadius(tape: Tape, state: string, box: Box, reach: Inventory, now: number): BlastRadius {
  const base = {
    active: state === "active",
    read: tape.read,
    write: tape.write,
    prefix: tape.prefix,
    reach: { items: reach.items, bytes: reach.bytes },
    sensitive: reach.sensitive,
  };
  if (state !== "active") {
    return { ...base, summary: `This tape ${state}. It can't open anything any more.` };
  }

  const verb = tape.read && tape.write ? "read and change" : tape.read ? "read" : "overwrite or delete (but not read)";
  const where = tape.prefix ? `under “${tape.prefix}” in ${box.name}` : `in ${box.name}`;
  const what =
    reach.items === 0
      ? `anything stored ${where} (it's empty right now)`
      : `${reach.items} item${reach.items === 1 ? "" : "s"} (${formatBytes(reach.bytes)}) ${where}`;
  const sensitive = tape.read ? describeCounts(reach.sensitive) : "";

  let summary = `If this tape leaks, someone could ${verb} ${what}${sensitive ? `, including ${sensitive}` : ""}.`;
  if (tape.write) {
    summary +=
      box.settings.historyDays > 0
        ? ` Changes they make can be undone for ${box.settings.historyDays} days.`
        : " This box keeps no history, so their changes couldn't be undone.";
  }
  if (tape.expiresAt !== null) {
    summary += ` It expires ${relativeTime(tape.expiresAt, now)}.`;
  } else if (tape.idleMs !== null) {
    summary += ` It switches itself off after ${describeDuration(tape.idleMs)} without use.`;
  } else {
    summary += " It never expires on its own, so revoke it once you're done with it.";
  }
  return { ...base, summary };
}
