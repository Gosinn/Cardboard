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
  /** A command that fixes it. */
  fix?: string;
}

export type RecoveryPlan = "kit" | "device" | "friends" | "none";

export interface TapeFacts {
  id: string;
  label: string;
  state: string;
  lastUsedAt: number | null;
  createdAt: number;
  idleMs: number | null;
  expiresAt: number | null;
}

export interface BoxFacts {
  name: string;
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
  devices: Array<{ name: string; lastSeenAt: number | null; createdAt: number; current: boolean }>;
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
    out.push({ level: "danger", title: alarm.text, detail: `${describeDuration(now - alarm.at)} ago. If that wasn't you, check your devices and connected apps.`, fix: "cardboard devices" });
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
    });
  } else if (facts.recovery.plan === "device" && others.length === 0) {
    out.push({
      level: "warn",
      title: "Your recovery plan needs a second device",
      detail: "You chose to recover with another device, but this is your only one. Pair a phone or another computer, or switch to a recovery kit.",
      fix: "cardboard pair",
    });
  } else if (!facts.recovery.ready) {
    out.push({ level: "danger", title: "Your recovery plan isn't set up", detail: "Make a new recovery kit so you can always get back in.", fix: "cardboard recovery kit" });
  }

  for (const d of others) {
    const quiet = now - (d.lastSeenAt ?? d.createdAt);
    if (quiet > 90 * DAY) {
      out.push({
        level: "tip",
        title: `“${d.name}” hasn't been used in ${describeDuration(quiet)}`,
        detail: "If you don't have that device any more, remove it: it holds a copy of your account key.",
        fix: "cardboard devices",
      });
    }
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
    });
  }

  for (const d of facts.docks) {
    if (d.unclaimed > 0) {
      out.push({
        level: "tip",
        title: `${d.unclaimed} parcel${d.unclaimed === 1 ? "" : "s"} on “${d.name}” ${d.unclaimed === 1 ? "has" : "have"} nobody to receive ${d.unclaimed === 1 ? "it" : "them"}`,
        detail: "They wait until they expire, so an app that docks later still gets them. Add a receiving app to the dock, or let them expire.",
        fix: `cardboard dock add ${d.name} <app> --as receive`,
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
      });
    }
    if (box.denied24h > 0) {
      out.push({
        level: "warn",
        box: box.name,
        title: `${box.name}: ${box.denied24h} blocked attempt${box.denied24h === 1 ? "" : "s"} in the last day`,
        detail: "A revoked or expired tape, or one reaching beyond what it may do, tried to get in. Check the log to see which.",
        fix: `cardboard log ${box.name}`,
      });
    }
    const inv = box.inventory;
    if (inv && inv.secretPaths.length > 0) {
      const secrets = Object.fromEntries(Object.entries(inv.sensitive).filter(([kind]) => SECRET_KINDS.has(kind as SensitiveKind))) as Inventory["sensitive"];
      out.push({
        level: "warn",
        box: box.name,
        title: `${box.name} is holding ${describeCounts(secrets)}`,
        detail: `Found at ${inv.secretPaths.slice(0, 3).join("; ")}${inv.secretPaths.length > 3 ? "; …" : ""}. Any tape that can read ${box.name} can use them. Hash passwords, and keep API keys out of app data where you can.`,
        fix: box.settings.secrets === "warn" ? `cardboard set ${box.name} secrets block` : undefined,
      });
    }
    if (box.stats.bytes > box.settings.quotaBytes * 0.8) {
      out.push({
        level: "warn",
        box: box.name,
        title: `${box.name} is almost full`,
        detail: `${formatBytes(box.stats.bytes)} of ${formatBytes(box.settings.quotaBytes)} used.`,
        fix: `cardboard set ${box.name} quotaBytes ${formatBytes(box.settings.quotaBytes * 2).replace(" ", "")}`,
      });
    }
    for (const tape of box.tapes) {
      if (tape.state !== "active") continue;
      const idleFor = now - (tape.lastUsedAt ?? tape.createdAt);
      if (idleFor > 30 * DAY) {
        out.push({
          level: "tip",
          box: box.name,
          title: `Tape “${tape.label}” for ${box.name} hasn't been used in ${describeDuration(idleFor)}`,
          detail: "If the app that had it is gone, revoke it so it can't be found and used later.",
          fix: `cardboard revoke ${tape.id}`,
        });
      }
      if (tape.idleMs === null && tape.expiresAt === null) {
        out.push({
          level: "tip",
          box: box.name,
          title: `Tape “${tape.label}” for ${box.name} never expires`,
          detail: "Tapes that switch themselves off when unused are safer. Make a new one with the default settings and revoke this one.",
          fix: `cardboard revoke ${tape.id}`,
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
      });
    }
  }

  return out.sort((a, b) => ORDER[a.level] - ORDER[b.level]);
}
