import { dirname, resolve } from "node:path";
import { describeDuration } from "../shared/duration.ts";
import { formatBytes } from "../shared/size.ts";
import { describeCounts, SECRET_KINDS, type SensitiveKind } from "./detect.ts";
import type { Inventory } from "./labels.ts";
import type { ShakeReport } from "./shake.ts";
import type { Tape } from "./tapes.ts";
import type { Box } from "./vault.ts";

export interface Insight {
  level: "danger" | "warn" | "tip";
  title: string;
  detail: string;
  box?: string;
  /** A command that fixes it. */
  fix?: string;
}

export interface ServerInfo {
  version: string;
  dataDir: string;
  dbFile: string;
  keyFile: string;
  host: string;
  port: number;
  tls: boolean;
  trustProxy: boolean;
  startedAt: number;
}

export interface BoxFacts {
  box: Box;
  stats: { items: number; bytes: number };
  inventory: Inventory;
  tapes: Array<{ tape: Tape; state: string }>;
  denied24h: number;
  customs24h: number;
}

export interface InsightInput {
  now: number;
  info: ServerInfo;
  boxes: BoxFacts[];
  anonymousDenied24h: number;
  lastBackupAt: number | null;
  shake: ShakeReport | null;
  pendingDocks: Array<{ dock: string; box: string; send: boolean; receive: boolean }>;
  docks: Array<{ name: string; count: number; unclaimed: number }>;
}

const DAY = 24 * 60 * 60 * 1000;
const ORDER = { danger: 0, warn: 1, tip: 2 } as const;

export function isLoopback(host: string): boolean {
  return host === "localhost" || host === "::1" || host.startsWith("127.");
}

/** Cardboard looking after you: things worth fixing, most urgent first, each with a fix. */
export function insights(input: InsightInput): Insight[] {
  const out: Insight[] = [];
  const { now, info } = input;

  for (const result of input.shake?.results ?? []) {
    if (result.status === "fail") {
      out.push({
        level: "danger",
        title: `Shake test failed: ${result.title}`,
        detail: result.detail,
        fix: "cardboard shake",
      });
    }
  }

  if (!info.tls && !isLoopback(info.host)) {
    out.push({
      level: "danger",
      title: "Cardboard is reachable over plain HTTP",
      detail:
        "Tapes and data travel unencrypted across your network. Put Cardboard behind HTTPS (Caddy, Tailscale or a Cloudflare Tunnel), or start it with --tls-cert and --tls-key.",
    });
  }

  if (input.anonymousDenied24h >= 20) {
    out.push({
      level: "warn",
      title: `${input.anonymousDenied24h} attempts with bad tapes in the last day`,
      detail: "Something is knocking with tapes Cardboard doesn't recognise. The activity log shows where they came from.",
      fix: "cardboard log",
    });
  }

  for (const p of input.pendingDocks) {
    const what = p.send && p.receive ? "send and receive" : p.send ? "send" : "receive";
    out.push({
      level: "warn",
      box: p.box,
      title: `${p.box} wants to ${what} on dock “${p.dock}”`,
      detail: "Approve it and the apps are connected straight away (they still won't learn each other's names). Deny it and it stops asking.",
      fix: `cardboard dock approve ${p.dock} ${p.box}`,
    });
  }

  for (const d of input.docks) {
    if (d.unclaimed > 0) {
      out.push({
        level: "tip",
        title: `${d.unclaimed} parcel${d.unclaimed === 1 ? "" : "s"} on “${d.name}” ${d.unclaimed === 1 ? "has" : "have"} nobody to receive ${d.unclaimed === 1 ? "it" : "them"}`,
        detail: "They wait until they expire, so an app that docks later still gets them. Add a receiving app to the dock, or let them expire.",
        fix: `cardboard dock add ${d.name} <app> --as receive`,
      });
    }
  }

  for (const facts of input.boxes) {
    const { box, inventory } = facts;

    if (facts.customs24h > 0) {
      out.push({
        level: "warn",
        box: box.name,
        title: `Customs stopped ${facts.customs24h} parcel${facts.customs24h === 1 ? "" : "s"} from ${box.name} in the last day`,
        detail: "It tried to send secrets, personal data or something malformed across a dock. Nothing got through. The log says what.",
        fix: `cardboard log ${box.name}`,
      });
    }

    if (facts.denied24h > 0) {
      out.push({
        level: "warn",
        box: box.name,
        title: `${box.name}: ${facts.denied24h} blocked attempt${facts.denied24h === 1 ? "" : "s"} in the last day`,
        detail: "A revoked or expired tape, or one reaching outside its limits, tried to get in. Check the log to see which.",
        fix: `cardboard log ${box.name}`,
      });
    }

    const secrets = Object.fromEntries(
      Object.entries(inventory.sensitive).filter(([kind]) => SECRET_KINDS.has(kind as SensitiveKind)),
    ) as Inventory["sensitive"];
    if (inventory.secretPaths.length > 0) {
      out.push({
        level: "warn",
        box: box.name,
        title: `${box.name} is holding ${describeCounts(secrets)}`,
        detail: `Found at ${inventory.secretPaths.slice(0, 3).join("; ")}${inventory.secretPaths.length > 3 ? "; …" : ""}. Any tape that can read ${box.name} can use them. Hash passwords, and keep API keys out of app data where you can.`,
        fix: box.settings.secrets === "warn" ? `cardboard set ${box.name} secrets block` : undefined,
      });
    }

    if (facts.stats.bytes > box.settings.quotaBytes * 0.8) {
      out.push({
        level: "warn",
        box: box.name,
        title: `${box.name} is almost full`,
        detail: `${formatBytes(facts.stats.bytes)} of ${formatBytes(box.settings.quotaBytes)} used.`,
        fix: `cardboard set ${box.name} quotaBytes ${formatBytes(box.settings.quotaBytes * 2).replace(" ", "")}`,
      });
    }

    for (const { tape, state } of facts.tapes) {
      if (state !== "active") continue;
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

    if (facts.stats.items === 0 && now - box.createdAt > 7 * DAY && facts.tapes.every((t) => t.tape.lastUsedAt === null)) {
      out.push({
        level: "tip",
        box: box.name,
        title: `${box.name} has been empty for a week`,
        detail: "If you don't need it, shred it. That also kills its tapes.",
        fix: `cardboard shred ${box.name}`,
      });
    }
  }

  const hasData = input.boxes.some((b) => b.stats.items > 0);
  if (hasData && (input.lastBackupAt === null || now - input.lastBackupAt > 7 * DAY)) {
    out.push({
      level: "tip",
      title: input.lastBackupAt === null ? "You haven't made a backup yet" : "No backup in over a week",
      detail:
        "Backups are encrypted copies of the database, so they're safe to keep on any cloud drive. Keep master.key somewhere separate.",
      fix: "cardboard backup",
    });
  }

  if (resolve(dirname(info.keyFile)) === resolve(info.dataDir)) {
    out.push({
      level: "tip",
      title: "Your master key sits next to your data",
      detail:
        "Anyone who copies the data folder gets the lock and the key together. Move master.key somewhere else (another disk, a password manager) and set CARDBOARD_KEY_FILE to its new path.",
    });
  }

  return out.sort((a, b) => ORDER[a.level] - ORDER[b.level]);
}
