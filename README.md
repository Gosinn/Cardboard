# 📦 Cardboard

**A smart, private deposit box for all your personal apps.**

Every app you build gets its own **box**. Apps open their box with a **tape** (an access token). Cardboard encrypts everything, remembers every version, tells you in plain English who touched what, and attacks itself to prove the locks hold.

It's one small Node server with **zero runtime dependencies** and a single SQLite file, so it runs on a laptop, a Raspberry Pi, or a $5 VPS.

```ts
import { open } from "cardboard";

const box = open(); // finds CARDBOARD_URL + CARDBOARD_TAPE in your env or .env

await box.put("settings/theme", "dark");

const notes = box.collection<{ title: string; done: boolean }>("notes");
await notes.add({ title: "Buy milk", done: false });
await notes.find({ where: { done: false }, sort: "-$createdAt" });

box.watch("notes/", (change) => console.log(change.type, change.key)); // live updates
await box.undo("settings/theme"); // every change can be undone
```

---

## Quick start

```bash
git clone https://github.com/gosinn/cardboard && cd cardboard
npm install && npm link         # builds it and puts the `cardboard` command on your PATH
cardboard start                 # first run: creates the key, prints your owner token, runs the shake test
```

Open the dashboard at http://127.0.0.1:8787 and sign in with the owner token it printed.

Then, in any app's folder:

```bash
cardboard connect my-app        # makes a box + tape, writes .env, makes sure git ignores it
```

