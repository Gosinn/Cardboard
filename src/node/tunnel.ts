import { execFile, spawn, type ChildProcess } from "node:child_process";
import { Resolver } from "node:dns/promises";
import { existsSync } from "node:fs";
import { CardboardError } from "../shared/errors.ts";

/**
 * Your own computer as the server, reachable from anywhere over HTTPS, for
 * free: Cardboard listens on this machine only, and a tunnel carries traffic
 * to it.
 *
 *   tailscale   Tailscale Funnel (a free Tailscale account). A fixed address
 *               like https://laptop.tail1234.ts.net. HTTPS ends on this
 *               computer, so Tailscale only relays encrypted bytes. Never
 *               touches ports you already share with Tailscale.
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
  /** Takes the address offline. */
  close(): Promise<void>;
}

/** A quick tunnel's address in cloudflared's output (never its API's address, which shows up in errors). */
export function cloudflareUrl(text: string): string | null {
  return /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/.exec(text)?.[0] ?? null;
}

/** What `tailscale serve status --json` says Tailscale is already sharing. */
export interface ServeConfig {
  TCP?: Record<string, unknown>;
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
  AllowFunnel?: Record<string, boolean>;
  Foreground?: Record<string, ServeConfig>;
}

/** The three ports Funnel can use. 443 makes the plainest address. */
export const FUNNEL_PORTS = [443, 8443, 10000] as const;

/**
 * Which Funnel port to use: the first one that's free, or one already sending
 * everything to Cardboard (left from an earlier run). Ports you use for other
 * things are never touched.
 */
