#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { CardboardError } from "./shared/errors.ts";
import { describeDuration, parseDuration, relativeTime } from "./shared/duration.ts";
import { planName } from "./shared/activity.ts";
import { formatBytes } from "./shared/size.ts";
import { VERSION } from "./shared/version.ts";
import type { Insight } from "./shared/insights.ts";
import { qrEncode, qrTerminal } from "./shared/qr.ts";
import type { Tunnel, TunnelKind } from "./node/tunnel.ts";
import { cleanInvite, recoverWithFriends, recoverWithKit, signUp, startPairing, unlock, type Account } from "./client/account.ts";
import { Rpc } from "./client/rpc.ts";
import { configDir, FileStore, writePrivate } from "./node/store.ts";

// node:sqlite and type stripping work fine; their "experimental" banners just aren't useful in a CLI.
process.removeAllListeners("warning");
process.on("warning", (w) => {
  if (w.name === "ExperimentalWarning" && /SQLite|stripTypeScriptTypes|Type Stripping/i.test(w.message)) return;
  console.warn(`${w.name}: ${w.message}`);
});

const HELP = `
Cardboard ${VERSION}: a smart, private deposit box for your apps. End-to-end encrypted:
whoever runs the server can't read what's in it.

  Getting started
    cardboard start                   Start a Cardboard server (first run sets everything up)
    cardboard start --tunnel tailscale   …and put it online from this computer, free, at a fixed https:// address
    cardboard start --tunnel cloudflare  …or at a throwaway address, with no account at all
    cardboard signup [invite-link]    Make your account on this computer (prints your recovery kit)
    cardboard connect <app>           Connect the app in this folder: makes a box + tape, writes .env

  This computer and your other devices
    cardboard whoami                  Your account, this device, your recovery plan
    cardboard pair <url>              Sign this computer in from one you already have (shows a code)
    cardboard devices                 Every device signed in to your account
    cardboard devices add <code>      Approve a new device that's showing a pairing code
    cardboard devices remove <id>     Sign a device out for good (lost or sold it? do this)
    cardboard recover <url> --kit "<code>"         Back in with your recovery kit
    cardboard recover <url> --friends <piece>,<piece>   Back in with your friends' pieces
    cardboard recovery [kit|device|friends|none]   See or change how you'd get back in
                       [--friends 3 --need 2]
    cardboard signout                 Sign this computer out

  Looking around
    cardboard boxes                   Every box, what's in it, last activity
    cardboard box <name>              Labels, tapes and blast radius for one box
    cardboard log [box]               Who touched what, in plain English
    cardboard insights                Things worth fixing, with fixes
    cardboard search <text>           Find something in any box (searched here, not on the server)

  Tapes (access for apps)
    cardboard tape <box> [--read-only] [--label phone] [--idle 30d|never] [--expires 7d]
    cardboard blast <tape-id>         What a leaked tape would expose
    cardboard revoke <tape-id>        Switch a tape off now (live connections drop too)

  Docks (apps swapping data without knowing each other)
    cardboard docks                         Every dock, who's on it, waiting requests
    cardboard dock create <dock> --send a,b --receive c   Open a dock and berth apps in one go
    cardboard dock approve <dock> <app>     Say yes to an app that asked to dock
    cardboard dock deny <dock> <app>        Say no (it stops asking)
    cardboard dock add <dock> <app> --as send|receive|both
    cardboard dock remove <dock> <app>      Take an app off a dock (cuts it off live)
    cardboard dock set <dock> <setting> <value>   personal redact|block|allow · secrets block|allow
                                                  shape '{"item":"string","qty":"number?"}' · ttl 7d
    cardboard dock peek <dock>              What's in flight, and which app really sent it
    cardboard dock shred <dock>             Destroy a dock and everything in flight

  Sign in with Cardboard (apps know you, your data stays with you)
    cardboard apps                          Apps you've signed into, and what each may do
    cardboard apps add <name> --redirect <url>[,url] [--public]   Register an app by hand
    cardboard apps disconnect <app> [--shred]   Cut an app off (and shred what it kept)
    cardboard apps forget <client-id>       Remove an app's registration
    cardboard profile [--name "Gosinn"] [--email you@example.com]   What apps may see, if you allow it

  AI assistants (MCP, running on this computer)
    cardboard assistant add <name> [--see a,b] [--change c]   Give an assistant its own box + what you share
    cardboard assistant list | remove <name>
    cardboard mcp <name>                    The MCP server an assistant starts (stdio)

  Sharing a box with people (family, a partner, a friend)
    cardboard share <box> [--for Anna] [--read-only] [--expires 3d] [--as "Gosinn"]
                                            A one-time link: whoever opens it joins the box
    cardboard shares                        Who each box is shared with, and links not used yet
    cardboard share cancel <link-id>        Cancel a link nobody has used
    cardboard join <link> [--as "Anna"]     Join a box someone shared with you
    cardboard people remove <box> <name>    Take someone off a box (their apps are cut off too)
    cardboard leave <box>                   Leave a box someone shared with you
    cardboard invite [--expires 7d]         An invite link (and QR code) for a friend to join this Cardboard
    cardboard invite list | cancel <id>

  If something happens to you
    cardboard emergency add --for Anna [--wait 7d] [--message "…"] [--as "Gosinn"]
                                            A link (and QR code) for someone you trust. If they use it,
                                            you're warned everywhere; unless you stop it, they get in after the wait
    cardboard emergency                     Your emergency links, and whether anyone is using one
    cardboard emergency stop|allow|remove <name>

  Boxes
    cardboard set <box> <setting> <value>   e.g. secrets block · defaultTtl 30d · quotaBytes 1GB
    cardboard allow <box> <origin>          Let a website call this box from the browser
    cardboard rename <box> <new-name>
    cardboard rewind <box> <when>           Put a box back how it was ("10m", "2h", "2026-10-01")
    cardboard export [box] [--out file]     Plain JSON of one box, or all of them (opened here)
    cardboard import <box> <file>           Load a Cardboard export into a box
    cardboard shred <box>                   Destroy a box, its key, history and tapes. For good.

  Running the server (host)
    cardboard host                          How the server is doing (it can't see anyone's data)
    cardboard host invite [--note "for Siggi"] [--ttl 7d]   An invite link for someone new
    cardboard host accounts | invites | log
    cardboard host shake                    Attack Cardboard and report what held
    cardboard host backup                   Snapshot of the database (only sealed data inside)
    cardboard host delete <account-id> | quota <account-id> <size|default>
    cardboard host login <url> <host-token> Point this CLI at a server you run somewhere else
    cardboard reset-host                    New host token (run on the server; needs the data folder)

  Options for start:  --port 8787  --host 127.0.0.1  --data ./cardboard-data  --key-file <path>
                      --tls-cert <file> --tls-key <file>  --trust-proxy  --open-signup
                      --public-url https://cardboard.example.com   (where people and apps reach you)
                      --backup-every 1d   (snapshots in <data>/backups, newest 10 kept)
                      --invites host      (only the host makes invites; default: everyone can invite friends)
                      --tunnel tailscale|cloudflare   (online from this computer; sets the address and HTTPS)
  The same as environment variables: CARDBOARD_TUNNEL, CARDBOARD_PORT, CARDBOARD_HOST, CARDBOARD_DATA, CARDBOARD_PUBLIC_URL,
                      CARDBOARD_TRUST_PROXY=1, CARDBOARD_OPEN_SIGNUP=1, CARDBOARD_BACKUP_EVERY=1d, CARDBOARD_INVITES=host
`;

interface HostCredentials {
  url: string;
  hostToken: string;
}

const HOST_FILE = join(configDir(), "host.json");
const ASSISTANTS = join(configDir(), "assistants");
const store = new FileStore();

