import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { CardboardError } from "../shared/errors.ts";

/**
 * Your own computer as the server, reachable from anywhere over HTTPS, for
 * free: Cardboard listens on this machine only, and a tunnel carries traffic
 * to it.
 *
 *   tailscale   Tailscale Funnel (a free Tailscale account). A fixed address
 *               like https://laptop.tail1234.ts.net. HTTPS ends on this
 *               computer, so Tailscale only relays encrypted bytes.
 *   cloudflare  A Cloudflare quick tunnel (no account at all). A new random
 *               address every time, and HTTPS ends at Cloudflare. For a quick
 *               try-out only.
 */

export type TunnelKind = "tailscale" | "cloudflare";
export const TUNNEL_KINDS: readonly TunnelKind[] = ["tailscale", "cloudflare"];

export interface Tunnel {
  kind: TunnelKind;
  /** The public address, e.g. https://laptop.tail1234.ts.net */
  url: string;
  /** Something worth telling the person about this kind of tunnel. */
  note: string;
  close(): void;
}

/** A quick tunnel's address in cloudflared's output (never its API's address, which shows up in errors). */
export function cloudflareUrl(text: string): string | null {
  return /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/.exec(text)?.[0] ?? null;
}

/** The address `tailscale funnel` prints once it's live. */
export function funnelUrl(text: string): string | null {
  return /https:\/\/[a-z0-9.-]+\.ts\.net/i.exec(text)?.[0]?.toLowerCase() ?? null;
}

export async function openTunnel(kind: TunnelKind, port: number, options: { say?: (line: string) => void; timeoutMs?: number } = {}): Promise<Tunnel> {
  return kind === "tailscale" ? tailscale(port, options) : cloudflare(port, options);
}

function missing(name: string, hint: string) {
  return new CardboardError(`no_${name}`, 0, `${name} isn't installed on this computer.`, hint);
}

/** Runs a tunnel program until it prints its address; keeps it running after that. */
function watchFor(child: ChildProcess, find: (text: string) => string | null, options: { say?: (line: string) => void; timeoutMs: number; what: string; hint: string }): Promise<string> {
  return new Promise((resolve, reject) => {
    let seen = "";
    let done = false;
    const finish = (err: Error | null, url?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) {
        child.kill();
        reject(err);
      } else resolve(url!);
    };
    const timer = setTimeout(
      () => finish(new CardboardError("tunnel_timeout", 0, `${options.what} didn't come up in time.`, `${options.hint}${seen ? `\nWhat it said:\n${seen.slice(-1500)}` : ""}`)),
      options.timeoutMs,
    );
    const onData = (chunk: Buffer) => {
      const text = chunk.toString();
      seen += text;
      // Show links it prints for you to act on (e.g. "turn Funnel on here").
      if (!done) for (const line of text.split("\n")) if (/https:\/\/login\.|visit|enable/i.test(line)) options.say?.(line.trim());
      const url = find(seen);
      if (url) finish(null, url);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (err: NodeJS.ErrnoException) => finish(err));
    child.on("exit", (code) => finish(new CardboardError("tunnel_failed", 0, `${options.what} stopped (exit code ${code}).`, `${options.hint}${seen ? `\nWhat it said:\n${seen.slice(-1500)}` : ""}`)));
  });
}

async function cloudflare(port: number, options: { say?: (line: string) => void; timeoutMs?: number }): Promise<Tunnel> {
  const child = spawn("cloudflared", ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`], { stdio: ["ignore", "pipe", "pipe"] });
  const url = await watchFor(child, cloudflareUrl, {
    say: options.say,
    timeoutMs: options.timeoutMs ?? 60_000,
    what: "The Cloudflare tunnel",
    hint: "Check this computer is online, and try again.",
  }).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") {
      throw missing("cloudflared", "Mac: brew install cloudflared · Windows: winget install Cloudflare.cloudflared · Linux: see developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads");
    }
    throw err;
  });
  return {
    kind: "cloudflare",
    url,
    note: "A quick tunnel gets a new address every time it starts (devices then sign back in with a recovery kit or by pairing), live updates may not get through, and HTTPS ends at Cloudflare. Fine for a try-out; use --tunnel tailscale for anything longer.",
    close: () => child.kill(),
  };
}

/** The tailscale command: on PATH, or inside the Mac app. */
function tailscaleBinary(): string {
  for (const candidate of ["/Applications/Tailscale.app/Contents/MacOS/Tailscale"]) if (existsSync(candidate)) return candidate;
  return "tailscale";
}

function run(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(bin, args, { timeout: 15_000 }, (err, stdout, stderr) => (err ? reject(Object.assign(err, { output: `${stdout}${stderr}` })) : resolve(stdout))),
  );
}

async function tailscale(port: number, options: { say?: (line: string) => void; timeoutMs?: number }): Promise<Tunnel> {
  const bin = tailscaleBinary();
  const install = "Install Tailscale (free) from tailscale.com/download, log in, and try again.";
  let status: { BackendState?: string; Self?: { DNSName?: string } };
  try {
    status = JSON.parse(await run(bin, ["status", "--json"])) as typeof status;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw missing("tailscale", install);
    throw new CardboardError("tailscale_off", 0, "Tailscale isn't running, or isn't logged in.", "Open Tailscale and log in, then try again.");
  }
  if (status.BackendState !== "Running") throw new CardboardError("tailscale_off", 0, "Tailscale isn't running, or isn't logged in.", "Open Tailscale and log in, then try again.");
  // Runs in the foreground, so the address goes away when Cardboard stops.
  const child = spawn(bin, ["funnel", String(port)], { stdio: ["ignore", "pipe", "pipe"] });
  const url = await watchFor(child, funnelUrl, {
    say: options.say,
    // The first time, Tailscale asks you to turn Funnel on in your browser: give that time.
    timeoutMs: options.timeoutMs ?? 5 * 60_000,
    what: "Tailscale Funnel",
    hint: "The first time, Tailscale shows a link to turn Funnel on for your account: open it, say yes, then try again.",
  });
  const fixed = status.Self?.DNSName ? `https://${status.Self.DNSName.replace(/\.$/, "")}` : url.replace(/\/$/, "");
  return {
    kind: "tailscale",
    url: fixed.toLowerCase(),
    note: "This address stays the same every time. HTTPS ends here on this computer; Tailscale only relays encrypted bytes.",
    close: () => child.kill(),
  };
}
