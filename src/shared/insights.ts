import { describeDuration } from "./duration.ts";
import { formatBytes } from "./size.ts";
import { describeCounts, SECRET_KINDS, type SensitiveKind } from "./detect.ts";
import type { Inventory } from "./labels.ts";

/**
 * Cardboard looking after you: things worth fixing, most urgent first, each
 * with a fix. Worked out on your own device from your own (opened) data, so
 * the smart part never needs the server to see anything.
 */

export interface Insight {
  level: "danger" | "warn" | "tip";
  title: string;
  detail: string;
  box?: string;
  /** A command that fixes it (for the command line). */
  fix?: string;
  /** Where in the dashboard to fix it: a page (#/…) and what the button says. */
  go?: { page: string; label: string };
}

export type RecoveryPlan = "kit" | "device" | "friends" | "none";

export interface TapeFacts {
  id: string;
  label: string;
  state: string;
  lastUsedAt: number | null;
  createdAt: number;
  /** "link" for a friend box's link, which is meant to last until it's stopped. */
  kind?: string;
  idleMs: number | null;
  expiresAt: number | null;
}

export interface BoxFacts {
  name: string;
  /** Your personal box: passwords belong there, so they're only worth a word if an app can read them. */
  personal?: boolean;
  settings: { quotaBytes: number; secrets: "warn" | "block" };
  createdAt: number;
  stats: { items: number; bytes: number };
  inventory: Inventory | null;
  tapes: TapeFacts[];
  denied24h: number;
  customs24h: number;
}

export interface AccountFacts {
  now: number;
  /** Where this device reaches Cardboard. */
  url: string;
  recovery: { plan: RecoveryPlan; ready: boolean };
  devices: Array<{ name: string; kind?: string; lock?: string | null; lastSeenAt: number | null; createdAt: number; current: boolean }>;
  boxes: BoxFacts[];
  pendingDocks: Array<{ dock: string; box: string; send: boolean; receive: boolean }>;
  docks: Array<{ name: string; unclaimed: number }>;
  /** Security events from the last week (recovery used, a replayed sign-in code…). */
  alarms: Array<{ at: number; text: string }>;
  quota: { used: number; limit: number };
}

const DAY = 24 * 60 * 60 * 1000;
const ORDER = { danger: 0, warn: 1, tip: 2 } as const;

function isLocal(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "[::1]" || host.startsWith("127.");
  } catch {
    return false;
  }
}