export function pickFunnelPort(config: ServeConfig, host: string, localPort: number): { port: number; reuse: boolean } | null {
  const all = [config, ...Object.values(config.Foreground ?? {})];
  for (const port of FUNNEL_PORTS) {
    const used = all.some((c) => c.TCP?.[String(port)] !== undefined || Object.keys(c.Web ?? {}).some((key) => key.endsWith(`:${port}`)));
    if (!used) return { port, reuse: false };
    const handlers = config.Web?.[`${host}:${port}`]?.Handlers ?? {};
    const proxy = handlers["/"]?.Proxy ?? "";
    const ours = Object.keys(handlers).length === 1 && new RegExp(`^(https?://)?(127\\.0\\.0\\.1|localhost):${localPort}/?$`).test(proxy);
    if (ours) return { port, reuse: true };
  }
  return null;
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
    close: async () => {
      child.kill();
    },
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

/** Runs a tailscale command that finishes, showing any link it asks you to open, and waiting while you do. */
function finish(child: ChildProcess, options: { say?: (line: string) => void; timeoutMs: number }): Promise<string> {
  return new Promise((resolve, reject) => {
    let seen = "";
    let asked = false;
    const timer = setTimeout(() => {
      child.kill();
      reject(new CardboardError("tunnel_timeout", 0, "Tailscale was still waiting after 5 minutes.", `If it asked you to turn Funnel on, open that link, say yes, and run this again.${seen ? `\nWhat it said:\n${seen.slice(-1500)}` : ""}`));
    }, options.timeoutMs);
    const onData = (chunk: Buffer) => {
      seen += chunk.toString();
      const link = /https:\/\/login\.tailscale\.com\/\S+/.exec(seen)?.[0];
      if (link && !asked) {
        asked = true;
        options.say?.("Tailscale needs you to switch Funnel on, once. Open this link in your browser and click Enable:");
        options.say?.(`  ${link}`);
        options.say?.("Then come back here: it carries on by itself.");
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(seen);
      else reject(new CardboardError("tunnel_failed", 0, `Tailscale couldn't turn Funnel on (exit code ${code}).`, `What it said:\n${seen.slice(-1500).trim()}`));
    });
  });
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
  const host = status.Self?.DNSName?.replace(/\.$/, "").toLowerCase();
  if (status.BackendState !== "Running" || !host) throw new CardboardError("tailscale_off", 0, "Tailscale isn't running, or isn't logged in.", "Open Tailscale and log in, then try again.");

  let config: ServeConfig = {};
  try {
    config = JSON.parse((await run(bin, ["serve", "status", "--json"])).trim() || "{}") as ServeConfig;
  } catch {
    // Older Tailscale, or nothing shared yet: treat it as nothing shared.
  }
  const pick = pickFunnelPort(config, host, port);
  if (!pick) {
    throw new CardboardError(
      "funnel_ports_taken",
      0,
      "Your Tailscale already uses all three Funnel ports (443, 8443 and 10000) for other things.",
      "See what's on them with: tailscale serve status. Free one up, then try again.",
    );
  }
  // In the background, so it behaves the same on Windows, Mac and Linux; Cardboard turns it off when it stops.
  if (!pick.reuse || !config.AllowFunnel?.[`${host}:${pick.port}`]) {
    const child = spawn(bin, ["funnel", "--bg", `--https=${pick.port}`, String(port)], { stdio: ["ignore", "pipe", "pipe"] });
    await finish(child, { say: options.say, timeoutMs: options.timeoutMs ?? 5 * 60_000 });
  }
  return {
    kind: "tailscale",
    url: pick.port === 443 ? `https://${host}` : `https://${host}:${pick.port}`,
    note: `This address stays the same every time${pick.port === 443 ? "" : ` (port ${pick.port}, because your Tailscale already uses 443 for something else)`}. HTTPS ends here on this computer; Tailscale only relays encrypted bytes.`,
    close: async () => {
      await run(bin, ["funnel", `--https=${pick.port}`, "off"]).catch(() => {
        options.say?.(`Couldn't switch Tailscale Funnel off. Do it with: tailscale funnel --https=${pick.port} off`);
      });
    },
  };
}

// ── Is the address really working? ─────────────────────────────────────────

export interface AddressCheck {
  /** Whether the internet's address book (public DNS) has it yet; null when that couldn't be checked. */
  listed: boolean | null;
  /** Whether Cardboard answers at the address (checked from this computer). */
  answers: boolean;
  /** What went wrong reaching it, in a few words. */
  problem: string | null;
}

/** Asks public DNS (not this computer's, which Tailscale answers itself) whether an address exists yet. */
async function publicDns(host: string): Promise<string[]> {
  const resolver = new Resolver({ timeout: 3000, tries: 2 });
  resolver.setServers(["1.1.1.1", "8.8.8.8"]);
  return resolver.resolve4(host);
}

export async function checkAddress(url: string, options: { fetch?: typeof fetch; resolve?: (host: string) => Promise<string[]> } = {}): Promise<AddressCheck> {
  const host = new URL(url).hostname;
  let listed: boolean | null = null;
  try {
    listed = (await (options.resolve ?? publicDns)(host)).length > 0;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    listed = code === "ENOTFOUND" || code === "ENODATA" ? false : null;
  }
  let answers = false;
  let problem: string | null = null;
  try {
    const res = await (options.fetch ?? fetch)(`${url}/health`, { signal: AbortSignal.timeout(10_000) });
    answers = res.ok && ((await res.json().catch(() => ({}))) as { ok?: boolean }).ok === true;
    if (!answers) problem = `something other than Cardboard answered (status ${res.status})`;
  } catch (err) {
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    problem = plain(cause?.code ?? cause?.message ?? (err as Error).message);
  }
  return { listed, answers, problem };
}

/** Network error codes in plain words (the code stays, for whoever helps you). */
function plain(code: string): string {
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return `this computer can't find that address yet [${code}]`;
  if (code === "ECONNREFUSED") return `nothing is answering there [${code}]`;
  if (/TIMEOUT|ETIMEDOUT|AbortError|aborted/i.test(code)) return `no answer in 10 seconds [${code}]`;
  if (/CERT|TLS|SSL|SELF_SIGNED|VERIFY/i.test(code)) return `its HTTPS certificate isn't ready yet [${code}]`;
  return code;
}

/** What Tailscale says about this computer and what it's sharing (nothing secret in it). */
export async function tailscaleReport(): Promise<string[]> {
  const bin = tailscaleBinary();
  const lines: string[] = [];
  try {
    const status = JSON.parse(await run(bin, ["status", "--json"])) as { BackendState?: string; Self?: { DNSName?: string } };
    lines.push(`Tailscale: ${status.BackendState ?? "unknown"}, this computer is ${status.Self?.DNSName?.replace(/\.$/, "").toLowerCase() ?? "(no name)"}`);
  } catch (err) {
    lines.push((err as NodeJS.ErrnoException).code === "ENOENT" ? "Tailscale: not installed (or not on PATH)" : "Tailscale: not running, or not logged in");
    return lines;
  }
  try {
    const funnel = (await run(bin, ["funnel", "status"])).trim();
    lines.push("Tailscale funnel status:", ...(funnel ? funnel.split("\n").map((l) => `  ${l}`) : ["  (nothing shared)"]));
  } catch (err) {
    lines.push(`Tailscale funnel status failed: ${((err as { output?: string }).output ?? (err as Error).message).trim()}`);
  }
  return lines;
}
