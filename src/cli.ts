#!/usr/bin/env node
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { relativeTime } from "./shared/duration.ts";
import { formatBytes } from "./shared/size.ts";
import { VERSION } from "./shared/version.ts";

// node:sqlite works fine; its "experimental" banner just isn't useful to people using a CLI.
process.removeAllListeners("warning");
process.on("warning", (w) => {
  if (w.name === "ExperimentalWarning" && /SQLite/i.test(w.message)) return;
  console.warn(`${w.name}: ${w.message}`);
});

const HELP = `
Cardboard ${VERSION}: a smart, private deposit box for your apps.

  Getting started
    cardboard start                   Start Cardboard (first run sets everything up)
    cardboard connect <app>           Connect the app in this folder: makes a box + tape, writes .env

  Looking around
    cardboard boxes                   Every box, what's in it, last activity
    cardboard box <name>              Labels, tapes and blast radius for one box
    cardboard log [box]               Who touched what, in plain English
    cardboard insights                Things worth fixing, with fixes
    cardboard shake                   Attack Cardboard and report what held
    cardboard search <text>           Find something in any box

  Tapes (access for apps)
    cardboard tape <box> [--read-only] [--prefix notes/] [--label phone] [--idle 30d|never] [--expires 7d]
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
    cardboard dock peek <dock>              What's in flight, and who really sent it
    cardboard dock shred <dock>             Destroy a dock and everything in flight

  Sign in with Cardboard (apps know you, your data stays with you)
    cardboard apps                          Apps you've signed into, and what each may do
    cardboard apps add <name> --redirect <url>[,url] [--public]   Register an app by hand
    cardboard apps disconnect <app> [--shred]   Cut an app off (and shred what it kept)
    cardboard apps forget <client-id>       Remove an app's registration
    cardboard profile [--name "Gosinn"] [--email you@example.com]   What apps may see, if you allow it

  Boxes
    cardboard set <box> <setting> <value>   e.g. secrets block · defaultTtl 30d · quotaBytes 1GB
    cardboard allow <box> <origin>          Let a website call this box from the browser
    cardboard rewind <box> <when>           Put a box back how it was ("10m", "2h", "2026-10-01")
    cardboard export [box] [--out file]     Plain JSON of one box, or all of them
    cardboard import <box> <file>           Load a Cardboard export into a box
    cardboard shred <box>                   Destroy a box, its key, history and tapes. For good.
    cardboard backup                        Encrypted snapshot of everything (safe to store anywhere)

  Owner
    cardboard login <url> <owner-token>     Point this CLI at a Cardboard somewhere else
    cardboard reset-owner                   New owner token (run on the server; needs the data folder)

  Options for start:  --port 8787  --host 127.0.0.1  --data ./cardboard-data  --key-file <path>
                      --tls-cert <file> --tls-key <file>  --trust-proxy
                      --public-url https://cardboard.example.com   (where apps reach you)
`;

interface Credentials {
  url: string;
  ownerToken: string;
}