function die(message: string, hint?: string): never {
  console.error(`✗ ${message}`);
  if (hint) console.error(`  ${hint}`);
  process.exit(1);
}

const dim = (s: string) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s: string) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s);
const LEVEL = { danger: "‼", warn: "!", tip: "·" } as const;
const STATUS = { pass: "✓", fail: "✗", warn: "!" } as const;

function defaultUrl(): string {
  return (process.env["CARDBOARD_URL"] ?? loadHost()?.url ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
}

/** The account this computer is signed in to. */
async function account(): Promise<Account> {
  const opened = await unlock(store).catch((err: Error & { code?: string }) => {
    if (err.code === "bad_device") die("This computer was signed out of Cardboard (removed from your account).", "Sign in again: cardboard pair <url>, or cardboard recover <url> --kit \"<code>\"");
    throw err;
  });
  if (!opened) {
    die(
      "This computer isn't signed in to Cardboard yet.",
      "New here? cardboard signup <invite-link>. Already have an account? cardboard pair <url> (approve from a device you have).",
    );
  }
  return opened;
}

function loadHost(): HostCredentials | null {
  const url = process.env["CARDBOARD_URL"];
  const token = process.env["CARDBOARD_HOST_TOKEN"];
  if (url && token) return { url, hostToken: token };
  try {
    return JSON.parse(readFileSync(HOST_FILE, "utf8")) as HostCredentials;
  } catch {
    return null;
  }
}

async function host<T = Record<string, unknown>>(op: string, body: unknown = {}): Promise<T> {
  const creds = loadHost();
  if (!creds) die("This CLI doesn't know a host token.", "Run `cardboard start` on this machine, or `cardboard host login <url> <host-token>`.");
  return new Rpc(creds.url, creds.hostToken).call<T>(`host.${op}`, body);
}

function deviceLabel(): string {
  return `${hostname()} (CLI)`.slice(0, 60);
}

function printKit(kit: string) {
  console.log(`\n  ${bold("Your recovery kit")}  ${dim("(shown once)")}\n`);
  console.log(`      ${bold(kit)}\n`);
  console.log("  Write it down or keep it in your password manager. If you lose every device,");
  console.log("  it's the only way back in: nobody else can help, not even whoever runs Cardboard.");
  console.log(dim("  Prefer another way? cardboard recovery device|friends|none"));
}

/** A link as a QR code a phone camera can scan (only on a real terminal; --no-qr leaves it out). */
function printQr(link: string, show: boolean) {
  if (!show || !process.stdout.isTTY) return;
  console.log(`\n${qrTerminal(qrEncode(link))
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n")}\n`);
}

function printInsights(insights: Insight[]) {
  if (insights.length === 0) return console.log("✓ Nothing to fix. Everything looks good.");
  for (const i of insights) {
    console.log(`${LEVEL[i.level]} ${bold(i.title)}`);
    console.log(`  ${i.detail}`);
    if (i.fix) console.log(dim(`  Fix: ${i.fix}`));
  }
}

async function confirm(question: string, expected: string, given: string | undefined): Promise<void> {
  let answer = given;
  if (!answer) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    answer = (await rl.question(question)).trim();
    rl.close();
  }
  if (answer !== expected) die("That didn't match, so nothing was changed.");
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      port: { type: "string" },
      host: { type: "string" },
      data: { type: "string" },
      "key-file": { type: "string" },
      "tls-cert": { type: "string" },
      "tls-key": { type: "string" },
      "trust-proxy": { type: "boolean" },
      "open-signup": { type: "boolean" },
      "public-url": { type: "string" },
      "backup-every": { type: "string" },
      invites: { type: "string" },
      tunnel: { type: "string" },
      url: { type: "string" },
      dir: { type: "string" },
      force: { type: "boolean" },
      "read-only": { type: "boolean" },
      "write-only": { type: "boolean" },
      send: { type: "string" },
      receive: { type: "string" },
      as: { type: "string" },
      redirect: { type: "string" },
      public: { type: "boolean" },
      shred: { type: "boolean" },
      name: { type: "string" },
      email: { type: "string" },
      label: { type: "string" },
      idle: { type: "string" },
      expires: { type: "string" },
      limit: { type: "string" },
      out: { type: "string" },
      yes: { type: "string" },
      kit: { type: "string" },
      friends: { type: "string" },
      need: { type: "string" },
      see: { type: "string" },
      change: { type: "string" },
      "no-own": { type: "boolean" },
      note: { type: "string" },
      for: { type: "string" },
      message: { type: "string" },
      wait: { type: "string" },
      "no-qr": { type: "boolean" },
      ttl: { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  const [command, ...args] = positionals;
  if (values.version) return console.log(VERSION);
  if (!command || values.help || command === "help") return console.log(HELP);

  switch (command) {
    // ── Getting started ──────────────────────────────────────────────────

    case "start": {
      const { startServer } = await import("./server/index.ts");
      if ((values["tls-cert"] && !values["tls-key"]) || (!values["tls-cert"] && values["tls-key"])) die("HTTPS needs both --tls-cert and --tls-key.");
      const tunnelKind = values.tunnel ?? process.env["CARDBOARD_TUNNEL"];
      let tunnel: Tunnel | null = null;
      if (tunnelKind) {
        const { openTunnel, TUNNEL_KINDS } = await import("./node/tunnel.ts");
        if (!(TUNNEL_KINDS as readonly string[]).includes(tunnelKind)) die(`There's no "${tunnelKind}" tunnel.`, "Use --tunnel tailscale (a fixed address, free account) or --tunnel cloudflare (no account, new address each time).");
        if (values["public-url"] || values.host || values["tls-cert"]) die("--tunnel picks the address and HTTPS for you.", "Leave out --public-url, --host and --tls-cert.");
        const port = values.port ? Number(values.port) : Number(process.env["CARDBOARD_PORT"] ?? process.env["PORT"] ?? 8787);
        console.log(dim(`\n  Opening a ${tunnelKind} tunnel to this computer…`));
        tunnel = await openTunnel(tunnelKind as TunnelKind, port, { say: (line) => console.log(`  ${line}`) });
      }
      const cb = await startServer({
        dataDir: values.data,
        keyFile: values["key-file"],
        host: values.host,
        port: values.port ? Number(values.port) : undefined,
        tls: values["tls-cert"] ? { cert: values["tls-cert"], key: values["tls-key"]! } : undefined,
        // Behind a tunnel, Cardboard only listens on this computer, and the tunnel says who's calling.
        trustProxy: values["trust-proxy"] || Boolean(tunnel),
        publicUrl: tunnel?.url ?? values["public-url"],
        openSignup: values["open-signup"],
        invites: values.invites === "host" || values.invites === "everyone" ? values.invites : undefined,
        backupEveryMs: values["backup-every"] ? (values["backup-every"] === "never" ? null : parseDuration(values["backup-every"])) : undefined,
      }).catch((err: NodeJS.ErrnoException) => {
        tunnel?.close();
        if (err.code === "EADDRINUSE") die(`Port ${values.port ?? 8787} is already in use.`, "Is Cardboard already running? Or pick another port with --port 8788.");
        throw err;
      });
      if (tunnel) {
        console.log(`\n  ${bold("Cardboard is online")} at ${bold(tunnel.url)}  ${dim(`(and ${cb.url} on this computer)`)}`);
        console.log(dim(`  ${tunnel.note}`));
        console.log(dim("  It's up while this computer is on and awake (Mac: run it with caffeinate -i to stop it sleeping)."));
      } else console.log(`\n  ${bold("Cardboard is open")} at ${cb.url}`);
      console.log(dim(`  Data: ${cb.paths.dataDir} (sealed by people's own devices: the server can't read it)`));
      console.log(dim(`  Server key: ${cb.paths.keyFile}`));
      console.log(dim(`  Sign in with Cardboard issuer: ${cb.publicUrl}`));
      if (cb.hostToken) {
        writePrivate(HOST_FILE, `${JSON.stringify({ url: cb.url, hostToken: cb.hostToken }, null, 2)}\n`);
        console.log(`\n  ${bold("Host token")} (shown once; saved to ${HOST_FILE}):`);
        console.log(`  ${cb.hostToken}`);
        console.log(dim("  It runs the server (invites, backups, the shake test). It can't open anyone's data."));
        if (cb.firstInvite) {
          console.log(`\n  ${bold("Make your account:")} open ${cb.firstInvite}`);
          printQr(cb.firstInvite, !values["no-qr"]);
          console.log(`  (scan it with your phone) or run: ${bold("cardboard signup")}`);
        }
      } else if (tunnel) printQr(tunnel.url, !values["no-qr"]);
      if (cb.shake) {
        console.log(`\n  ${cb.shake.ok ? "✓" : "✗"} Shake test: ${cb.shake.summary}`);
        for (const r of cb.shake.results.filter((r) => r.status !== "pass")) console.log(`    ${STATUS[r.status]} ${r.title}: ${r.detail}`);
      }
      console.log("");
      const stop = async () => {
        tunnel?.close();
        await cb.close();
        process.exit(0);
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      return;
    }

    case "signup": {
      const existing = await store.load();
      if (existing) die(`This computer is already signed in to an account at ${existing.url}.`, "Sign out first: cardboard signout");
      let invite = args[0];
      let url = values.url;
      if (invite && /^https?:\/\//.test(invite)) url ??= new URL(invite).origin;
      if (!invite) {
        // On the machine that runs the server, the host can invite itself.
        if (!loadHost()) die("Signing up needs an invite.", "Ask whoever runs your Cardboard for an invite link, then: cardboard signup <link>");
        const created = await host<{ code: string }>("invite", { note: "made by cardboard signup" });
        invite = created.code;
        url ??= loadHost()!.url;
      }
      const { account: acct, kit } = await signUp({ url: (url ?? defaultUrl()).replace(/\/+$/, ""), invite: cleanInvite(invite), store, kind: "cli", label: values.name ?? deviceLabel() });
      console.log(`\n  ✓ Made your Cardboard account, and signed this computer in (${acct.id}).`);
      printKit(kit);
      console.log(`\n  Next: in your app's folder, run ${bold("cardboard connect <app-name>")}\n`);
      return;
    }

    case "pair": {
      const target = args[0];
      if (target && !/^https?:\/\//.test(target)) die("pair takes the address of your Cardboard.", `On the new device: cardboard pair https://… · To approve a code here: cardboard devices add ${target}`);
      if (await store.load()) die("This computer is already signed in.", "To approve another device, run: cardboard devices add <code>");
      const base = (target ?? defaultUrl()).replace(/\/+$/, "");
      const pending = await startPairing({ url: base, store, kind: "cli", label: values.name ?? deviceLabel() });
      console.log(`\n  Pairing code:  ${bold(pending.code)}`);
      printQr(`${base}/#pair=${pending.code}`, !values["no-qr"]);
      console.log("  Scan it with your phone (signed in to Cardboard), or on a device that's already signed in, run:");
      console.log(`    cardboard devices add ${pending.code}`);
      console.log(dim("  or open You → Add a device in your dashboard and type it in. Waiting (10 minutes)…"));
      const acct = await pending.wait();
      console.log(`\n  ✓ This computer is signed in (${acct.id}).\n`);
      return;
    }

    case "recover": {
      const target = (args[0] ?? defaultUrl()).replace(/\/+$/, "");
      if (await store.load()) die("This computer is already signed in.", "Sign out first: cardboard signout");
      const options = { url: target, store, kind: "cli" as const, label: values.name ?? deviceLabel() };
      let acct: Account;
      if (values.kit) acct = await recoverWithKit({ ...options, code: values.kit });
      else if (values.friends) acct = await recoverWithFriends({ ...options, pieces: values.friends.split(/[,\s]+/).filter(Boolean) });
      else die('Recover with your kit (--kit "XXXX-…") or your friends\' pieces (--friends <piece>,<piece>).');
      console.log(`\n  ✓ You're back in, on this computer (${acct.id}).`);
      console.log(dim("  If your kit (or a piece) may have been seen by someone else, make a new one: cardboard recovery kit"));
      console.log(dim("  And if you lost a device, remove it: cardboard devices\n"));
      return;
    }

    case "whoami": {
      const acct = await account();
      const me = await acct.me();
      if (values.json) return console.log(JSON.stringify(me, null, 2));
      const device = me.devices.find((d) => d.current);
      console.log(`${bold(me.profile.name ?? "Your account")}  ${dim(me.id)}`);
      console.log(`  Server:   ${acct.url}  ${dim(`Cardboard ${me.server.version}`)}`);
      console.log(`  Device:   ${device?.name ?? "this computer"}  ${dim(me.device.id)}`);
      console.log(`  Recovery: ${planName(me.recovery)}${me.recoveryReady ? "" : "  ‼ not set up"}`);
      console.log(`  Storage:  ${formatBytes(me.quota.used)} of ${formatBytes(me.quota.limit)}`);
      return;
    }

    case "devices": {
      const acct = await account();
      const [action, target] = args;
      if (!action) {
        const me = await acct.me();
        if (values.json) return console.log(JSON.stringify(me.devices, null, 2));
        for (const d of me.devices) {
          const seen = d.lastSeenAt ? relativeTime(d.lastSeenAt, Date.now()) : "never";
          console.log(`${d.current ? "→" : " "} ${bold(d.name.padEnd(30))} ${dim(`${d.kind.padEnd(8)} last seen ${seen} · ${d.id}`)}`);
        }
        console.log(dim("\nAdd one: on the new device run `cardboard pair <url>` (or open the dashboard), then `cardboard devices add <code>` here."));
        return;
      }
      if (action === "add") {
        const device = await acct.approveDevice(need(target, "Which code? cardboard devices add <code>"), values.name);
        return console.log(`✓ Approved. The new device (${device.id}) is signing in now.`);
      }
      if (action === "remove") {
        const res = await acct.removeDevice(need(target, "Which device? cardboard devices remove <id> (ids are in: cardboard devices)"));
        return console.log(res.self ? "✓ Signed this computer out." : `✓ Removed ${target}. Its token stopped working and its copy of your account key is gone.`);
      }
      if (action === "rename") {
        await acct.renameDevice(need(target, "Which device?"), need(args[2], "What should it be called?"));
        return console.log("✓ Renamed.");
      }
      return die("Usage: cardboard devices [add <code> | remove <id> | rename <id> <name>]");
    }

    case "recovery": {
      const acct = await account();
      const plan = args[0];
      if (!plan) {
        const me = await acct.me();
        console.log(`Your recovery plan: ${bold(planName(me.recovery))}${me.recoveryReady ? "" : "  ‼ not set up"}`);
        console.log(dim("Change it: cardboard recovery kit (the standard) · device · friends [--friends 3 --need 2] · none"));
        return;
      }
      if (plan !== "kit" && plan !== "device" && plan !== "friends" && plan !== "none") die("Pick kit, device, friends or none.");
      if (plan === "none") await confirm('With no recovery, losing your devices means losing your data. Type "none" to confirm: ', "none", values.yes);
      const res = await acct.setRecovery(plan, { count: values.friends ? Number(values.friends) : undefined, threshold: values.need ? Number(values.need) : undefined });
      if (res.kit) {
        console.log("✓ New recovery kit. Your old kit (if any) stopped working.");
        printKit(res.kit);
      } else if (res.pieces) {
        console.log(`✓ Trusted friends: any ${res.threshold} of these ${res.pieces.length} pieces get you back in. Give one to each friend.\n`);
        res.pieces.forEach((p, i) => console.log(`  Piece ${i + 1}:  ${bold(p)}`));
        console.log(dim("\n  One piece alone reveals nothing. Your old kit (if any) stopped working."));
      } else if (plan === "device") {
        console.log("✓ You'll recover by approving a new device from one you still have. Keep at least two devices signed in.");
      } else {
        console.log("✓ No recovery. Only your signed-in devices can open your Cardboard.");
      }
      return;
    }

    case "signout": {
      const acct = await account();
      await acct.signOut();
      return console.log("✓ Signed this computer out. Its copy of your account key is gone from the server.");
    }

    case "delete-account": {
      const acct = await account();
      await confirm(`This deletes your account and everything in it (${acct.id}), for good.\nType "delete" to confirm: `, "delete", values.yes);
      await acct.deleteAccount();
      return console.log("✓ Deleted. Nothing of yours is left on the server.");
    }

    case "connect": {
      const dir = resolve(values.dir ?? ".");
      const pkg = readPackageJson(dir);
      const name = args[0] ?? slug(pkg?.name?.replace(/^@[^/]+\//, "") ?? basename(dir));
      const envFile = join(dir, ".env");
      const env = existsSync(envFile) ? readFileSync(envFile, "utf8") : "";
      if (/^\s*CARDBOARD_TAPE\s*=/m.test(env) && !values.force) die(`${envFile} already has a CARDBOARD_TAPE.`, "Run with --force to replace it with a new tape.");
      const acct = await account();
      const exists = (await acct.boxes()).some((b) => b.name === name);
      if (!exists) await acct.createBox(name);
      const { secret } = await acct.createTape(name, tapeOptions(values, `${basename(dir)} on ${hostname()}`));
      const profile = { title: pkg?.name?.slice(0, 60), description: pkg?.description?.slice(0, 200), version: pkg?.version?.slice(0, 40) };
      if (profile.title || profile.description || profile.version) {
        await acct.setBoxProfile(name, Object.fromEntries(Object.entries(profile).filter(([, v]) => v)));
      }
      writeEnv(envFile, env, { CARDBOARD_URL: acct.url, CARDBOARD_TAPE: secret });
      const ignored = ensureGitignored(dir);
      console.log(`\n  ✓ ${exists ? "Connected to the existing box" : "Made a box called"} ${bold(name)}`);
      console.log(`  ✓ Wrote CARDBOARD_URL and CARDBOARD_TAPE to ${envFile}`);
      console.log(`  ✓ ${ignored === "added" ? "Added .env to .gitignore" : ".env is already in .gitignore"}, so the tape won't end up in git`);
      console.log(dim("    The tape holds the box key: everything your app stores is sealed before it leaves the app."));
      console.log(`\n  ${dim("// in your app")}`);
      console.log(`  import { open } from "cardboard";`);
      console.log(`  const box = open();`);
      console.log(`  await box.put("hello", { from: "${name}" });\n`);
      return;
    }

    // ── Looking around ───────────────────────────────────────────────────

    case "boxes": {
      const acct = await account();
      const boxes = await acct.boxes();
      if (values.json) return console.log(JSON.stringify(boxes.map(({ keys: _k, ...b }) => b), null, 2));
      if (boxes.length === 0) return console.log("No boxes yet. Make one with: cardboard connect <app-name>");
      const docks = boxes.some((b) => b.docks.length) ? (await acct.docks()).docks : [];
      for (const b of boxes) {
        const last = b.lastActivity ? relativeTime(b.lastActivity, Date.now()) : "never used";
        console.log(`${bold(b.name.padEnd(24))} ${String(b.items).padStart(6)} items  ${formatBytes(b.bytes).padStart(8)}  ${dim(last)}`);
        if (b.shared) console.log(dim(`  Shared with you by ${b.shared.from}${b.shared.write ? "" : " (read only)"}`));
        else if (b.people.members.length) console.log(dim(`  Shared with ${b.people.members.map((m) => m.name).join(", ")}`));
        if (b.profile.description || b.profile.version) console.log(dim(`  ${[b.profile.description, b.profile.version && `v${b.profile.version}`].filter(Boolean).join(" · ")}`));
        console.log(dim(`  ${(await acct.inventory(b)).summary}`));
        if (b.docks.length) console.log(dim(`  Docks: ${b.docks.map((d) => `${docks.find((x) => x.id === d.dock)?.name ?? "?"} (${arrows(d)})`).join(", ")}`));
      }
      return;
    }

    case "box": {
      const acct = await account();
      const box = await acct.box(need(args[0], "Which box? cardboard box <name>"));
      const inv = await acct.inventory(box);
      if (values.json) return console.log(JSON.stringify({ box: { ...box, keys: undefined }, inventory: inv }, null, 2));
      console.log(`\n${bold(box.name)}  ${dim(`${box.items} items · ${formatBytes(box.bytes)}`)}`);
      console.log(`  ${inv.summary}\n`);
      for (const c of inv.collections) {
        console.log(`  ${bold(c.name)} ${dim(`${c.items} items`)}`);
        for (const f of c.fields.slice(0, 12)) console.log(`    ${f.name.padEnd(20)} ${dim(f.types.join(" | "))}${f.sensitive.length ? `  ⚑ ${f.sensitive.join(", ")}` : ""}`);
      }
      console.log(`\n  ${bold("Tapes")}`);
      for (const t of box.tapes) {
        console.log(`  ${t.id}  “${t.label}”  ${[t.read && "read", t.write && "write"].filter(Boolean).join("+")}  ${dim(t.state)}`);
        console.log(dim(`    ${(await acct.blast(t, box)).summary}`));
      }
      if (box.shared || box.people.members.length) {
        console.log(`\n  ${bold("People")}`);
        if (box.shared) console.log(`  ${box.shared.from}  ${dim("owner")}`);
        for (const m of box.people.members) console.log(`  ${m.name}${m.you ? " (you)" : ""}  ${dim(`${m.write ? "can change it" : "read only"} · ${m.apps} app${m.apps === 1 ? "" : "s"} · joined ${relativeTime(m.joinedAt, Date.now())}`)}`);
      }
      console.log(`\n  ${bold("Recent activity")}`);
      for (const e of (await acct.log({ box: box.name, limit: 10 })).slice(0, 10)) console.log(`  ${dim(relativeTime(e.at, Date.now()).padEnd(16))} ${e.text}`);
      console.log("");
      return;
    }

    case "log": {
      const acct = await account();
      const entries = await acct.log({ box: args[0], limit: values.limit ? Number(values.limit) : 40 });
      if (values.json) return console.log(JSON.stringify(entries, null, 2));
      for (const e of entries.reverse()) {
        const mark = e.outcome === "denied" ? "✗ " : e.outcome === "error" ? "! " : "  ";
        console.log(`${dim(new Date(e.at).toLocaleString().padEnd(22))} ${mark}${e.text}`);
      }
      return;
    }

    case "insights": {
      const acct = await account();
      const insights = await acct.insights();
      if (values.json) return console.log(JSON.stringify(insights, null, 2));
      return printInsights(insights);
    }

    case "search": {
      const acct = await account();
      const results = await acct.search(need(args.join(" "), "What should I look for? cardboard search <text>"));
      if (results.length === 0) return console.log("Nothing found.");
      for (const r of results) console.log(`${bold(r.box)} ${r.key}${r.snippet ? dim(`  …${r.snippet}…`) : ""}`);
      return;
    }

    // ── Tapes ────────────────────────────────────────────────────────────

    case "tape": {
      const acct = await account();
      const name = need(args[0], "Which box? cardboard tape <box>");
      const { tape, secret } = await acct.createTape(name, tapeOptions(values, values.label ?? "manual"));
      console.log(`\n  New tape ${tape.id} for ${bold(name)}:\n`);
      console.log(`  ${secret}\n`);
      console.log(dim(`  ${(await acct.blast(tape, await acct.box(name))).summary}`));
      console.log(dim("  This is the only time the tape is shown. It carries the box key, so keep it like a password.\n"));
      return;
    }

    case "blast": {
      const acct = await account();
      const found = await acct.tape(need(args[0], "Which tape? cardboard blast <tape-id>"));
      if (!found) die(`There's no tape ${args[0]}.`, "Tape ids are listed by: cardboard box <name>");
      return console.log((await acct.blast(found.tape, found.box)).summary);
    }

    case "revoke": {
      const acct = await account();
      const id = need(args[0], "Which tape? cardboard revoke <tape-id>");
      await acct.revokeTape(id);
      return console.log(`✓ Revoked ${id}. Anything using it is locked out now, including live connections.`);
    }

    // ── Docks ────────────────────────────────────────────────────────────

    case "docks": {
      const acct = await account();
      const data = await acct.docks();
      if (values.json) return console.log(JSON.stringify(data, null, 2));
      if (data.pending.length) {
        console.log(bold("Waiting for you"));
        for (const p of data.pending) console.log(`  ${p.box} wants to ${arrows(p, true)} on ${bold(p.dock)}  ${dim(`→ cardboard dock approve ${p.dock} ${p.box}`)}`);
        console.log("");
      }
      const open = data.docks.filter((d) => d.name);
      if (open.length === 0) return console.log("No docks yet. Open one with: cardboard dock create <name> --send <app> --receive <app>");
      for (const d of open) {
        console.log(`${bold(d.name!)}  ${dim(d.inFlight.count ? `${d.inFlight.count} in flight` : "nothing in flight")}`);
        for (const b of d.berths) {
          const state = b.denied ? "refused" : !b.send && !b.receive ? "asking" : arrows(b);
          console.log(`  ${b.box.padEnd(24)} ${state.padEnd(16)} ${dim(`known there as ${b.tag}`)}`);
        }
      }
      return;
    }

    case "dock": {
      const acct = await account();
      const [action, dock, app] = args;
      const needDock = () => need(dock, `Which dock? cardboard dock ${action} <dock>`);
      const needApp = () => need(app, `Which app? cardboard dock ${action} <dock> <app>`);
      const list = (v: string | undefined) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : []);
      switch (action) {
        case "create": {
          const created = await acct.createDock(needDock(), { send: list(values.send), receive: list(values.receive) });
          console.log(`✓ Opened ${bold(created.name!)}.`);
          for (const b of created.berths) console.log(`  ${b.box} can ${arrows(b, true)}, known there as ${b.tag}`);
          if (!values.send && !values.receive) console.log(dim("  No apps yet. Apps that use it will ask to dock, and you approve them."));
          return;
        }
        case "approve":
          await acct.dockApprove(needDock(), needApp());
          return console.log(`✓ ${app} is docked at ${dock}. If it's listening, it starts right now.`);
        case "deny":
          await acct.dockDeny(needDock(), needApp());
          return console.log(`✓ Refused. ${app} can't use ${dock} and won't ask again.`);
        case "add": {
          const as = values.as ?? "both";
          if (!["send", "receive", "both"].includes(as)) die("--as must be send, receive or both.");
          await acct.dockGrant(needDock(), needApp(), { send: as !== "receive", receive: as !== "send" });
          return console.log(`✓ ${app} can ${as === "both" ? "send and receive" : as} on ${dock}.`);
        }
        case "remove": {
          const removed = await acct.dockRemove(needDock(), needApp());
          return console.log(removed ? `✓ Took ${app} off ${dock}. Its live connection is closed.` : `${app} wasn't on ${dock}.`);
        }
        case "set": {
          const [, , setting, ...rest] = args;
          if (!dock || !setting || rest.length === 0) die("Usage: cardboard dock set <dock> <setting> <value>");
          const raw = rest.join(" ");
          await acct.dockSettings(dock, { [setting]: setting === "ratePerMinute" ? Number(raw) : raw === "null" ? null : raw });
          return console.log(`✓ ${dock}: ${setting} = ${raw}`);
        }
        case "peek": {
          const parcels = await acct.dockPeek(needDock());
          if (parcels.length === 0) return console.log("Nothing in flight.");
          for (const p of parcels) {
            console.log(`${dim(`#${p.seq} ${relativeTime(p.sentAt, Date.now())}`)} from ${bold(p.sender)}${p.to ? ` to ${p.to}` : ""}`);
            console.log(`  ${JSON.stringify(p.body)}${p.redacted.length ? dim(`  (redacted: ${p.redacted.join(", ")})`) : ""}`);
          }
          return;
        }
        case "shred": {
          const name = needDock();
          await confirm(`This destroys the dock ${name} and everything in flight on it.\nType the dock name to confirm: `, name, values.yes);
          await acct.shredDock(name);
          return console.log(`✓ Shredded the dock ${name}.`);
        }
        default:
          die("Usage: cardboard dock <create|approve|deny|add|remove|set|peek|shred> <dock> [app]", "See: cardboard help");
      }
      return;
    }

    // ── Apps ─────────────────────────────────────────────────────────────

    case "apps": {
      const acct = await account();
      const [action, target] = args;
      if (!action) {
        const data = await acct.apps();
        if (values.json) return console.log(JSON.stringify(data, null, 2));
        console.log(`${bold("Sign in with Cardboard")}  ${dim(`issuer ${data.issuer}`)}`);
        if (data.connected.length === 0) console.log(dim("  No apps connected yet."));
        for (const a of data.connected) {
          console.log(`\n  ${bold(a.name)} ${dim(a.site)}`);
          console.log(`    may: ${a.scopes.join(", ")}${a.boxName ? `  ·  data in box ${a.boxName}` : ""}`);
          console.log(dim(`    knows you as ${a.privateId} · connected ${relativeTime(a.connectedAt, Date.now())} · grant ${a.grant}`));
        }
        if (data.registered.length) {
          console.log(`\n${bold("Registered, not connected")}`);
          for (const c of data.registered) console.log(`  ${c.name}  ${dim(`${c.client} · ${c.redirectUris.join(", ")}`)}`);
        }
        return;
      }
      if (action === "add") {
        const name = need(target, 'Usage: cardboard apps add "<name>" --redirect <url>');
        const redirectUris = need(values.redirect, "Give the app's callback URL with --redirect https://…/callback").split(",").map((u) => u.trim());
        const r = await acct.registerApp({ name, redirectUris, public: values.public });
        console.log(`✓ Registered ${bold(name)}.\n`);
        console.log(`  issuer         ${(await acct.apps()).issuer}`);
        console.log(`  client_id      ${r.client_id}`);
        if (r.client_secret) console.log(`  client_secret  ${r.client_secret}  ${dim("(shown once; keep it on the app's server)")}`);
        return;
      }
      if (action === "disconnect") {
        const which = need(target, "Which app? cardboard apps disconnect <name or grant id>");
        const { connected } = await acct.apps();
        const match = connected.find((a) => a.grant === which || a.name.toLowerCase() === which.toLowerCase());
        if (!match) die(`No connected app called ${which}.`, "See them with: cardboard apps");
        const r = await acct.disconnectApp(match.grant, { shred: values.shred });
        return console.log(`✓ Disconnected ${r.disconnected}.${r.shredded ? " Shredded its box." : match.boxName ? ` Its box ${match.boxName} is still yours.` : ""}`);
      }
      if (action === "forget") {
        const r = await acct.forgetApp(need(target, "Which client id? cardboard apps forget <client-id>"));
        return console.log(`✓ Forgot ${r.forgotten}.`);
      }
      return die("Usage: cardboard apps [add|disconnect|forget]", "See: cardboard help");
    }

    case "profile": {
      const acct = await account();
      const patch: { name?: string | null; email?: string | null } = {};
      if (values.name !== undefined) patch.name = values.name || null;
      if (values.email !== undefined) patch.email = values.email || null;
      const profile = Object.keys(patch).length ? await acct.setProfile(patch) : (await acct.me()).profile;
      console.log(`Name:  ${profile.name ?? dim("(not set)")}`);
      console.log(`Email: ${profile.email ?? dim("(not set)")}`);
      console.log(dim("Sealed on your devices. Apps only get them if they ask and you say yes, sealed to the app."));
      return;
    }

    // ── AI assistants ────────────────────────────────────────────────────

    case "assistant": {
      const [action, name] = args;
      if (action === "list" || !action) {
        const files = existsSync(ASSISTANTS) ? readdirSync(ASSISTANTS).filter((f) => f.endsWith(".json")) : [];
        if (files.length === 0) return console.log("No assistants yet. Add one: cardboard assistant add claude --see notes");
        for (const f of files) {
          const cfg = readAssistant(f.replace(/\.json$/, ""));
          console.log(`${bold(cfg.name)}  ${dim(cfg.boxes.map((b) => `${b.name}${b.own ? " (its own)" : b.write ? " (can change)" : ""}`).join(", "))}`);
        }
        return;
      }
      const assistantName = need(name, "Which assistant? cardboard assistant add <name>");
      if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(assistantName)) die("Use lowercase letters, numbers and dashes for the assistant's name, like claude.");
      if (action === "remove") {
        const cfg = readAssistant(assistantName);
        const acct = await account();
        for (const b of cfg.boxes) await acct.revokeTape(b.tapeId).catch(() => undefined);
        rmSync(assistantFile(assistantName), { force: true });
        return console.log(`✓ ${assistantName} is cut off: its tapes are revoked and its config is gone.${cfg.boxes.some((b) => b.own) ? " Its own box is still yours." : ""}`);
      }
      if (action !== "add") die("Usage: cardboard assistant add|list|remove <name>");
      const acct = await account();
      const see = (values.see ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      const change = (values.change ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      const previous = existsSync(assistantFile(assistantName)) ? readAssistant(assistantName) : null;
      for (const b of previous?.boxes ?? []) await acct.revokeTape(b.tapeId).catch(() => undefined);
      const boxes: AssistantConfig["boxes"] = [];
      if (!values["no-own"]) {
        const own = `assistant-${assistantName}`;
        if (!(await acct.boxes()).some((b) => b.name === own)) {
          await acct.createBox(own);
          await acct.setBoxProfile(own, { title: `${assistantName}'s memory`, description: `Where ${assistantName} remembers things for you` });
        }
        const { tape, secret } = await acct.createTape(own, { label: assistantName, kind: "assistant", idle: "90d" });
        boxes.push({ name: own, tape: secret, tapeId: tape.id, write: true, own: true });
      }
      for (const boxName of new Set([...see, ...change])) {
        const { tape, secret } = await acct.createTape(boxName, { label: assistantName, kind: "assistant", write: change.includes(boxName), idle: "90d" });
        boxes.push({ name: boxName, tape: secret, tapeId: tape.id, write: change.includes(boxName), own: false });
      }
      writePrivate(assistantFile(assistantName), `${JSON.stringify({ name: assistantName, url: acct.url, boxes } satisfies AssistantConfig, null, 2)}\n`);
      const cli = resolve(process.argv[1] ?? "cardboard");
      console.log(`✓ ${bold(assistantName)} can use: ${boxes.map((b) => `${b.name}${b.own ? " (its own)" : b.write ? " (can change)" : " (read-only)"}`).join(", ")}`);
      console.log(dim("  It holds keys only for these boxes, on this computer. The server still can't read any of it.\n"));
      console.log(`  Claude Code:     claude mcp add cardboard -- node ${cli} mcp ${assistantName}`);
      console.log(`  Claude Desktop:  add to claude_desktop_config.json → "mcpServers":`);
      console.log(`                   { "cardboard": { "command": "node", "args": ["${cli}", "mcp", "${assistantName}"] } }`);
      console.log(dim(`\n  Change what it sees by running this again. Cut it off: cardboard assistant remove ${assistantName}`));
      return;
    }

    case "mcp": {
      const name = need(args[0], "Which assistant? cardboard mcp <name> (set one up with: cardboard assistant add <name>)");
      const cfg = readAssistant(name);
      const { open } = await import("./sdk/index.ts");
      const { LocalMcp, serveStdio } = await import("./mcp.ts");
      const mcp = new LocalMcp({ name: cfg.name, boxes: cfg.boxes.map((b) => ({ name: b.name, write: b.write, own: b.own, box: open({ url: cfg.url, tape: b.tape, onNotice: false }) })) });
      await serveStdio(mcp);
      return;
    }

    // ── Boxes ────────────────────────────────────────────────────────────

    // ── Sharing ──────────────────────────────────────────────────────────

    case "share": {
      const acct = await account();
      if (args[0] === "cancel") {
        await acct.cancelShare(need(args[1], "Which link? cardboard shares lists them"));
        return console.log("Cancelled. That link doesn't work any more.");
      }
      const name = need(args[0], "Which box? cardboard share <box>");
      const forWhom = values.for ?? values.label;
      const { link, expiresAt } = await acct.shareBox(name, { write: !values["read-only"], label: forWhom, as: values.as, expires: values.expires });
      console.log(`\nSend this to ${forWhom ?? "them"} privately (Signal, iMessage, in person). It works once, until ${new Date(expiresAt).toLocaleString()}:\n`);
      console.log(`  ${bold(link)}`);
      printQr(link, !values["no-qr"]);
      console.log(dim("They open it (or scan it) with their own Cardboard on this server, or run: cardboard join <link>"));
      console.log(dim("The secret is after the #, so it never reaches the server. Whoever opens it first gets in."));
      console.log(dim(values["read-only"] ? "They'll be able to read it, not change it." : "They'll be able to read and change it (add --read-only to stop that)."));
      return;
    }

    case "shares": {
      const acct = await account();
      let any = false;
      for (const b of await acct.boxes()) {
        if (b.shared) {
          any = true;
          console.log(`${bold(b.name)}  ${dim(`shared with you by ${b.shared.from}${b.shared.write ? "" : " (read only)"}`)}`);
          continue;
        }
        if (!b.people.members.length && !b.people.links.length) continue;
        any = true;
        console.log(bold(b.name));
        for (const m of b.people.members) console.log(`  ${m.name}  ${dim(`${m.write ? "can change it" : "read only"} · joined ${relativeTime(m.joinedAt, Date.now())}`)}`);
        for (const l of b.people.links) console.log(`  ${dim(`link ${l.id}${l.label ? ` for ${l.label}` : ""}: not used yet, expires ${new Date(l.expiresAt).toLocaleString()}`)}`);
      }
      if (!any) console.log("Nothing is shared yet. Share a box with: cardboard share <box> --for Anna");
      return;
    }

    case "join": {
      const acct = await account();
      const link = need(args[0], "Paste the link: cardboard join <link>");
      const preview = await acct.viewShare(link);
      console.log(`${preview.from} is sharing “${preview.name}” with you${preview.write ? "" : " (read only)"}.`);
      const box = await acct.joinShare(link, { as: values.as });
      console.log(`Joined. It's on your shelf as ${bold(box.name)}.`);
      console.log(dim(`Connect an app to it: cardboard tape ${box.name} · leave any time: cardboard leave ${box.name}`));
      return;
    }

    case "people": {
      const acct = await account();
      if (args[0] !== "remove") die("Try: cardboard people remove <box> <name>");
      const boxName = need(args[1], "Which box? cardboard people remove <box> <name>");
      await acct.removeMember(boxName, need(args[2], "Who? cardboard people remove <box> <name>"));
      return console.log(`Done. They can't reach ${boxName} any more, and their apps were cut off.`);
    }

    case "leave": {
      const acct = await account();
      const boxName = need(args[0], "Which box? cardboard leave <box>");
      await confirm(`Leave ${boxName}? You'd need a new link to come back.\nType the box name to confirm: `, boxName, values.yes);
      await acct.leaveBox(boxName);
      return console.log(`You left ${boxName}.`);
    }

    // ── If something happens to you ──────────────────────────────────────

    case "emergency": {
      const acct = await account();
      const sub = args[0];
      if (!sub || sub === "list") {
        const links = await acct.emergencyLinks();
        if (links.length === 0) return console.log("No emergency access yet. Give someone you trust a way in: cardboard emergency add --for Anna");
        for (const l of links) {
          const status = l.readyAt ? `${bold("being used")}: they get in ${new Date(l.readyAt).toLocaleString()} unless you stop it (cardboard emergency stop ${l.label ?? l.id})` : dim(`waits ${describeDuration(l.waitMs)} · made ${relativeTime(l.createdAt, Date.now())}`);
          console.log(`${l.label ?? l.id}  ${status}`);
        }
        return;
      }
      if (sub === "add") {
        const { link, info } = await acct.addEmergencyLink({ label: values.for, as: values.as, message: values.message, wait: values.wait });
        console.log(`\nGive this to ${values.for ?? "the person you trust"}: print it, or put it in their password manager.\n`);
        console.log(`  ${bold(link)}`);
        printQr(link, !values["no-qr"]);
        console.log(dim(`If they ever open it and ask for access, every one of your devices is told. Unless you stop it, they get in after ${describeDuration(info.waitMs)}.`));
        console.log(dim("The secret is after the #, so the server can't use it. Keep it as safe as a house key."));
        return;
      }
      const which = need(args[1], `Which one? cardboard emergency ${sub} <name>`);
      if (sub === "stop") {
        await acct.stopEmergency(which);
        return console.log("Stopped. Nobody gets in. (The link still works: if it's used again, you'll hear about it. Remove it with: cardboard emergency remove.)");
      }
      if (sub === "allow") {
        await acct.allowEmergency(which);
        return console.log("Done: they can get in now.");
      }
      if (sub === "remove") {
        await acct.removeEmergency(which);
        return console.log("Removed. That link doesn't work any more.");
      }
      return die(`Unknown: emergency ${sub}`, "Try: cardboard emergency [add|stop|allow|remove]");
    }

    case "invite": {
      const acct = await account();
      if (args[0] === "cancel") {
        await acct.cancelInvite(need(args[1], "Which one? cardboard invite list shows them"));
        return console.log("Cancelled.");
      }
      if (args[0] === "list") {
        const { invites } = await acct.invites();
        if (invites.length === 0) return console.log("No invites waiting to be used.");
        for (const i of invites) console.log(`${i.id}  ${dim(`made ${relativeTime(i.createdAt, Date.now())} · works until ${new Date(i.expiresAt).toLocaleString()}`)}`);
        return;
      }
      const { link, expiresAt } = await acct.inviteFriend({ expires: values.expires });
      console.log(`\nAn invite for a friend to make their own Cardboard account here. It works once, until ${new Date(expiresAt).toLocaleString()}:\n`);
      console.log(`  ${bold(link)}`);
      printQr(link, !values["no-qr"]);
      console.log(dim("Their account is theirs alone: you can't see into it, and they can't see into yours. Share a box with them afterwards: cardboard share <box>"));
      return;
    }

    case "set": {
      const [box, setting, ...rest] = args;
      if (!box || !setting || rest.length === 0) die("Usage: cardboard set <box> <setting> <value>", "Settings: secrets, defaultTtl, quotaBytes, maxItemBytes, historyDays, origins");
      const raw = rest.join(" ");
      const value = setting === "origins" ? raw.split(",").map((s) => s.trim()).filter(Boolean) : setting === "historyDays" ? Number(raw) : raw === "null" ? null : raw;
      await (await account()).setBoxSettings(box, { [setting]: value });
      return console.log(`✓ ${box}: ${setting} = ${Array.isArray(value) ? value.join(", ") : String(value)}`);
    }

    case "allow": {
      const [box, origin] = args;
      if (!box || !origin) die("Usage: cardboard allow <box> <origin>", "Example: cardboard allow notes https://notes.example.com");
      const acct = await account();
      const info = await acct.box(box);
      await acct.setBoxSettings(box, { origins: [...new Set([...info.settings.origins, origin.replace(/\/+$/, "")])] });
      return console.log(`✓ ${origin} can now call ${box} from a browser. Remember: a tape in a web page shows its key to the page's visitors.`);
    }

    case "rename": {
      const [box, to] = args;
      if (!box || !to) die("Usage: cardboard rename <box> <new-name>");
      await (await account()).renameBox(box, to);
      return console.log(`✓ ${box} is now called ${to}. Its tapes keep working.`);
    }

    case "rewind": {
      const [box, when] = args;
      if (!box || !when) die("Usage: cardboard rewind <box> <when>", 'Examples: "10m" (ten minutes ago), "2h", "2026-10-01T09:00"');
      const result = await (await account()).rewind(box, when);
      return console.log(`✓ ${box} is back to how it was at ${new Date(result.to).toLocaleString()} (${result.changed} items changed). Rewinding is itself undoable.`);
    }

    case "export": {
      const acct = await account();
      const box = args[0];
      const data = box
        ? await acct.exportBox(box)
        : { format: "cardboard-export-all", formatVersion: 2, exportedAt: new Date().toISOString(), boxes: await Promise.all((await acct.boxes()).map((b) => acct.exportBox(b.name))) };
      const json = `${JSON.stringify(data, null, 2)}\n`;
      if (values.out) {
        writeFileSync(values.out, json, { mode: 0o600 });
        console.error(`✓ Wrote ${values.out}. It's opened, plain JSON, so keep it somewhere private.`);
      } else {
        process.stdout.write(json);
      }
      return;
    }

    case "import": {
      const [box, file] = args;
      if (!box || !file) die("Usage: cardboard import <box> <file>");
      const acct = await account();
      if (!(await acct.boxes()).some((b) => b.name === box)) await acct.createBox(box);
      const result = await acct.importBox(box, JSON.parse(readFileSync(file, "utf8")));
      return console.log(`✓ Imported ${result.imported} items into ${box}${result.skipped ? ` (${result.skipped} had already expired)` : ""}.`);
    }

    case "shred": {
      const box = need(args[0], "Which box? cardboard shred <box>");
      await confirm(`This destroys ${box}, its key, its history and its tapes. It can't be undone.\nType the box name to confirm: `, box, values.yes);
      await (await account()).shredBox(box);
      return console.log(`✓ Shredded ${box}. Backups made before now still hold it sealed; its key is gone, so they can't open it either.`);
    }

    // ── Host ─────────────────────────────────────────────────────────────

    case "shake":
    case "backup":
      return runHost([command, ...args], values);

    case "host":
      return runHost(args, values);

    case "reset-host": {
      const { resetHost, resolvePaths } = await import("./server/index.ts");
      const token = resetHost(resolvePaths({ dataDir: values.data, keyFile: values["key-file"] }));
      const url = loadHost()?.url ?? "http://127.0.0.1:8787";
      writePrivate(HOST_FILE, `${JSON.stringify({ url, hostToken: token }, null, 2)}\n`);
      return console.log(`✓ New host token (the old one stopped working):\n\n  ${token}\n`);
    }

    default:
      die(`Unknown command "${command}".`, "Run `cardboard help` to see what Cardboard can do.");
  }
}

async function runHost(args: string[], values: Record<string, unknown>) {
  const [action, target, extra] = args;
  switch (action ?? "overview") {
    case "overview": {
      const o = await host<{ version: string; accounts: number; invites: number; insights: Insight[]; shake: { summary: string; ok: boolean } | null; server: { publicUrl: string; signup: string } }>("overview");
      console.log(`${bold("Cardboard")} ${o.version} at ${o.server.publicUrl}  ${dim(`sign-up: ${o.server.signup}`)}`);
      console.log(`  ${o.accounts} account${o.accounts === 1 ? "" : "s"} · ${o.invites} open invite${o.invites === 1 ? "" : "s"}${o.shake ? ` · shake test: ${o.shake.summary}` : ""}`);
      console.log(dim("  You run the server. You can't see inside anyone's account, including your own from here.\n"));
      return printInsights(o.insights);
    }
    case "invite": {
      const r = await host<{ link: string; invite: { expiresAt: number } }>("invite", { note: values["note"], ttl: values["ttl"] });
      console.log(`✓ Invite (works once, until ${new Date(r.invite.expiresAt).toLocaleString()}):\n\n  ${r.link}\n`);
      return console.log(dim("  Send it to the person. They open it, or run: cardboard signup <link>"));
    }
    case "invites": {
      const { invites } = await host<{ invites: Array<{ id: string; note: string | null; createdAt: number; expiresAt: number; usedAt: number | null }> }>("invites");
      if (invites.length === 0) return console.log("No invites yet. Make one: cardboard host invite");
      for (const i of invites) {
        const state = i.usedAt ? `used ${relativeTime(i.usedAt, Date.now())}` : i.expiresAt < Date.now() ? "expired" : `open until ${new Date(i.expiresAt).toLocaleDateString()}`;
        console.log(`${i.id}  ${(i.note ?? "").padEnd(24)} ${dim(state)}`);
      }
      return;
    }
    case "accounts": {
      const { accounts, note } = await host<{ accounts: Array<{ id: string; createdAt: number; lastSeenAt: number | null; devices: number; boxes: number; bytes: number; quota: number }>; note: string }>("accounts");
      for (const a of accounts) {
        const seen = a.lastSeenAt ? relativeTime(a.lastSeenAt, Date.now()) : "never";
        console.log(`${a.id}  ${String(a.boxes).padStart(3)} boxes  ${formatBytes(a.bytes).padStart(8)} of ${formatBytes(a.quota).padEnd(8)}  ${a.devices} device${a.devices === 1 ? "" : "s"}  ${dim(`seen ${seen}`)}`);
      }
      return console.log(dim(`\n${note}`));
    }
    case "delete": {
      const id = need(target, "Which account? cardboard host delete <account-id>");
      await confirm(`This deletes the account ${id} and everything in it, for good.\nType the account id to confirm: `, id, values["yes"] as string | undefined);
      await host("account.delete", { id, confirm: id });
      return console.log(`✓ Deleted ${id}.`);
    }
    case "quota": {
      const id = need(target, "Usage: cardboard host quota <account-id> <size|default>");
      const r = await host<{ quota: number }>("account.quota", { id, quota: need(extra, "How much? e.g. 5GB, or default") });
      return console.log(`✓ ${id} can store up to ${formatBytes(r.quota)}.`);
    }
    case "shake": {
      const report = await host<{ ok: boolean; summary: string; results: Array<{ status: "pass" | "fail" | "warn"; title: string; detail: string }> }>("shake");
      for (const r of report.results) console.log(`${STATUS[r.status]} ${r.title} ${dim(`· ${r.detail}`)}`);
      console.log(`\n${report.ok ? "✓" : "✗"} ${report.summary}`);
      if (!report.ok) process.exitCode = 1;
      return;
    }
    case "backup": {
      const r = await host<{ file: string; bytes: number; kept: number }>("backup");
      console.log(`✓ Backup: ${r.file} (${formatBytes(r.bytes)})`);
      return console.log(dim(`  Only sealed data inside, so it's safe to copy anywhere. Keep server.key with it. The newest ${r.kept} are kept.`));
    }
    case "log": {
      const { entries } = await host<{ entries: Array<{ at: number; actor: string; action: string; outcome: string; note: string | null }> }>("log", { limit: 40 });
      for (const e of entries.reverse()) console.log(`${dim(new Date(e.at).toLocaleString().padEnd(22))} ${e.outcome === "denied" ? "✗ " : "  "}${e.action}${e.note ? dim(` · ${e.note}`) : ""}`);
      return;
    }
    case "login": {
      const url = need(target, "Usage: cardboard host login <url> <host-token>").replace(/\/+$/, "");
      const token = need(extra, "Usage: cardboard host login <url> <host-token>");
      await new Rpc(url, token).call("host.overview");
      writePrivate(HOST_FILE, `${JSON.stringify({ url, hostToken: token }, null, 2)}\n`);
      return console.log(`✓ This CLI can run ${url} as its host.`);
    }
    default:
      die("Usage: cardboard host [invite|invites|accounts|delete|quota|shake|backup|log|login]");
  }
}

interface AssistantConfig {
  name: string;
  url: string;
  boxes: Array<{ name: string; tape: string; tapeId: string; write: boolean; own: boolean }>;
}

function assistantFile(name: string): string {
  return join(ASSISTANTS, `${name}.json`);
}

function readAssistant(name: string): AssistantConfig {
  try {
    return JSON.parse(readFileSync(assistantFile(name), "utf8")) as AssistantConfig;
  } catch {
    die(`There's no assistant called ${name} on this computer.`, `Set one up with: cardboard assistant add ${name} --see <box>`);
  }
}

/** "sends", "receives", "sends + receives" (or "send", "receive" for requests). */
function arrows(b: { send: boolean; receive: boolean }, verb = false): string {
  if (b.send && b.receive) return verb ? "send and receive" : "sends + receives";
  if (b.send) return verb ? "send" : "sends";
  return verb ? "receive" : "receives";
}

function readPackageJson(dir: string): { name?: string; description?: string; version?: string } | null {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Record<string, unknown>;
    const text = (v: unknown) => (typeof v === "string" && v ? v : undefined);
    return { name: text(pkg["name"]), description: text(pkg["description"]), version: text(pkg["version"]) };
  } catch {
    return null;
  }
}

function need(value: string | undefined, message: string): string {
  if (!value) die(message);
  return value;
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63) || "my-app";
}

function tapeOptions(values: Record<string, unknown>, label: string) {
  return {
    label,
    read: values["write-only"] ? false : undefined,
    write: values["read-only"] ? false : undefined,
    idle: values["idle"] as string | undefined,
    expires: values["expires"] as string | undefined,
  };
}

function writeEnv(file: string, current: string, vars: Record<string, string>) {
  let text = current;
  for (const [name, value] of Object.entries(vars)) {
    const line = `${name}=${value}`;
    const pattern = new RegExp(`^\\s*${name}\\s*=.*$`, "m");
    text = pattern.test(text) ? text.replace(pattern, line) : `${text}${text && !text.endsWith("\n") ? "\n" : ""}${line}\n`;
  }
  writeFileSync(file, text, { mode: 0o600 });
}

function ensureGitignored(dir: string): "added" | "present" {
  const file = join(dir, ".gitignore");
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  const covered = current
    .split(/\r?\n/)
    .map((l) => l.trim())
    .some((l) => l === ".env" || l === "/.env" || l === ".env*" || l === "*.env");
  if (covered) return "present";
  const block = `${current && !current.endsWith("\n") ? "\n" : ""}${current ? "\n" : ""}# Cardboard tape: keep it out of git\n.env\n`;
  writeFileSync(file, current + block);
  return "added";
}

main().catch((err) => (err instanceof CardboardError ? die(err.reason, err.hint) : die(err instanceof Error ? err.message : String(err))));