export function insights(facts: AccountFacts): Insight[] {
  const out: Insight[] = [];
  const { now } = facts;

  for (const alarm of facts.alarms) {
    const emergency = /emergency access/i.test(alarm.text);
    out.push({
      level: "danger",
      title: alarm.text,
      detail: `${describeDuration(now - alarm.at)} ago. ${emergency ? "If you didn't expect that, stop it now, and remove that link." : "If that wasn't you, check your devices and connected apps."}`,
      fix: emergency ? "cardboard emergency" : "cardboard devices",
      go: { page: "#/you", label: emergency ? "See emergency access" : "See your devices" },
    });
  }

  if (facts.url.startsWith("http://") && !isLocal(facts.url)) {
    out.push({
      level: "danger",
      title: "You're reaching Cardboard over plain HTTP",
      detail: "Your data is sealed before it leaves this device, but your tokens aren't, and the dashboard's own code could be swapped on the way. Ask whoever runs Cardboard to put it behind HTTPS.",
    });
  }

  const others = facts.devices.filter((d) => !d.current);
  if (facts.recovery.plan === "none") {
    out.push({
      level: "warn",
      title: "You chose no recovery",
      detail: `If you lose ${others.length === 0 ? "this device" : "all your devices"}, nobody can get your data back, not even whoever runs Cardboard. That's the point, but a recovery kit is safer.`,
      fix: "cardboard recovery kit",
      go: { page: "#/you", label: "Choose a recovery plan" },
    });
  } else if (facts.recovery.plan === "device" && others.length === 0) {
    out.push({
      level: "warn",
      title: "Your recovery plan needs a second device",
      detail: "You chose to recover with another device, but this is your only one. Pair a phone or another computer, or switch to a recovery kit.",
      fix: "cardboard pair",
      go: { page: "#/you", label: "Add a device" },
    });
  } else if (!facts.recovery.ready) {
    out.push({ level: "danger", title: "Your recovery plan isn't set up", detail: "Make a new recovery kit so you can always get back in.", fix: "cardboard recovery kit", go: { page: "#/you", label: "Make a recovery kit" } });
  }

  for (const d of others) {
    const quiet = now - (d.lastSeenAt ?? d.createdAt);
    if (quiet > 90 * DAY) {
      out.push({
        level: "tip",
        title: `“${d.name}” hasn't been used in ${describeDuration(quiet)}`,
        detail: "If you don't have that device any more, remove it: it holds a copy of your account key.",
        fix: "cardboard devices",
        go: { page: "#/you", label: "See your devices" },
      });
    }
  }

  // Phones and laptops get picked up by other people; a passkey lock means they still can't open anything.
  const unlocked = facts.devices.filter((d) => d.kind === "browser" && !d.lock);
  if (unlocked.length > 0) {
    const self = unlocked.find((d) => d.current);
    out.push({
      level: "tip",
      title: self ? "Lock this browser with Face ID" : `Lock ${unlocked.length === 1 ? `“${unlocked[0]!.name}”` : `${unlocked.length} browsers`} with Face ID`,
      detail:
        "Then anyone who picks up your device (or copies its storage) still can't open your Cardboard without your face, fingerprint or PIN. Works with Face ID, Touch ID, Windows Hello and phone passkeys. Turn it on under You, in each browser.",
      go: self ? { page: "#/you", label: "Lock it" } : undefined,
    });
  }

  if (facts.quota.used > facts.quota.limit * 0.8) {
    out.push({
      level: "warn",
      title: "Your Cardboard is almost full",
      detail: `${formatBytes(facts.quota.used)} of ${formatBytes(facts.quota.limit)} used. Delete what you don't need, or ask whoever runs Cardboard for more room.`,
    });
  }

  for (const p of facts.pendingDocks) {
    const what = p.send && p.receive ? "send and receive" : p.send ? "send" : "receive";
    out.push({
      level: "warn",
      box: p.box,
      title: `${p.box} wants to ${what} on dock “${p.dock}”`,
      detail: "Approve it and the apps are connected straight away (they still won't learn each other's names). Deny it and it stops asking.",
      fix: `cardboard dock approve ${p.dock} ${p.box}`,
      go: { page: "#/docks", label: "See docks" },
    });
  }

  for (const d of facts.docks) {
    if (d.unclaimed > 0) {
      out.push({
        level: "tip",
        title: `${d.unclaimed} parcel${d.unclaimed === 1 ? "" : "s"} on “${d.name}” ${d.unclaimed === 1 ? "has" : "have"} nobody to receive ${d.unclaimed === 1 ? "it" : "them"}`,
        detail: "They wait until they expire, so an app that docks later still gets them. Add a receiving app to the dock, or let them expire.",
        fix: `cardboard dock add ${d.name} <app> --as receive`,
        go: { page: "#/docks", label: "See docks" },
      });
    }
  }

  for (const box of facts.boxes) {
    if (box.customs24h > 0) {
      out.push({
        level: "warn",
        box: box.name,
        title: `Customs stopped ${box.customs24h} parcel${box.customs24h === 1 ? "" : "s"} for ${box.name} in the last day`,
        detail: "Something tried to pass secrets, personal data or something malformed across a dock. Nothing got through. The log says what.",
        fix: `cardboard log ${box.name}`,
        go: { page: `#/box/${encodeURIComponent(box.name)}`, label: "See what happened" },
      });
    }
    if (box.denied24h > 0) {
      out.push({
        level: "warn",
        box: box.name,
        title: `${box.name}: ${box.denied24h} blocked attempt${box.denied24h === 1 ? "" : "s"} in the last day`,
        detail: "A revoked or expired tape, or one reaching beyond what it may do, tried to get in. Check the log to see which.",
        fix: `cardboard log ${box.name}`,
        go: { page: `#/box/${encodeURIComponent(box.name)}`, label: "See what happened" },
      });
    }
    const inv = box.inventory;
    const readers = box.tapes.filter((t) => t.state === "active");
    if (box.personal && inv && inv.secretPaths.length > 0 && readers.length > 0) {
      out.push({
        level: "warn",
        box: box.name,
        title: `${readers.length === 1 ? "An app" : `${readers.length} apps`} can read the passwords in ${box.name}`,
        detail: `${readers.map((t) => t.label).join(", ")} ${readers.length === 1 ? "has a tape" : "have tapes"} for your personal box. Unless you meant that, cut ${readers.length === 1 ? "it" : "them"} off.`,
        fix: `cardboard box ${box.name}`,
        go: { page: `#/box/${encodeURIComponent(box.name)}`, label: "See who can read it" },
      });
    } else if (!box.personal && inv && inv.secretPaths.length > 0) {
      const secrets = Object.fromEntries(Object.entries(inv.sensitive).filter(([kind]) => SECRET_KINDS.has(kind as SensitiveKind))) as Inventory["sensitive"];
      out.push({
        level: "warn",
        box: box.name,
        title: `${box.name} is holding ${describeCounts(secrets)}`,
        detail: `Found at ${inv.secretPaths.slice(0, 3).join("; ")}${inv.secretPaths.length > 3 ? "; …" : ""}. Any tape that can read ${box.name} can use them. Hash passwords, and keep API keys out of app data where you can.`,
        fix: box.settings.secrets === "warn" ? `cardboard set ${box.name} secrets block` : undefined,
        go: { page: `#/box/${encodeURIComponent(box.name)}`, label: "Open the box" },
      });
    }
    if (box.stats.bytes > box.settings.quotaBytes * 0.8) {
      out.push({
        level: "warn",
        box: box.name,
        title: `${box.name} is almost full`,
        detail: `${formatBytes(box.stats.bytes)} of ${formatBytes(box.settings.quotaBytes)} used.`,
        fix: `cardboard set ${box.name} quotaBytes ${formatBytes(box.settings.quotaBytes * 2).replace(" ", "")}`,
        go: { page: `#/box/${encodeURIComponent(box.name)}`, label: "Give it more room" },
      });
    }
    for (const tape of box.tapes) {
      // A friend box's link lasting until it's stopped (and waiting quietly for a friend) is the point of it.
      if (tape.state !== "active" || tape.kind === "link") continue;
      const idleFor = now - (tape.lastUsedAt ?? tape.createdAt);
      if (idleFor > 30 * DAY) {
        out.push({
          level: "tip",
          box: box.name,
          title: `Tape “${tape.label}” for ${box.name} hasn't been used in ${describeDuration(idleFor)}`,
          detail: "If the app that had it is gone, revoke it so it can't be found and used later.",
          fix: `cardboard revoke ${tape.id}`,
          go: { page: `#/box/${encodeURIComponent(box.name)}`, label: "See its tapes" },
        });
      }
      if (tape.idleMs === null && tape.expiresAt === null) {
        out.push({
          level: "tip",
          box: box.name,
          title: `Tape “${tape.label}” for ${box.name} never expires`,
          detail: "Tapes that switch themselves off when unused are safer. Make a new one with the default settings and revoke this one.",
          fix: `cardboard revoke ${tape.id}`,
          go: { page: `#/box/${encodeURIComponent(box.name)}`, label: "See its tapes" },
        });
      }
    }
    if (box.stats.items === 0 && now - box.createdAt > 7 * DAY && box.tapes.every((t) => t.lastUsedAt === null)) {
      out.push({
        level: "tip",
        box: box.name,
        title: `${box.name} has been empty for a week`,
        detail: "If you don't need it, shred it. That also kills its tapes.",
        fix: `cardboard shred ${box.name}`,
        go: { page: `#/box/${encodeURIComponent(box.name)}`, label: "Open the box" },
      });
    }
  }

  return out.sort((a, b) => ORDER[a.level] - ORDER[b.level]);
}
