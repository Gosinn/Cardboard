import type { Insight } from "../shared/insights.ts";
import type { ShakeReport } from "./shake.ts";

/**
 * What the host should fix. Only about the server itself: the host can't see
 * inside anyone's boxes, so everything about people's data is worked out on
 * their own devices (src/shared/insights.ts).
 */

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
  publicUrl: string;
  signup: "invite" | "open";
  /** Who may make invite links: everyone with an account here, or only the host. */
  invites: "everyone" | "host";
}

export interface HostInsightInput {
  now: number;
  info: ServerInfo;
  /** Bytes free on the disk Cardboard keeps its data on (null if unknown). */
  diskFree?: number | null;
  accounts: number;
  anonymousDenied24h: number;
  lastBackupAt: number | null;
  shake: ShakeReport | null;
}

const DAY = 24 * 60 * 60 * 1000;
const ORDER = { danger: 0, warn: 1, tip: 2 } as const;

export function isLoopback(host: string): boolean {
  return host === "localhost" || host === "::1" || host.startsWith("127.");
}

export function hostInsights(input: HostInsightInput): Insight[] {
  const out: Insight[] = [];
  const { now, info } = input;

  for (const result of input.shake?.results ?? []) {
    if (result.status === "fail") {
      out.push({ level: "danger", title: `Shake test failed: ${result.title}`, detail: result.detail, fix: "cardboard host shake" });
    }
  }

  const publicHttps = info.publicUrl.startsWith("https://");
  if (!info.tls && !isLoopback(info.host) && !publicHttps) {
    out.push({
      level: "danger",
      title: "Cardboard is reachable over plain HTTP",
      detail:
        "Data is sealed end to end, but tokens and the dashboard's own code travel unprotected, and someone on the network could swap the dashboard for one that steals keys. Put Cardboard behind HTTPS (Caddy, Tailscale or a Cloudflare Tunnel) and start it with --public-url https://…, or use --tls-cert and --tls-key.",
    });
  }

  if (input.anonymousDenied24h >= 20) {
    out.push({
      level: "warn",
      title: `${input.anonymousDenied24h} attempts with bad tokens in the last day`,
      detail: "Something is knocking with tokens Cardboard doesn't recognise. Cardboard slows each address down after 30 tries.",
      fix: "cardboard host log",
    });
  }

  if (typeof input.diskFree === "number" && input.diskFree < 5 * 1024 ** 3) {
    const gb = (input.diskFree / 1024 ** 3).toFixed(1);
    out.push({
      level: input.diskFree < 2 * 1024 ** 3 ? "danger" : "warn",
      title: `This computer has ${gb} GB of disk left`,
      detail: "Cardboard stops taking new data when less than 1 GB is free, so it can't fill the disk. Free up space, or move Cardboard's data folder to a bigger disk.",
    });
  }

  if (input.accounts > 0 && (input.lastBackupAt === null || now - input.lastBackupAt > 7 * DAY)) {
    out.push({
      level: "tip",
      title: input.lastBackupAt === null ? "You haven't made a backup yet" : "No backup in over a week",
      detail:
        "Backups hold only sealed data, so they're safe on any cloud drive. Keep a copy of server.key with them: without it, apps would see everyone as a new person.",
      fix: "cardboard host backup",
    });
  }

  if (info.signup === "open") {
    out.push({
      level: "tip",
      title: "Anyone who finds this Cardboard can make an account",
      detail: "They can't see anyone else's data, but they can use your disk. Restart without --open-signup to go back to invites.",
    });
  }

  return out.sort((a, b) => ORDER[a.level] - ORDER[b.level]);
}