(Don't use `npx cardboard`: that would fetch an unrelated package from npm.)

That's the whole setup. `open()` reads `.env` by itself.

> Requires Node 22.18+. To use the SDK from another project: `npm install github:gosinn/cardboard`.

---

## What makes it smart

| | |
|---|---|
| **One-command connect** | `cardboard connect` creates the box and tape, writes `.env`, and adds `.env` to `.gitignore` so the tape can't end up in git. |
| **Labels, not schemas** | Cardboard works out what each box holds from the data itself: collections, fields, types. You never write a schema. |
| **Sensitive-data radar** | It spots API keys (OpenAI, Anthropic, GitHub, AWS, Stripe…), plain-text passwords (hashes are fine), card numbers (Luhn-checked), IBANs, kennitölur, emails and more. Your app gets a notice the moment it stores one; the box keeps a running inventory. |
| **Blast radius** | Every tape comes with one honest sentence: *"If this tape leaks, someone could read and change 240 items (1.2 MB) in recipe-app, including 1 API key and 12 email addresses…"* |
| **Undo everything** | Every write is a version. `undo` a key, or **rewind a whole box** to 10 minutes ago after a bad deploy, just that box and none of the others. |
| **Tapes that clean up after themselves** | By default a tape switches itself off after 90 days *without use*. Apps you use keep working; abandoned ones lock themselves. |
| **Insights** | Cardboard tells you what to fix, with the command that fixes it: secrets in a box, tapes nobody uses, no backup yet, plain HTTP on a network, blocked break-in attempts. |
| **Plain English everywhere** | The activity log reads like *"recipe-app (tape “laptop”) saved “settings/ai”"*. Every error says how to fix it. |
| **Live** | `watch()` streams changes. Revoking a tape cuts its live connections immediately. |
| **Search everything** | Find "lasagna" across every box from the dashboard or `cardboard search`. |

## Docks: apps that help each other without knowing each other

Two of your apps need to share data, but neither should learn who the other is. Cardboard stands in the middle: it carries the parcels, checks every one at customs, and tells nobody who sent what.

```ts
// recipe-app
await box.dock("shopping-list").send({ item: "lamb", qty: 1 });

// grocery-app
box.dock("shopping-list").on(async (parcel) => {
  await addToList(parcel.body); // parcel.from is "berth-0d621d65da4d", never "recipe-app"
});
```

**Docking is one tap.** The first time an app uses a dock, Cardboard asks you. Approve it on the dashboard (or `cardboard dock approve shopping-list grocery-app`), and an app that's already listening starts receiving straight away. Or set it all up front: `cardboard dock create shopping-list --send recipe-app --receive grocery-app`.

- **No names.** At each dock an app is only a pseudonym, and it's a *different* pseudonym at every dock, so apps can't link what they see across docks. `dock.reply(parcel, …)` answers privately: only the original sender gets it, and it still doesn't learn who answered.
- **Customs.** Secrets (API keys, passwords, private keys, login tokens) are refused. Personal data (emails, phones, cards, IBANs, kennitölur…) is redacted by default, or refused or allowed per dock. Booby-trapped JSON (`__proto__` keys that infect apps doing naive merges, absurd nesting) is refused. A **manifest** like `{"item":"string","qty":"number?"}` lets only those fields cross and strips the rest. Size and rate limits apply per app. Rejected parcels are never stored.
- **Deliver, then forget.** A parcel is deleted the moment everyone it was for has picked it up, and otherwise expires (7 days by default). Apps that join later still find deposits waiting for them.
- **You see everything; apps see nothing.** `cardboard dock peek` (or *Look inside* on the dashboard) shows real senders. Parcels are encrypted at rest with the dock's own key.
- **Cardboard remembers your apps.** Approvals belong to the app's box, not its tape, so redeploys and new tapes keep their docks. `cardboard connect` reads `package.json`, so your shelf knows each app's name, description and version. Apps can also call `box.introduce({ title, version })`.

## What makes it private

- **Everything is encrypted at rest** with AES-256-GCM, including key names. Each box has its own random key, wrapped by a master key that lives in a separate file.
- **Key names never touch the disk or URLs in plain text.** Lookups use a keyed HMAC, and every API call is a `POST` with a JSON body, so proxies and access logs can't capture them.
- **Ciphertext is bound to where it lives.** Copying an encrypted value onto another key, or flipping a byte in the database, is detected.
- **Locked by default.** No tape, no access. Browsers are refused unless you allow a specific origin. There is no "allow everything" switch.
- **Narrow tapes.** Read-only, write-only, or limited to a prefix like `public/`.
- **Only hashes of tapes are stored.** Guessing is rate-limited.
- **Crypto-shredding.** `shred` destroys a box's key, items, history, tapes and log, overwriting the freed pages (`secure_delete`) and truncating the WAL.
- **Expired means gone.** When an item expires, its history goes with it, so expired data can't be undone back into existence.
- **The shake test.** On every start, Cardboard attacks itself through its real API with throwaway boxes: cross-box reads, prefix escapes, revoked and expired tapes, foreign websites, tampering, value swapping, plaintext on disk, tape guessing, file permissions. It reports what held (`cardboard shake`).

### Honest threat model

Cardboard **protects you against:**
- a copied database file or backup (useless without `master.key`, which lives elsewhere)
- one leaky app (it only reaches its own box, can be revoked in one click, and shows you its blast radius)
- a buggy app wrecking its data (history, undo, rewind)
- tampering with the database file
- tape guessing and forgotten, unused tapes

Docks keep apps anonymous **from each other**, not from Cardboard (or you): Cardboard has to know who sent what in order to deliver it. If only one app sends on a dock, the receivers can guess who it is. Customs redacts personal data it can recognise, but it can't recognise everything (a person's name, for example), so a manifest is the strongest guarantee.