const CREDENTIALS = join(process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config"), "cardboard", "credentials.json");

function loadCredentials(): Credentials {
  const url = process.env["CARDBOARD_URL"];
  const ownerToken = process.env["CARDBOARD_OWNER"];
  let saved: Partial<Credentials> = {};
  try {
    saved = JSON.parse(readFileSync(CREDENTIALS, "utf8")) as Partial<Credentials>;
  } catch {
    // none yet
  }
  const creds = { url: url ?? saved.url ?? "http://127.0.0.1:8787", ownerToken: ownerToken ?? saved.ownerToken };
  if (!creds.ownerToken) {
    die(
      "This CLI doesn't know your owner token yet.",
      "Start Cardboard on this machine with `cardboard start`, or run `cardboard login <url> <owner-token>`.",
    );
  }
  return creds as Credentials;
}

function saveCredentials(creds: Credentials) {
  mkdirSync(dirname(CREDENTIALS), { recursive: true, mode: 0o700 });
  writeFileSync(CREDENTIALS, `${JSON.stringify(creds, null, 2)}\n`, { mode: 0o600 });
  chmodSync(CREDENTIALS, 0o600);
}

async function admin<T = Record<string, unknown>>(op: string, body: unknown = {}): Promise<T> {
  const { url, ownerToken } = loadCredentials();
  let res: Response;
  try {
    res = await fetch(`${url}/v1/admin/${op}`, {
      method: "POST",
      headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    die(`Couldn't reach Cardboard at ${url}.`, "Is it running? Start it with: cardboard start");
  }
  const data = (await res.json().catch(() => ({}))) as { error?: { message?: string; hint?: string } };
  if (!res.ok) die(data.error?.message ?? `Cardboard answered with HTTP ${res.status}.`, data.error?.hint);
  return data as T;
}

function die(message: string, hint?: string): never {
  console.error(`✗ ${message}`);
  if (hint) console.error(`  ${hint}`);
  process.exit(1);
}

const dim = (s: string) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s: string) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s);
const LEVEL = { danger: "‼", warn: "!", tip: "·" } as const;
const STATUS = { pass: "✓", fail: "✗", warn: "!" } as const;

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
      dir: { type: "string" },
      force: { type: "boolean" },
      "read-only": { type: "boolean" },
      "write-only": { type: "boolean" },
      prefix: { type: "string" },
      send: { type: "string" },
      receive: { type: "string" },
      as: { type: "string" },
      redirect: { type: "string" },
      public: { type: "boolean" },
      shred: { type: "boolean" },
      name: { type: "string" },
      email: { type: "string" },
      "public-url": { type: "string" },
      label: { type: "string" },
      idle: { type: "string" },
      expires: { type: "string" },
      limit: { type: "string" },
      out: { type: "string" },
      yes: { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  const [command, ...args] = positionals;
  if (values.version) return console.log(VERSION);
  if (!command || values.help || command === "help") return console.log(HELP);

  switch (command) {
    case "start": {
      const { startServer } = await import("./server/index.ts");
      if ((values["tls-cert"] && !values["tls-key"]) || (!values["tls-cert"] && values["tls-key"])) {
        die("HTTPS needs both --tls-cert and --tls-key.");
      }
      const cb = await startServer({
        dataDir: values.data,
        keyFile: values["key-file"],
        host: values.host,
        port: values.port ? Number(values.port) : undefined,
        tls: values["tls-cert"] ? { cert: values["tls-cert"], key: values["tls-key"]! } : undefined,
        trustProxy: values["trust-proxy"],
        publicUrl: values["public-url"],
      }).catch((err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          die(`Port ${values.port ?? 8787} is already in use.`, "Is Cardboard already running? Or pick another port with --port 8788.");
        }
        throw err;
      });
      console.log(`\n  ${bold("Cardboard is open")} at ${cb.url}`);
      console.log(dim(`  Data: ${cb.paths.dataDir} (encrypted)`));
      console.log(dim(`  Key:  ${cb.paths.keyFile}`));
      console.log(dim(`  Sign in with Cardboard issuer: ${cb.publicUrl}`));
      if (cb.ownerToken) {
        saveCredentials({ url: cb.url, ownerToken: cb.ownerToken });
        console.log(`\n  ${bold("Your owner token")} (shown once; the CLI saved it to ${CREDENTIALS}):`);
        console.log(`  ${cb.ownerToken}`);
        console.log(dim("  Use it to sign in to the dashboard. Keep it like a password."));
        console.log(`\n  ${bold("Back up master.key")} somewhere that isn't this folder. Without it, nothing can be read.`);
        console.log(`\n  Next: in your app's folder, run ${bold("cardboard connect <app-name>")}`);
      }
      if (cb.shake) {
        const mark = cb.shake.ok ? "✓" : "✗";
        console.log(`\n  ${mark} Shake test: ${cb.shake.summary}`);
        for (const r of cb.shake.results.filter((r) => r.status !== "pass")) {
          console.log(`    ${STATUS[r.status]} ${r.title}: ${r.detail}`);
        }
      }
      console.log("");
      const stop = async () => {
        await cb.close();
        process.exit(0);
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      return;
    }

    case "connect": {
      const dir = resolve(values.dir ?? ".");
      const pkg = readPackageJson(dir);
      const name = args[0] ?? slug(pkg?.name?.replace(/^@[^/]+\//, "") ?? basename(dir));
      const envFile = join(dir, ".env");
      const env = existsSync(envFile) ? readFileSync(envFile, "utf8") : "";
      if (/^\s*CARDBOARD_TAPE\s*=/m.test(env) && !values.force) {
        die(`${envFile} already has a CARDBOARD_TAPE.`, "Run with --force to replace it with a new tape.");
      }
      const { url } = loadCredentials();
      const boxes = await admin<{ boxes: Array<{ name: string }> }>("boxes");
      const tapeBody = tapeOptions(values, `${basename(dir)} on ${hostLabel()}`);
      let secret: string;
      let created = false;
      if (boxes.boxes.some((b) => b.name === name)) {
        secret = (await admin<{ secret: string }>("tape.create", { box: name, ...tapeBody })).secret;
      } else {
        secret = (await admin<{ secret: string }>("box.create", { name, ...tapeBody })).secret;
        created = true;
      }
      const profile = {
        title: pkg?.name?.slice(0, 60),
        description: pkg?.description?.slice(0, 200),
        version: pkg?.version?.slice(0, 40),
      };
      if (profile.title || profile.description || profile.version) {
        await admin("box.profile", { name, profile: Object.fromEntries(Object.entries(profile).filter(([, v]) => v)) });
      }
      writeEnv(envFile, env, { CARDBOARD_URL: url, CARDBOARD_TAPE: secret });
      const ignored = ensureGitignored(dir);
      console.log(`\n  ✓ ${created ? "Made a box called" : "Connected to the existing box"} ${bold(name)}`);
      console.log(`  ✓ Wrote CARDBOARD_URL and CARDBOARD_TAPE to ${envFile}`);
      console.log(`  ✓ ${ignored === "added" ? "Added .env to .gitignore" : ".env is already in .gitignore"}, so the tape won't end up in git`);
      console.log(`\n  ${dim("// in your app")}`);
      console.log(`  import { open } from "cardboard";`);
      console.log(`  const box = open();`);
      console.log(`  await box.put("hello", { from: "${name}" });\n`);
      return;
    }

    case "boxes": {
      const { boxes } = await admin<{ boxes: BoxSummary[] }>("boxes");
      if (values.json) return console.log(JSON.stringify(boxes, null, 2));
      if (boxes.length === 0) return console.log("No boxes yet. Make one with: cardboard connect <app-name>");
      for (const b of boxes) {
        const last = b.lastActivity ? relativeTime(b.lastActivity, Date.now()) : "never used";
        console.log(`${bold(b.name.padEnd(24))} ${String(b.items).padStart(6)} items  ${formatBytes(b.bytes).padStart(8)}  ${dim(last)}`);
        if (b.profile.description || b.profile.version) {
          console.log(dim(`  ${[b.profile.description, b.profile.version && `v${b.profile.version}`].filter(Boolean).join(" · ")}`));
        }
        console.log(dim(`  ${b.summary}`));
        if (b.docks.length) console.log(dim(`  Docks: ${b.docks.map((d) => `${d.dock} (${arrows(d)})`).join(", ")}`));
      }
      return;
    }

    case "box": {
      const name = need(args[0], "Which box? cardboard box <name>");
      const data = await admin<BoxDetail>("box.get", { name });
      if (values.json) return console.log(JSON.stringify(data, null, 2));
      console.log(`\n${bold(data.box.name)}  ${dim(`${data.box.items} items · ${formatBytes(data.box.bytes)}`)}`);
      console.log(`  ${data.inventory.summary}\n`);
      for (const c of data.inventory.collections) {
        console.log(`  ${bold(c.name)} ${dim(`${c.items} items`)}`);
        for (const f of c.fields.slice(0, 12)) {
          const sens = f.sensitive.length ? `  ⚑ ${f.sensitive.join(", ")}` : "";
          console.log(`    ${f.name.padEnd(20)} ${dim(f.types.join(" | "))}${sens}`);
        }
      }
      console.log(`\n  ${bold("Tapes")}`);
      for (const t of data.tapes) {
        const perms = [t.read && "read", t.write && "write"].filter(Boolean).join("+");
        console.log(`  ${t.id}  “${t.label}”  ${perms}${t.prefix ? `  prefix ${t.prefix}` : ""}  ${dim(t.state)}`);
        console.log(dim(`    ${t.blast.summary}`));
      }
      console.log(`\n  ${bold("Recent activity")}`);
      for (const e of data.log.slice(0, 10)) console.log(`  ${dim(relativeTime(e.at, Date.now()).padEnd(16))} ${e.text}`);
      console.log("");
      return;
    }

    case "tape": {
      const box = need(args[0], "Which box? cardboard tape <box>");
      const result = await admin<{ secret: string; tape: { id: string }; blast: { summary: string } }>("tape.create", {
        box,
        ...tapeOptions(values, values.label ?? "manual"),
      });
      console.log(`\n  New tape ${result.tape.id} for ${bold(box)}:\n`);
      console.log(`  ${result.secret}\n`);
      console.log(dim(`  ${result.blast.summary}`));
      console.log(dim("  This is the only time the tape is shown.\n"));
      return;
    }

    case "blast": {
      const id = need(args[0], "Which tape? cardboard blast <tape-id>");
      const blast = await admin<{ summary: string }>("tape.blast", { id });
      return console.log(blast.summary);
    }

    case "revoke": {
      const id = need(args[0], "Which tape? cardboard revoke <tape-id>");
      await admin("tape.revoke", { id });
      return console.log(`✓ Revoked ${id}. Anything using it is locked out now, including live connections.`);
    }

    case "log": {
      const { entries } = await admin<{ entries: Array<{ at: number; text: string; outcome: string; detail: { ip?: string } }> }>(
        "log",
        { box: args[0], limit: values.limit ? Number(values.limit) : 40 },
      );
      if (values.json) return console.log(JSON.stringify(entries, null, 2));
      for (const e of entries.reverse()) {
        const mark = e.outcome === "denied" ? "✗ " : e.outcome === "error" ? "! " : "  ";
        const ip = e.detail.ip ? dim(` from ${e.detail.ip}`) : "";
        console.log(`${dim(new Date(e.at).toLocaleString().padEnd(22))} ${mark}${e.text}${ip}`);
      }
      return;
    }

    case "insights": {
      const { insights } = await admin<{ insights: Array<{ level: "danger" | "warn" | "tip"; title: string; detail: string; fix?: string }> }>(
        "insights",
      );
      if (insights.length === 0) return console.log("✓ Nothing to fix. Everything looks good.");
      for (const i of insights) {
        console.log(`${LEVEL[i.level]} ${bold(i.title)}`);
        console.log(`  ${i.detail}`);
        if (i.fix) console.log(dim(`  Fix: ${i.fix}`));
      }
      return;
    }

    case "shake": {
      const report = await admin<{ ok: boolean; summary: string; results: Array<{ status: "pass" | "fail" | "warn"; title: string; detail: string }> }>(
        "shake",
      );
      for (const r of report.results) console.log(`${STATUS[r.status]} ${r.title} ${dim(`· ${r.detail}`)}`);
      console.log(`\n${report.ok ? "✓" : "✗"} ${report.summary}`);
      if (!report.ok) process.exitCode = 1;
      return;
    }

    case "search": {
      const q = need(args.join(" "), "What should I look for? cardboard search <text>");
      const { results } = await admin<{ results: Array<{ box: string; key: string; snippet: string | null }> }>("search", { q });
      if (results.length === 0) return console.log("Nothing found.");
      for (const r of results) console.log(`${bold(r.box)} ${r.key}${r.snippet ? dim(`  …${r.snippet}…`) : ""}`);
      return;
    }

    case "docks": {
      const data = await admin<DocksView>("docks");
      if (values.json) return console.log(JSON.stringify(data, null, 2));
      if (data.pending.length) {
        console.log(bold("Waiting for you"));
        for (const p of data.pending) {
          console.log(`  ${p.box} wants to ${arrows(p, true)} on ${bold(p.dock)}  ${dim(`→ cardboard dock approve ${p.dock} ${p.box}`)}`);
        }
        console.log("");
      }
      if (data.docks.length === 0) return console.log("No docks yet. Open one with: cardboard dock create <name> --send <app> --receive <app>");
      for (const d of data.docks) {
        const flight = d.inFlight.count ? `${d.inFlight.count} in flight` : "nothing in flight";
        console.log(`${bold(d.name)}  ${dim(flight)}`);
        for (const b of d.berths) {
          const state = b.denied ? "refused" : !b.send && !b.receive ? "asking" : arrows(b);
          console.log(`  ${b.box.padEnd(24)} ${state.padEnd(16)} ${dim(`known there as ${b.tag}`)}`);
        }
      }
      return;
    }

    case "dock": {
      const [action, dock, app] = args;
      const needDock = () => need(dock, `Which dock? cardboard dock ${action} <dock>`);
      const needApp = () => need(app, `Which app? cardboard dock ${action} <dock> <app>`);
      switch (action) {
        case "create": {
          const result = await admin<{ dock: DocksView["docks"][number] }>("dock.create", {
            name: needDock(),
            send: values.send,
            receive: values.receive,
          });
          console.log(`✓ Opened ${bold(result.dock.name)}.`);
          for (const b of result.dock.berths) console.log(`  ${b.box} can ${arrows(b, true)}, known there as ${b.tag}`);
          if (!values.send && !values.receive) {
            console.log(dim("  No apps yet. Apps that use it will ask to dock, and you approve them."));
          }
          return;
        }
        case "approve":
          await admin("dock.approve", { dock: needDock(), box: needApp() });
          return console.log(`✓ ${app} is docked at ${dock}. If it's listening, it starts right now.`);
        case "deny":
          await admin("dock.deny", { dock: needDock(), box: needApp() });
          return console.log(`✓ Refused. ${app} can't use ${dock} and won't ask again.`);
        case "add": {
          const as = values.as ?? "both";
          if (!["send", "receive", "both"].includes(as)) die("--as must be send, receive or both.");
          await admin("dock.grant", { dock: needDock(), box: needApp(), send: as !== "receive", receive: as !== "send" });
          return console.log(`✓ ${app} can ${as === "both" ? "send and receive" : as} on ${dock}.`);
        }
        case "remove": {
          const result = await admin<{ removed: boolean }>("dock.remove", { dock: needDock(), box: needApp() });
          return console.log(result.removed ? `✓ Took ${app} off ${dock}. Its live connection is closed.` : `${app} wasn't on ${dock}.`);
        }
        case "set": {
          const [, , setting, ...rest] = args;
          if (!dock || !setting || rest.length === 0) die("Usage: cardboard dock set <dock> <setting> <value>");
          const raw = rest.join(" ");
          const value = setting === "ratePerMinute" ? Number(raw) : raw === "null" ? null : raw;
          await admin("dock.settings", { dock, settings: { [setting]: value } });
          return console.log(`✓ ${dock}: ${setting} = ${raw}`);
        }
        case "peek": {
          const { parcels } = await admin<{ parcels: Array<{ seq: number; sender: string; to: string | null; sentAt: number; body: unknown; redacted: string[] }> }>(
            "dock.peek",
            { dock: needDock() },
          );
          if (parcels.length === 0) return console.log("Nothing in flight.");
          for (const p of parcels) {
            console.log(`${dim(`#${p.seq} ${relativeTime(p.sentAt, Date.now())}`)} from ${bold(p.sender)}${p.to ? ` to ${p.to}` : ""}`);
            console.log(`  ${JSON.stringify(p.body)}${p.redacted.length ? dim(`  (redacted: ${p.redacted.join(", ")})`) : ""}`);
          }
          return;
        }
        case "shred": {
          const name = needDock();
          let confirm = values.yes;
          if (!confirm) {
            const rl = createInterface({ input: process.stdin, output: process.stdout });
            confirm = (await rl.question(`This destroys the dock ${name} and everything in flight on it.\nType the dock name to confirm: `)).trim();
            rl.close();
          }
          await admin("dock.shred", { dock: name, confirm });
          return console.log(`✓ Shredded the dock ${name}.`);
        }
        default:
          die("Usage: cardboard dock <create|approve|deny|add|remove|set|peek|shred> <dock> [app]", "See: cardboard help");
      }
      return;
    }

    case "apps": {
      const [action, target] = args;
      if (!action) {
        const data = await admin<AppsView>("apps");
        if (values.json) return console.log(JSON.stringify(data, null, 2));
        console.log(`${bold("Sign in with Cardboard")}  ${dim(`issuer ${data.issuer}`)}`);
        if (data.connected.length === 0) console.log(dim("  No apps connected yet."));
        for (const a of data.connected) {
          console.log(`\n  ${bold(a.name)} ${dim(a.site)}`);
          console.log(`    may: ${a.scopes.join(", ")}${a.box ? `  ·  data in box ${a.box}` : ""}`);
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
        const r = await admin<{ client_id: string; client_secret?: string }>("apps.register", { name, redirectUris, public: values.public });
        console.log(`✓ Registered ${bold(name)}.\n`);
        console.log(`  issuer         ${(await admin<AppsView>("apps")).issuer}`);
        console.log(`  client_id      ${r.client_id}`);
        if (r.client_secret) console.log(`  client_secret  ${r.client_secret}  ${dim("(shown once; keep it on the app's server)")}`);
        return;
      }
      if (action === "disconnect") {
        const which = need(target, "Which app? cardboard apps disconnect <name or grant id>");
        const { connected } = await admin<AppsView>("apps");
        const match = connected.find((a) => a.grant === which || a.name.toLowerCase() === which.toLowerCase());
        if (!match) die(`No connected app called ${which}.`, "See them with: cardboard apps");
        const r = await admin<{ disconnected: string; shredded: string | null }>("apps.disconnect", { grant: match.grant, shred: values.shred });
        return console.log(`✓ Disconnected ${r.disconnected}.${r.shredded ? ` Shredded its box ${r.shredded}.` : match.box ? ` Its box ${match.box} is still yours.` : ""}`);
      }
      if (action === "forget") {
        const r = await admin<{ forgotten: string }>("apps.forget", { client: need(target, "Which client id? cardboard apps forget <client-id>") });
        return console.log(`✓ Forgot ${r.forgotten}.`);
      }
      return die("Usage: cardboard apps [add|disconnect|forget]", "See: cardboard help");
    }

    case "profile": {
      const patch: Record<string, string | null> = {};
      if (values.name !== undefined) patch["name"] = values.name || null;
      if (values.email !== undefined) patch["email"] = values.email || null;
      const { profile } = Object.keys(patch).length
        ? await admin<{ profile: { name?: string; email?: string } }>("profile.set", patch)
        : await admin<{ profile: { name?: string; email?: string } }>("apps");
      console.log(`Name:  ${profile.name ?? dim("(not set)")}`);
      console.log(`Email: ${profile.email ?? dim("(not set)")}`);
      console.log(dim("Apps only see these if they ask and you say yes."));
      return;
    }

    case "set": {
      const [box, setting, ...rest] = args;
      if (!box || !setting || rest.length === 0) die("Usage: cardboard set <box> <setting> <value>", "Settings: secrets, defaultTtl, quotaBytes, maxItemBytes, historyDays, origins");
      const raw = rest.join(" ");
      const value =
        setting === "origins" ? raw.split(",").map((s) => s.trim()).filter(Boolean)
        : setting === "historyDays" ? Number(raw)
        : raw === "null" ? null
        : raw;
      await admin("box.settings", { name: box, settings: { [setting]: value } });
      return console.log(`✓ ${box}: ${setting} = ${Array.isArray(value) ? value.join(", ") : String(value)}`);
    }

    case "allow": {
      const [box, origin] = args;
      if (!box || !origin) die("Usage: cardboard allow <box> <origin>", "Example: cardboard allow notes https://notes.example.com");
      const data = await admin<BoxDetail>("box.get", { name: box });
      const origins = [...new Set([...data.box.settings.origins, origin.replace(/\/+$/, "")])];
      await admin("box.settings", { name: box, settings: { origins } });
      return console.log(`✓ ${origin} can now call ${box} from a browser. Give it a read-only, prefix-limited tape if you can.`);
    }

    case "rewind": {
      const [box, when] = args;
      if (!box || !when) die("Usage: cardboard rewind <box> <when>", 'Examples: "10m" (ten minutes ago), "2h", "2026-10-01T09:00"');
      const result = await admin<{ changed: number; to: number }>("box.rewind", { name: box, to: when });
      return console.log(`✓ ${box} is back to how it was at ${new Date(result.to).toLocaleString()} (${result.changed} keys changed). Rewinding is itself undoable.`);
    }

    case "export": {
      const box = args[0];
      let data: unknown;
      if (box) {
        data = await admin("box.export", { name: box });
      } else {
        const { boxes } = await admin<{ boxes: Array<{ name: string }> }>("boxes");
        const all = [];
        for (const b of boxes) all.push(await admin("box.export", { name: b.name }));
        data = { format: "cardboard-export-all", formatVersion: 1, exportedAt: new Date().toISOString(), boxes: all };
      }
      const json = `${JSON.stringify(data, null, 2)}\n`;
      if (values.out) {
        writeFileSync(values.out, json, { mode: 0o600 });
        console.error(`✓ Wrote ${values.out}. It's plain JSON, so keep it somewhere private.`);
      } else {
        process.stdout.write(json);
      }
      return;
    }

    case "import": {
      const [box, file] = args;
      if (!box || !file) die("Usage: cardboard import <box> <file>");
      const data = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      const result = await admin<{ imported: number; skipped: number }>("box.import", { name: box, data });
      return console.log(`✓ Imported ${result.imported} items into ${box}${result.skipped ? ` (${result.skipped} had already expired)` : ""}.`);
    }

    case "shred": {
      const box = need(args[0], "Which box? cardboard shred <box>");
      let confirm = values.yes;
      if (!confirm) {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        confirm = (await rl.question(`This destroys ${box}, its key, its history and its tapes. It can't be undone.\nType the box name to confirm: `)).trim();
        rl.close();
      }
      const result = await admin<{ shredded: string; note?: string }>("box.shred", { name: box, confirm });
      console.log(`✓ Shredded ${result.shredded}.`);
      if (result.note) console.log(dim(`  ${result.note}`));
      return;
    }

    case "backup": {
      const result = await admin<{ file: string; bytes: number; kept: number }>("backup");
      console.log(`✓ Encrypted backup: ${result.file} (${formatBytes(result.bytes)})`);
      console.log(dim(`  Safe to copy anywhere: it can only be opened with master.key. The newest ${result.kept} are kept.`));
      return;
    }

    case "login": {
      const [url, ownerToken] = args;
      if (!url || !ownerToken) die("Usage: cardboard login <url> <owner-token>");
      saveCredentials({ url: url.replace(/\/+$/, ""), ownerToken });
      await admin("boxes");
      return console.log(`✓ Logged in to ${url}`);
    }

    case "reset-owner": {
      const { resetOwner, resolvePaths } = await import("./server/index.ts");
      const token = resetOwner(resolvePaths({ dataDir: values.data, keyFile: values["key-file"] }));
      const { url } = (() => {
        try {
          return JSON.parse(readFileSync(CREDENTIALS, "utf8")) as Credentials;
        } catch {
          return { url: "http://127.0.0.1:8787" };
        }
      })();
      saveCredentials({ url, ownerToken: token });
      console.log(`✓ New owner token (the old one stopped working):\n\n  ${token}\n`);
      return;
    }

    default:
      die(`Unknown command "${command}".`, "Run `cardboard help` to see what Cardboard can do.");
  }
}

interface AppsView {
  issuer: string;
  profile: { name?: string; email?: string };
  connected: Array<{ grant: string; name: string; site: string; scopes: string[]; box: string | null; privateId: string; connectedAt: number }>;
  registered: Array<{ client: string; name: string; redirectUris: string[] }>;
}

interface DocksView {
  docks: Array<{
    name: string;
    inFlight: { count: number; bytes: number; unclaimed: number };
    berths: Array<{ box: string; tag: string; send: boolean; receive: boolean; denied: boolean }>;
  }>;
  pending: Array<{ dock: string; box: string; send: boolean; receive: boolean }>;
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

interface BoxSummary {
  name: string;
  profile: { title?: string; description?: string; version?: string };
  docks: Array<{ dock: string; send: boolean; receive: boolean; waiting: boolean }>;
  items: number;
  bytes: number;
  summary: string;
  lastActivity: number | null;
  settings: { origins: string[] };
}

interface BoxDetail {
  box: BoxSummary;
  inventory: {
    summary: string;
    collections: Array<{ name: string; items: number; fields: Array<{ name: string; types: string[]; sensitive: string[] }> }>;
  };
  tapes: Array<{ id: string; label: string; read: boolean; write: boolean; prefix: string | null; state: string; blast: { summary: string } }>;
  log: Array<{ at: number; text: string }>;
}

function need(value: string | undefined, message: string): string {
  if (!value) die(message);
  return value;
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63) || "my-app";
}

function hostLabel(): string {
  return process.env["HOSTNAME"] ?? "this machine";
}

function tapeOptions(values: Record<string, unknown>, label: string) {
  return {
    label,
    read: values["write-only"] ? false : undefined,
    write: values["read-only"] ? false : undefined,
    prefix: values["prefix"],
    idle: values["idle"],
    expires: values["expires"],
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

main().catch((err) => die(err instanceof Error ? err.message : String(err)));
