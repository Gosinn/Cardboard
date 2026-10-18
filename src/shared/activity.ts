/**
 * Turns log entries into plain English, on your device, after it has opened
 * the sealed names in them. The server only ever stored "tape_x put <sealed>".
 */

export type Outcome = "ok" | "denied" | "error";

export interface OpenedEntry {
  action: string;
  outcome: Outcome;
  count: number | null;
  /** The server's own words. */
  note: string | null;
  /** Who did it: "You (on Laptop)", "notes (tape “default”)". */
  who: string;
  /** The opened name the entry is about: an item key, a dock, a tape label, a device. */
  what: string | null;
  box: string | null;
  dock: string | null;
  /** Opened details the app or device attached (e.g. what sensitive data it spotted). */
  detail: { notices?: string[] } | null;
}

export function describe(e: OpenedEntry): string {
  const { who } = e;
  const key = e.what ? `“${e.what}”` : "something";
  const count = (n: number | null, word: string) => `${n ?? 0} ${word}${n === 1 ? "" : "s"}`;
  const dock = e.dock ? `dock “${e.dock}”` : e.what && e.action.startsWith("dock") ? `dock “${e.what}”` : "a dock";
  const box = e.box ?? "a box";
  if (e.action === "alarm" || e.action === "recovered") return `Security: ${e.note ?? "something looked like an attack"}`;
  if (e.outcome === "denied" && e.action === "dock.customs") return `Customs stopped a parcel for ${who} on ${dock}: ${e.note ?? "it wasn't safe"}`;
  if (e.outcome === "denied") return `${who} was blocked${e.action !== "auth" ? ` (${e.action})` : ""}: ${e.note ?? "not allowed"}`;
  if (e.outcome === "error") return `${who} hit an error (${e.action}): ${e.note ?? "unknown error"}`;
  const sensitive = e.detail?.notices?.length ? ` (${e.detail.notices[0]})` : "";
  switch (e.action) {
    case "read":
      return `${who} read ${key}`;
    case "put":
      return `${who} saved ${key}${sensitive}`;
    case "delete":
      return `${who} deleted ${key}`;
    case "purge":
      return `${who} permanently deleted ${key} and its history`;
    case "list":
      return `${who} listed ${count(e.count, "key")} in ${box}`;
    case "query":
      return `${who} read ${count(e.count, "item")} in ${box}`;
    case "history":
      return `${who} looked at the history of ${key}`;
    case "undo":
      return `${who} undid a change to ${key}`;
    case "batch":
      return `${who} made ${count(e.count, "change")} in one go${sensitive}`;
    case "watch":
      return `${who} started watching ${box}`;
    case "expire":
      return `${count(e.count, "item")} in ${box} expired and ${e.count === 1 ? "was" : "were"} deleted for good`;
    case "introduce":
      return `${who} introduced itself`;
    case "account.create":
      return `${who} made this account`;
    case "device.add":
      return `${who} added a device${e.what ? `: “${e.what}”` : ""}`;
    case "device.remove":
      return `${who} removed a device${e.what ? `: “${e.what}”` : ""}`;
    case "device.lock":
      return `${who} locked ${e.what ? `“${e.what}”` : "a device"} with Face ID (a passkey)`;
    case "device.unlock":
      return `${who} took the Face ID lock off ${e.what ? `“${e.what}”` : "a device"}`;
    case "share.create":
      return `${who} made a link to share ${box}${e.what ? ` with ${e.what}` : ""}${e.note ? ` (${e.note})` : ""}`;
    case "share.revoke":
      return `${who} cancelled a link to share ${box}${e.what ? ` with ${e.what}` : ""}`;
    case "member.join":
      return `${who} joined ${box}${e.note ? ` (${e.note})` : ""}`;
    case "member.leave":
      return `${who} left ${box}`;
    case "member.remove":
      return `${who} took ${e.what ?? "someone"} off ${box}`;
    case "recovery.set":
      return `${who} changed the recovery plan to ${planName(e.note)}`;
    case "profile.set":
      return `${who} changed your profile`;
    case "box.create":
      return `${who} created the box ${e.what ?? box}`;
    case "box.shred":
      return `${who} shredded a box`;
    case "box.settings":
      return `${who} changed the settings of ${box}${e.note ? ` (${e.note})` : ""}`;
    case "box.rename":
      return `${who} renamed a box to ${box}`;
    case "box.rewind":
      return `${who} rewound ${box} (${count(e.count, "item")} changed)${e.note ? ` to ${e.note}` : ""}`;
    case "tape.create":
      return `${who} made a new tape${e.what ? ` “${e.what}”` : ""} for ${box}`;
    case "tape.revoke":
      return `${who} revoked the tape${e.what ? ` “${e.what}”` : ""}`;
    case "dock.request":
      return `${who} asked to ${e.note ?? "dock"} on ${dock}`;
    case "dock.send":
      return `${who} sent a parcel on ${dock} (to ${count(e.count, "app")})`;
    case "dock.receive":
      return `${who} picked up ${count(e.count, "parcel")} from ${dock}`;
    case "dock.watch":
      return `${who} started listening on ${dock}`;
    case "dock.create":
      return `${who} opened ${dock}`;
    case "dock.grant":
      return `${who} let ${box} ${e.note ?? "dock"} on ${dock}`;
    case "dock.approve":
      return `${who} approved ${box} to ${e.note ?? "dock"} on ${dock}`;
    case "dock.deny":
      return `${who} refused ${box} on ${dock}`;
    case "dock.remove":
      return `${who} took ${box} off ${dock}`;
    case "dock.settings":
      return `${who} changed the settings of ${dock}`;
    case "dock.peek":
      return `${who} looked inside ${dock}`;
    case "dock.shred":
      return `${who} shredded a dock`;
    case "app.register":
      return `${who} added the app ${e.note ?? ""}`.trim();
    case "app.connect":
      return `${who} let ${e.note ?? "an app"} in`;
    case "app.deny":
      return `${who} turned down ${e.note ?? "an app"}`;
    case "app.disconnect":
      return `${who} disconnected ${e.note ?? "an app"}`;
    case "app.forget":
      return `${who} forgot the app ${e.note ?? ""}`.trim();
    default:
      return `${who}: ${e.action}${e.what ? ` ${key}` : ""}`;
  }
}

export function planName(plan: string | null | undefined): string {
  switch (plan) {
    case "kit":
      return "a recovery kit";
    case "device":
      return "another device";
    case "friends":
      return "trusted friends";
    case "none":
      return "no recovery";
    default:
      return plan ?? "something";
  }
}