It **doesn't (yet) protect against:**
- someone who controls the *running* server, which has to hold keys in memory. Client-side "Fragile" encryption is on the roadmap.
- plain HTTP across a network. Put it behind HTTPS (Cardboard warns you if you don't).
- exports, which are plain JSON by design ("moving day"). Backups are encrypted.
- backups made *before* a shred, which still contain that box.

---

## CLI

```
cardboard start                         start the server (dashboard at /)
cardboard connect <app>                 box + tape + .env, in one go
cardboard boxes | box <name>            what's where, labels, tapes, blast radius
cardboard log [box]                     who touched what
cardboard insights                      what to fix, with fixes
cardboard shake                         attack yourself, report what held
cardboard search <text>                 find anything in any box
cardboard tape <box> [--read-only] [--prefix p/] [--idle 30d|never] [--expires 7d]
cardboard blast <tape-id> | revoke <tape-id>
cardboard set <box> <setting> <value>   secrets block · defaultTtl 30d · quotaBytes 1GB · historyDays 90
cardboard allow <box> <origin>          let a website call this box from a browser
cardboard rewind <box> 10m              put a whole box back in time
cardboard export [box] | import <box> <file> | backup | shred <box>
cardboard docks                         docks, berths, and requests waiting for you
cardboard dock create <dock> --send a,b --receive c
cardboard dock approve|deny <dock> <app> · dock add <dock> <app> --as send|receive|both
cardboard dock remove <dock> <app> · dock set <dock> personal block · dock peek <dock> · dock shred <dock>
cardboard login <url> <owner-token> | reset-owner
```

## SDK

| | |
|---|---|
| `get(key)` / `getItem(key)` / `has(key)` | read (null when missing) |
| `put(key, value, { ttl: "30d", ifVersion })` | write; `ifVersion` prevents lost updates |
| `patch(key, changes)` | JSON merge patch (`null` removes a field); returns the merged object |
| `delete(key, { purge })` | delete (undoable unless `purge`) |
| `list(prefix)` / `keys(prefix)` | list, paging automatically |
| `query({ prefix, where, sort, limit, offset })` | `where` supports equality, dot paths, array contains, `$gt $gte $lt $lte $ne $in $nin $exists $contains $startsWith $or $and $not` |
| `history(key)` / `undo(key, { to })` | versions, newest first; undo again to redo |
| `batch([...])` | several writes that all happen or none do |
| `watch(prefix, onChange)` | live changes; reconnects by itself |
| `collection(name)` | `add`, `get`, `set`, `update`, `remove`, `find`, `findOne`, `count`, `all`, `watch` with time-ordered ids |
| `dock(name)` | `send(body, { to })`, `reply(parcel, body)`, `receive({ ack })`, `ack(parcel)`, `status()`, `on(handler, { onWaiting })` |
| `introduce({ title, description, url, version })` | tell Cardboard who this app is |

Errors are `CardboardError`s with a `code`, a plain message and a `hint`.

## HTTP API (any language)

Every call is `POST /v1/<operation>` with `Authorization: Bearer <tape>` and a JSON body. The app operations are `whoami`, `get`, `put`, `patch`, `add`, `delete`, `list`, `query`, `history`, `undo`, `batch`, `watch` (server-sent events), `introduce`, and for docks `dock.send`, `dock.receive`, `dock.ack`, `dock.status` and `dock.watch`. Owner operations live under `/v1/admin/` and take the owner token.

```bash
curl -s localhost:8787/v1/put -H "authorization: Bearer $CARDBOARD_TAPE" \
  -H "content-type: application/json" -d '{"key":"hello","value":{"from":"curl"}}'
```

## Running it for real

```bash
CARDBOARD_DATA=/srv/cardboard CARDBOARD_KEY_FILE=/root/cardboard.key cardboard start
```

- Keep `master.key` somewhere other than the data folder, and back it up (a password manager is ideal).
- To reach Cardboard from other devices, put it behind HTTPS. Use Caddy (`reverse_proxy 127.0.0.1:8787`, then start with `--trust-proxy`), Tailscale, or `--tls-cert/--tls-key`.
- `cardboard backup` writes an encrypted snapshot to `<data>/backups/` (keeps the newest 10). Snapshots are safe to sync to any cloud drive.

## Roadmap

- **Courier**: Cardboard holds your third-party API keys and makes calls for your apps, so apps never see the keys
- **Files**: photos and documents next to JSON
- **Fragile fields**: encrypted on the device, so even the server can't read them
- **Passkey sign-in** for your apps' users, offline sync, scheduled off-site backups, a Python SDK

## Development

```bash
npm test          # unit + integration + CLI tests
npm run typecheck
npm run build     # compiles to dist/ (what other apps install)
```
