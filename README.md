# 📦 Cardboard

**Keep, move and protect your data, and connect your apps, conveniently. End-to-end encrypted: whoever runs the server can't read any of it.**

The everyday things should be easy: **send a link, a note or a photo to yourself** and it's on your other devices a second later. Keep notes, passwords, files and videos in one **personal box** you can open anywhere. Share a box with family. Let your apps keep their data with you instead of on their own servers.

Every app you build gets its own **box**. Apps open their box with a **tape**. Everything is sealed on your devices and inside your apps before it leaves them, so the Cardboard server only ever stores bytes it can't open: not your data, not your key names, not even your box names. Cardboard still remembers every version, tells you in plain English who touched what, and attacks itself to prove the locks hold.

It's one small Node server with **zero runtime dependencies** and a single SQLite file, so it runs on a laptop, a Raspberry Pi, or a $5 VPS, for you alone or for your family and friends: each person has their own keys, a **personal box** for notes, passwords, links and files that opens on every device they sign in on, can lock their phone's copy with **Face ID**, can **share a box** with someone else (a family shopping list, a shared trip) without the server ever seeing inside, and can leave **emergency access** for someone they trust.

```ts
import { open } from "cardboard";

const box = open(); // finds CARDBOARD_URL + CARDBOARD_TAPE in your env or .env

await box.put("settings/theme", "dark"); // sealed right here, before it leaves your app

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
cardboard start                 # first run: prints the host token and an invite link, runs the shake test
cardboard signup                # makes YOUR account on this computer and prints your recovery kit
```

Or open the invite link `cardboard start` printed, and sign up in the browser instead.

Then, in any app's folder:

```bash
cardboard connect my-app        # makes a box + tape, writes .env, makes sure git ignores it
```

That's the whole setup. `open()` reads `.env` by itself. (Don't use `npx cardboard`: that would fetch an unrelated package from npm.)

> Requires Node 22.18+. To use the SDK from another project: `npm install github:gosinn/cardboard`.
>
> Building an app on it with an AI assistant? Start from [`examples/shared-list`](examples/shared-list) (sign-in, sharing, live updates and undo, no database) and point your assistant at [`docs/FOR-AI.md`](docs/FOR-AI.md).
>
> Putting it online for real (HTTPS, your family's phones)? For free from your own computer: `node src/cli.ts start --tunnel tailscale`. Or always on, with Railway or `docker compose up -d` on a server. See [docs/DEPLOY.md](docs/DEPLOY.md). Connecting a website like LORE: [docs/APPS.md](docs/APPS.md).

---

## The host is locked out

Cardboard is built so that whoever runs the server (you, a friend, a VPS provider, someone who copies the disk) can't read anyone's data. Not "we promise not to look": there is nothing on the server to look with.

```
your device ── account key (never leaves your devices)
               ├─ seals box keys, dock keys          → the server stores them sealed
               └─ seals names, labels, your profile  → the server stores them sealed
box key ────── seals every item's name and value      → the server stores only sealed bytes
               └─ keyed fingerprints of names         → so "get notes/1" works without the name
tape ───────── token half (the server keeps a hash)  + key half (only the app has it)
```

- **Your keys live on your devices.** Each device (a browser, a computer running the CLI) holds its own key. The server keeps a copy of your account key per device, sealed by that device's key. Remove a device and its copy is deleted.
- **Apps hold only their own box's key.** A tape is two halves: a token the server checks, and a key that opens a sealed copy of the box key. The key half never reaches the server.
- **Names too.** Box names, item keys, dock names, tape and device labels, your profile: all sealed. The server finds things by keyed fingerprints it can't reverse.
- **What the server does see:** that accounts exist, how many boxes and devices they have, how much they store, sizes and times of reads and writes, which app talks on which dock. It needs those to do its job (quotas, history, delivery).

So the smart parts moved to where your keys are. Search, the sensitive-data radar, inventory, insights, blast radius, customs at docks and the activity log's plain-English sentences all run in your browser, your CLI or your app's SDK, on data only they can open.

## Getting in, and getting back in

There are no passwords to forget or leak. **Each device is signed in with its own key.**

- **A new device:** on it, press *Add this device*; on a device you already have, press *Add a device* (top of your shelf). Both show the same 6-digit number: press *Yes* if they match. Nothing to type. The new device commits to its key before your device picks its own random part of the number, so whoever passes the messages (even a malicious server) can't slip its own device in with a matching number. (The older way still works: *Or use a pairing code*, or `cardboard pair <url>` and `cardboard devices add <code>`.)
- **Lost a device?** Remove it from any other (`cardboard devices remove <id>`). Its token stops working and its sealed copy of your account key is deleted.

**If you lose every device**, you choose how you get back in (*You → If you lose every device*, or `cardboard recovery`):

| Plan | How it works |
|---|---|
| **Recovery kit** (standard) | A code you print or keep in a password manager. Type it on a new device and you're back. Making a new kit retires the old one. |
| **Another device** | No code at all: you recover by approving a new device from one you still have. Keep at least two signed in. |
| **Trusted friends** | Your recovery key is split into pieces (any 2 of 3 by default, you choose). Give one to each friend; enough of them together get you back in. One piece alone reveals nothing. |
| **No recovery** | Only your signed-in devices can open your Cardboard. Lose them all and the data is gone, for everyone. |

Nobody can reset your account for you, not even whoever runs Cardboard. That's the price of the host being locked out, and it's why the recovery kit is the standard. If your kit or friends' pieces are ever used, Cardboard tells you, loudly, on every device.

### Lock it with Face ID

On *You → Lock with Face ID*, a browser makes a passkey (Face ID, Touch ID, Windows Hello, or a phone's fingerprint). From then on, opening your Cardboard there takes your face, finger or PIN, and it locks itself again when you leave it alone (15 minutes by default; you pick).

This is a real lock, not a screen: the passkey makes a secret (WebAuthn's PRF extension) that the browser never stores, and this device's copy of your account key is sealed by it **and** by the device's own key. The device's token is swapped for a new one and kept sealed too. So someone who picks up your unlocked phone, or copies the browser's storage off a laptop, gets nothing. Passkeys are tied to your Cardboard's address, so a look-alike site can't ask for the same secret. Works in Safari 18+ (iPhone, iPad, Mac), Chrome and Edge 132+, Firefox 135+, over HTTPS.

## Send to yourself

The oldest annoyance on the internet: getting something from your phone to your laptop. On your shelf, **Send to yourself**: type or paste anything (a link, a note, a code), attach or drop files, and press *Send to my devices*. A second later it's on every device you're signed in on, under *Just arrived*, live, with *Copy*, *Open* or *Download* right there. *Keep* puts it in your personal box for good; *Clear* tidies it away (and can be undone).

- **From any app on Android:** once Cardboard is on your home screen, it's in the **Share** menu. Share a photo, a page or some text to Cardboard and it lands on your laptop.
- **On Windows, `Cardboard.exe`** in the Cardboard folder: double-click it and Cardboard runs in the background and opens in its own window. It puts itself on your desktop, and can start with Windows.
- **The Android app** ([`android/`](android/README.md)): a small app that opens your Cardboard in its own window. You type the address once; then it's an icon, it's in the Share menu (videos of any size, read from the phone only as they're sealed), and downloads land in *Downloads › Cardboard*.
- **Sealed on the device it was sent from**, like everything else. Your other devices are told *that* something arrived, then fetch and open it themselves; the server only passes sealed bytes along.
- Files of any size, sent a piece at a time. Paste a screenshot straight into the box.

## Friend boxes

For the video Discord won't take, or the folder you'd otherwise put in a shared Dropbox: on your shelf, **Make a friend box**. You get a link; anyone who has it opens the box in their browser, with **no account and no app**: they play videos right there, download, and (if you tick it) add files back to you.

- **The key is in the link**, after the `#`, which browsers never send to the server. Whoever runs the server still can't see inside.
- **The link opens that box only.** It carries a key for that one box, never one of your account's.
- **Links expire** (1 day, 7 days, 30 days, or when you stop them), and *Stop the link* shuts it straight away. What's in the box stays yours.
- What friends add shows up for you live, marked with the name they give, and can be undone like everything else.
- **Collection boxes:** choose *Only add files* and the people with the link can add, but can't see what's in the box: only you can. For the wedding, the trip, the class photos.
- Where photos and videos were taken is taken out of whatever friends add, on their device, before it's sealed.

## Small things that matter

- **Location stays home.** Phones write where every photo and video was taken into the file (JPEG, PNG, WebP, iPhone HEIC, AVIF, MP4/MOV). Cardboard takes just that out, on your device, before it's sealed: the picture, the date and which way up it is stay. (You → Privacy turns it off for your own uploads.)
- **Big uploads survive a bad connection.** A dropped connection is tried again; if it stays down, what got there is kept, and adding the same file again carries on from where it stopped.
- **Find duplicates** in your personal box and friend boxes: the same content under any name, by its fingerprint. The oldest stays; the copies go (and can be undone).
- **Backups somewhere else.** Everything lives on the computer Cardboard runs on; a copy on another drive (a USB stick, an SSD) is what brings it back if that computer dies. Cardboard.exe asks where once (Start menu → *Cardboard backups* to change it), copies every day, retries every hour when the drive isn't plugged in, and your shelf says how backups are doing. The copies are sealed like everything else, so any drive will do. (`--backup-to <folder>` when you run it another way.)
- **Cardboard.exe keeps itself up to date** while it runs: it looks for a new version every hour and restarts on it in a few seconds.
- **Only what you use is on screen.** Docks, Apps, tapes and new boxes are for connecting apps you make or run; they show up once you have such a box, or when you turn on *You → For app builders*.
- **Things say what they are.** The activity log and search name your notes, links and files by their titles, and "Worth a look" has a button to where each thing is fixed (the command-line fixes are in `cardboard insights`).

## Convert

**Convert** (in the menu) turns files into other kinds of files, **on your device**: nothing is uploaded to convert it, so it's as private as everything else here. Choose or drop files, pick what they should become, then download the result, keep it in your personal box, or send it to your devices. Files already in your personal box have a *Convert…* button.

| From | To |
|---|---|
| Pictures (PNG, JPEG, WebP, GIF, BMP, AVIF, SVG, ICO) | JPEG, PNG, WebP, smaller sizes, one PDF of many, an animated GIF, an icon |
| Videos | an animated GIF of a clip, a still picture, just the sound (Opus or WAV) |
| Sound (MP3, WAV, OGG, M4A, FLAC…) | Opus (small) or WAV (plays anywhere) |
| Spreadsheets (Excel .xlsx, CSV, TSV, JSON) | each other, a web page, a Markdown table; JSON to YAML |
| Word (.docx), Markdown, text | PDF, a web page, plain text; text to a QR code |
| Anything | a .zip (and a .zip back into its files), Base64 text (and back) |

Not yet: iPhone photos (HEIC), PDFs into pictures or text, making videos smaller. It says so rather than pretending.

## Your personal box

Not everything belongs to an app. On your shelf, *Make my personal box* gives you one box that's just for you: **notes, passwords, links and files** (photos, videos, music, PDFs, anything up to 20 GB each), added and edited right in the dashboard, on your phone or your laptop. Every device you've signed in on opens it.

- **Sealed before it leaves the device**, like everything else: titles, passwords, file names and file contents. Which box is your personal one is sealed in your profile, so the server can't even tell.
- **Passwords** stay hidden until you tap *Show*, copy in one tap, and *Make a strong one* makes a 20-character password with no look-alike characters. Search finds them by name, website or username, never by the password itself.
- **Files** are sealed in parts of just under 1 MB, a few at a time, so even a long video never has to fit in your phone's memory; *Stop* leaves nothing behind. They take their real size on the server (no base64, and no second copy in history), and a SHA-256 over the parts (sealed too) is checked when you download one.
- **Videos and music play right in Cardboard**, starting at once and jumping anywhere: a small helper in the browser (a service worker) asks the page for just the pieces the player needs, and the page fetches and opens only those parts. The helper never holds a key, and answers only while the page that opened the file is open. Images show a preview. Nothing is ever opened as a page inside the dashboard: other files download (big ones streamed to disk), and on a phone *Send or save…* hands a file to the share sheet (Save to Photos, Files…).
- **Every change can be undone**: *Earlier versions* brings an old note or password back, and a deleted thing comes back with *Undo*. A deleted file keeps its space for the box's history days; *Free the space now* lets it go at once.
- **Changed on another device while you had it open?** It tells you, instead of silently overwriting.
- No app can read it unless you give one a tape, and Cardboard warns you if one can.

It's an ordinary box underneath (`notes/…`, `passwords/…`, `links/…`, `files/…`, with file contents in `file-data/…`), so `cardboard export personal --out personal.jsonl` backs it up, a line at a time, and your own scripts can use it. Each person gets 10 GB by default (the host can change that), and the personal box has no smaller limit of its own.

## What makes it smart

| | |
|---|---|
| **One-command connect** | `cardboard connect` creates the box and tape, writes `.env`, and adds `.env` to `.gitignore` so the tape can't end up in git. |
| **Labels, not schemas** | Cardboard works out what each box holds from the data itself: collections, fields, types. You never write a schema. |
| **Sensitive-data radar** | It spots API keys (OpenAI, Anthropic, GitHub, AWS, Stripe…), plain-text passwords (hashes are fine), card numbers (Luhn-checked), IBANs, kennitölur, emails and more. Your app gets a notice the moment it stores one; your shelf keeps a running inventory. Worked out in the SDK and on your devices. |
| **Blast radius** | Every tape comes with one honest sentence: *"If this tape leaks, someone could read and change 240 items (1.2 MB) in recipe-app, including 1 API key and 12 email addresses…"* |
| **Undo everything** | Every write is a version. `undo` a key, or **rewind a whole box** to 10 minutes ago after a bad deploy. The server does this without opening anything: it just puts the old sealed version back. |
| **Tapes that clean up after themselves** | By default a tape switches itself off after 90 days *without use*. Apps you use keep working; abandoned ones lock themselves. |
| **Insights** | Cardboard tells you what to fix, with the command that fixes it: secrets in a box, tapes nobody uses, a recovery plan that won't work, devices you haven't seen in months, someone using your recovery kit. |
| **Plain English everywhere** | The activity log reads like *"recipe-app (tape “laptop”) saved “settings/ai”"*. On the server that line is `tape_x put <sealed>`; your device opens it. Every error says how to fix it. |
| **Live** | `watch()` streams changes (sealed on the wire). Revoking a tape cuts its live connections immediately. |
| **Search everything** | Find "lasagna" across every box from the dashboard or `cardboard search`, searched on your device. |

## Docks: apps that help each other without knowing each other

Two of your apps need to share data, but neither should learn who the other is. Cardboard stands in the middle: it carries the parcels and tells nobody who sent what. It can't read them either.

```ts
// recipe-app
await box.dock("shopping-list").send({ item: "lamb", qty: 1 });

// grocery-app
box.dock("shopping-list").on(async (parcel) => {
  await addToList(parcel.body); // parcel.from is "berth-0d621d65da4d", never "recipe-app"
});
```

**Docking is one tap.** The first time an app uses a dock, Cardboard asks you. Approve it on the dashboard (or `cardboard dock approve shopping-list grocery-app`), and an app that's already listening starts receiving straight away. Or set it all up front: `cardboard dock create shopping-list --send recipe-app --receive grocery-app`.

- **Sealed.** Each dock has its own key. When you approve an app, your device seals that key for the app's box. Parcels are sealed by the sender and opened by the receivers; the server only moves bytes.
- **No names.** At each dock an app is only a pseudonym, and it's a *different* pseudonym at every dock, so apps can't link what they see across docks. `dock.reply(parcel, …)` answers privately.
- **Customs at both ends.** Secrets (API keys, passwords, private keys, login tokens) are refused. Personal data (emails, phones, cards, IBANs, kennitölur…) is redacted by default, or refused or allowed per dock. Booby-trapped JSON (`__proto__` keys, absurd nesting) is refused. A **manifest** like `{"item":"string","qty":"number?"}` lets only those fields cross. The sending app's SDK checks what leaves; the receiving app's SDK checks again on arrival, so a careless (or hostile) app that skips its own customs still can't infect or leak through yours. Refusals land in your log and insights.
- **Deliver, then forget.** A parcel is deleted the moment everyone it was for has picked it up, and otherwise expires (7 days by default). Apps that join later still find deposits waiting.
- **You see everything; apps see nothing.** `cardboard dock peek` (or *Look inside* on the dashboard) opens what's in flight on your device and shows which app really sent it.

## Sign in with Cardboard: the universal connector

Cardboard is an **OpenID Connect provider**, the same open standard behind every "Sign in with Google" button. Any app or library with a *generic OpenID Connect* option can connect to it without custom code. It discovers everything from `/.well-known/openid-configuration`, and can even register itself.

But it's built the other way round from the big providers:

- **Every app gets a private ID for you**, different at every app and for every person, so apps can't match you up.
- **Apps get nothing else unless you say so.** Saying yes happens in your dashboard, because that's where your keys are. Cardboard remembers your answer, so next time you're straight in.
- **The app's data about you lives in *your* Cardboard**, sealed. With the `box` scope, the app gets a box in your Cardboard. Your browser seals the box key, and your name and email if the app asked, **to a key the app made for this sign-in**, so they reach the app past the server, which only relays sealed bytes. Disconnect any time (it's cut off instantly), and shred what it kept if you like.

For an app, it's two calls:

```ts
import { registerApp, startSignIn, finishSignIn, resumeSession } from "cardboard";

const { clientId } = await registerApp(issuer, { name: "Recipe Planner", redirectUris: [redirectUri] });
const config = { issuer, clientId, redirectUri, scopes: ["openid", "profile", "box"] };

const pending = await startSignIn(config);                        // send the person to pending.url
const session = await finishSignIn(config, callbackUrl, pending); // on your callback

session.user.id;                                       // private ID: stable for your app only
session.user.name;                                     // only if they said yes (it arrived sealed to you)
await session.box().put("prefs", { theme: "dark" });   // sealed, in THEIR Cardboard
save(session.save());                                  // later: resumeSession(config, saved)
```

Plain OpenID Connect apps (without the Cardboard SDK) work too: they get your private ID, and your name or email only if you tick *pass it in the clear* on the consent screen (it then goes through the server). They can't get a box, because they can't take its key sealed.

Under the hood it follows OAuth 2.1: PKCE is required, redirect URIs must match exactly, codes work once (a replayed code revokes what it produced), refresh tokens rotate (a copied one disconnects the app), ID tokens are ES256-signed, and the issuer is sent back with every response. The shake test attacks all of it.

### If something happens to you

*You → If something happens to you* (or `cardboard emergency add --for Anna`) makes a link, with a QR code you can print, for someone you trust. Add a message for them if you like ("the house papers are in the documents box"); only they can read it.

If they ever open it and choose *Ask for access*, every one of your devices shows a red warning, and a waiting period starts (7 days unless you pick otherwise). **Stop it**, and nothing happens. **Let them in now**, and they're in. Do nothing (because you can't), and when the wait is over they open your Cardboard with the same link: their browser becomes one of your devices, and the link is used up.

The account key is sealed by a key only the link can make, and the link's secret never reaches the server. The server keeps the clock. That means a server you don't trust could cut the wait short for whoever holds the link, but it still couldn't get in itself.

## Sharing a box with people

A box can belong to more than one person: the family shopping list, a shared trip, a couple's budget. On the box's page, *People → Share with someone* (or `cardboard share shopping --for Anna`) makes a link like `https://cardboard.example.com/#share=K7Q2-…`, with a QR code. Send it privately, or let them scan it; the person opens it with their own Cardboard account on the same server, says what to call them, and they're in. No account yet? *You → Invite a friend* makes one an invite link (the host can turn that off). Their apps can use the box too, and when they *Sign in with Cardboard* to an app, they can pick the shared box so you both see the same data, live.

- **The server never gets the key.** The link's secret is after the `#`, which browsers never send anywhere. A key made from it seals the box key for whoever opens it; they re-seal it with their own account key, and the link is used up. One use, then it's gone (3 days by default, 30 at most), and you can cancel it before then.
- **Read-only or read-and-change.** A read-only person can't write from their devices or from any tape they make.
- **Everyone sees who did what.** The activity log says *"Anna saved “eggs”"* and *"Gosinn (in an app) saved “milk”"*, using the name each person chose, sealed by the box key. Each person's own devices, tapes and other boxes stay private.
- **Taking someone off** (or them leaving) stops the server serving them anything, revokes their apps' tapes on the box and disconnects apps they signed in with it, at once. Honest caveat: they held the box key, so whatever they already saw, they keep. Cardboard doesn't re-key boxes yet.
- Only the owner changes settings, rewinds, shares or shreds. Docks stay between boxes you own.

## AI assistants (MCP)

Claude and other assistants connect through **Cardboard running on your own computer**:

```bash
cardboard assistant add claude --see notes,recipes --change recipes
# prints the line for your assistant, e.g.
claude mcp add cardboard -- node /path/to/cardboard/src/cli.ts mcp claude
```

- **Keys for what you share, nothing else.** The assistant's Cardboard process holds one tape per box you shared: it *can't* open the rest, because it has no key for them. The server still sees nothing; the opened data goes straight from your computer to the assistant.
- **Its own box.** A memory *you* own (`assistant-claude`), for remembering things across conversations. Read it, edit it or shred it.
- **Read-only unless you say so**, and **everything on the record**: the log says *"claude (AI assistant) read “notes/groceries”"*, and every change it makes can be undone.

It gets 9 tools: `list_boxes`, `list_keys`, `read_item`, `find_items`, `search`, `save_item`, `delete_item`, `undo_change` and `item_history`. Change what it sees by running `assistant add` again; cut it off with `cardboard assistant remove claude`.

Hosted AI connectors (like adding a URL in Claude on the web) would need the server to read your data for them, so Cardboard doesn't offer that. That's the trade.

## What makes it private

- **End-to-end encryption** with AES-256-GCM, HKDF and ECDH P-256 from WebCrypto: the same code in your browser, your CLI and your apps. No custom primitives.
- **Sealed data is bound to where it lives.** Moving a sealed value onto another key or box, or flipping a byte, is caught by the app before it uses the data.
- **Locked by default.** No token, no access. Browsers are refused unless you allow a specific origin. Your devices only answer Cardboard's own dashboard.
- **Accounts can't see each other.** Another person's box looks exactly like no box.
- **Narrow tapes.** Read-only or write-only, expiring, revocable. Revoking also deletes the tape's sealed copy of the box key.
- **Only hashes of tokens are stored.** Guessing is rate-limited, per address.
- **Crypto-shredding.** `shred` deletes a box's sealed key with everything else, overwriting the freed pages (`secure_delete`) and truncating the WAL. Old backups still hold the sealed bytes, but nothing can open them.
- **Expired means gone.** When an item expires, its history goes with it.
- **The shake test.** On every start, Cardboard attacks itself through its real API *and* its real client code, with throwaway accounts: it scans its own database for a canary it just wrote (the server can't read anyone's data), tries cross-box and cross-account reads, revoked and expired tapes, foreign websites, tampering and swapping, a swapped pairing key, wrong recovery codes, a stolen Face-ID-locked device, reused share links and people taken off a box, emergency access before its wait is over, a hostile app smuggling a booby-trapped parcel past its own customs, and every Sign in with Cardboard trick. It reports what held (`cardboard host shake`, and the *Security* page for everyone).

### Honest threat model

Cardboard **protects you against:**
- whoever runs the server, or anyone who gets a copy of its disk or backups: they get sealed bytes and metadata
- one leaky app (it only holds its own box's key, can be revoked in one click, and shows you its blast radius)
- a stolen device (lock it with Face ID, and remove it from any other: its copy of your account key is deleted)
- a share link someone reads after it was used (it works once)
- someone finding your emergency access link (you're warned on every device and can stop it)
- a buggy app wrecking its data (history, undo, rewind)
- tampering with stored data (caught when it's opened)

It **doesn't protect against:**
- **the dashboard's own code.** It's served by the server. A server that turned malicious could send you a dashboard that steals your keys the next time you open it. The CLI and the SDK don't have this problem: their code is installed on your computer. If you don't fully trust the host, use the CLI, or serve `public/` yourself. (The media helper that plays videos is a service worker, which stays in the browser between visits; browsers fetch it fresh on every visit, so a server that's been put right replaces a bad one straight away.)
- **metadata.** The server sees sizes, times, counts, which app talks on which dock, and which accounts share a box. In your personal box that includes roughly how big each file is, and when a video is being played (it sees which parts are fetched, never what's in them).
- **someone you shared a box with keeping what they saw.** Taking them off cuts them off from then on; it can't make them forget. A share link intercepted *before* it's used works for whoever opens it first, so send links privately.
- **a compromised device or app.** Whatever can open your data, can open your data. A leaked tape exposes its box until you revoke it (and anything it already copied).
- **rollback.** A malicious server could hand an app an older sealed version of an item. It can't forge or move data, but it can replay.
- **an AI assistant being tricked by what it reads** (prompt injection in shared data). Keep shares small and read-only.
- **losing every device with no recovery plan.** Then nobody can get the data back. That's the point.

---

## CLI

```
cardboard start                         start the server (dashboard at /)
cardboard signup [invite-link]          make your account on this computer (prints your recovery kit)
cardboard connect <app>                 box + tape + .env, in one go
cardboard whoami | devices | devices add <code> | devices remove <id>
cardboard pair <url>                    sign a new computer in from one you have
cardboard recover <url> --kit "<code>" | --friends <piece>,<piece>
cardboard recovery [kit|device|friends|none] [--friends 3 --need 2]
cardboard boxes | box <name>            what's where, labels, tapes, blast radius
cardboard log [box] | insights | search <text>
cardboard tape <box> [--read-only] [--idle 30d|never] [--expires 7d] | blast <tape-id> | revoke <tape-id>
cardboard set <box> <setting> <value>   secrets block · defaultTtl 30d · quotaBytes 1GB · historyDays 90
cardboard allow <box> <origin> | rename <box> <new> | rewind <box> 10m
cardboard export [box] | import <box> <file> | shred <box>
cardboard docks | dock create <dock> --send a,b --receive c
cardboard dock approve|deny <dock> <app> · dock add <dock> <app> --as send|receive|both
cardboard dock remove <dock> <app> · dock set <dock> personal block · dock peek <dock> · dock shred <dock>
cardboard apps | apps add "<name>" --redirect <url> [--public] | apps disconnect <app> [--shred] | apps forget <id>
cardboard profile --name "…" --email …   sealed; apps get it only if you say yes
cardboard assistant add <name> [--see a,b] [--change c] | assistant list | assistant remove <name> | mcp <name>
cardboard share <box> [--for Anna] [--read-only] [--expires 3d] | shares | share cancel <link-id>
cardboard join <link> [--as "Anna"] | people remove <box> <name> | leave <box>
cardboard invite [list|cancel <id>]       an invite link (and QR code) for a friend
cardboard emergency add --for Anna [--wait 7d] [--message "…"] | emergency | emergency stop|allow|remove <name>
cardboard signout | delete-account

cardboard host [invite|invites|accounts|delete|quota|shake|backup|log|login]   running the server
cardboard reset-host                    new host token (on the server)
```

## SDK

| | |
|---|---|
| `get(key)` / `getItem(key)` / `has(key)` | read (null when missing) |
| `getMany(keys)` | several items in one request, in your order (missing ones left out) |
| `put(key, value, { ttl: "30d", ifVersion })` | write; `ifVersion` prevents lost updates. A `Uint8Array` is stored as bytes (and comes back as one) |
| `patch(key, changes)` | JSON merge patch (`null` removes a field); retries by itself if someone else wrote in between |
| `delete(key, { purge })` | delete (undoable). `purge` deletes for good, from your own devices only: apps can't erase history, so whatever an app does can be undone |
| `list(prefix)` / `keys(prefix)` / `items(prefix, { skip })` | list (and open) everything under a prefix; with a prefix or `skip(key)`, only the values you want are downloaded |
| `query({ prefix, where, sort, limit, offset })` | `where` supports equality, dot paths, array contains, `$gt $gte $lt $lte $ne $in $nin $exists $contains $startsWith $or $and $not`; runs in the SDK |
| `history(key)` / `undo(key, { to })` | versions, newest first; undo again to redo |
| `batch([...])` | several writes that all happen or none do |
| `watch(prefix, onChange, { values })` | live changes; reconnects by itself. Big values (a file's parts) aren't pushed down the connection: they're fetched for you, or skipped with `values: false` |
| `collection(name)` | `add`, `get`, `set`, `update`, `remove`, `find`, `findOne`, `count`, `all`, `watch` with time-ordered ids |
| `dock(name)` | `send(body, { to })`, `reply(parcel, body)`, `receive({ ack })`, `ack(parcel)`, `status()`, `on(handler, { onWaiting, onRefused })` |
| `introduce({ title, description, url, version })` | tell Cardboard who this app is (sealed) |
| `registerApp`, `startSignIn`, `finishSignIn`, `resumeSession` | Sign in with Cardboard from any app (Node or browser). Pass `storage` (e.g. localStorage) and the session saves itself after every refresh, shared by all your tabs. See [docs/APPS.md](docs/APPS.md) |

Errors are `CardboardError`s with a `code`, a plain message and a `hint`. Everything runs in Node and in browsers (WebCrypto), with zero dependencies. Querying opens every item under the prefix, which is fine at personal scale (tens of thousands of items).

**Your own tools:** `cardboard/account` is the library the CLI and dashboard are built on: `signUp`, `unlock`, `startPairing`, `recoverWithKit`, and an `Account` with boxes (and `makePersonalBox`; `cardboard/personal` reads and writes its notes, passwords, links and files), tapes, docks, apps, sharing (`shareBox`, `joinShare`, `removeMember`, `leaveBox`), Face ID locks (`lockWithPasskey`, `removeLock`), emergency access (`addEmergencyLink`, `stopEmergency`, and `viewEmergency`/`requestEmergency`/`claimEmergency` for the person holding the link), friend invites, the log, insights and search, all opened on the device.

## The wire

Every call is `POST /v1/<operation>` with a JSON body. The token decides who you are: an app's tape (`cbt_…`, token half only), one of your devices (`cbd_…`), the host (`cbh_…`), or nothing (sign up, pairing, recovery). Item names travel as keyed fingerprints and everything else as sealed base64url bytes, so there's no plain `curl` to store something: use the SDK, which does the sealing. Sign in with Cardboard uses the standard OAuth/OpenID endpoints under `/oauth/`.

## Running it for real (the host)

**[docs/DEPLOY.md](docs/DEPLOY.md)** walks through it in about ten minutes: for free from your own computer (`cardboard start --tunnel tailscale` gives it a fixed `https://` address through Tailscale Funnel, with HTTPS ending on your computer), on Railway (nothing to look after), or with Docker and Caddy (automatic HTTPS) on any small server.

```bash
echo CARDBOARD_DOMAIN=cardboard.example.com > .env
docker compose up -d --build                                   # Cardboard + Caddy (automatic HTTPS) + daily backups
docker compose exec cardboard node src/cli.ts host invite --note "for Siggi"
```

Or without Docker:

```bash
CARDBOARD_DATA=/srv/cardboard cardboard start --public-url https://cardboard.example.com --trust-proxy --backup-every 1d
cardboard host invite --note "for Siggi"      # an invite link, one use, 7 days
```

- **Invites by default.** `--open-signup` lets anyone in (they still can't see each other's data, but they use your disk). Each account gets 10 GB unless you set `cardboard host quota <account> 50GB` (or `--account-quota` for everyone).
- **HTTPS, always, beyond localhost.** Data is sealed either way, but tokens and the dashboard's own code aren't. Use Caddy (`reverse_proxy 127.0.0.1:8787`, then `--trust-proxy`), Tailscale, or `--tls-cert/--tls-key`.
- **Backups:** `--backup-every 1d` (on in the Docker setup) or `cardboard host backup` writes a snapshot to `<data>/backups/` (keeps the newest 10, or 3 once the database is over 1 GB, and skips a backup that wouldn't fit on the disk). What people keep is sealed in it, so it can't be opened without their devices. `--backup-to <folder>` also copies each one to another drive. Keep `server.key` safe *separately* (not next to the backups): it protects the server's own secrets (sign-in signing key, private IDs, dock pseudonyms), and with both, someone could pretend to be your people at apps. Lose it and apps see everyone as a new person; nobody loses data.
- **What you can see:** `cardboard host accounts` lists every account's boxes, devices, storage and last-seen time. That's all there is.
- **Phones:** tell people to add Cardboard to their home screen (Safari: Share → Add to Home Screen). It gets an app icon, and Safari never clears its storage, which is where that phone's key lives.

Coming from Cardboard 0.1 (keys on the server)? 0.2 and later start from a new data folder: export your boxes with 0.1 (`cardboard export <box>`), then `cardboard import <box> <file>` into your new account. From 0.2 on, updates migrate the database by themselves.

## Roadmap

- **Key rotation**: a fresh account key, box key or dock key after you remove a device, an app or a person
- **Emergency access for parts of your Cardboard** (chosen boxes only), and warnings by email or push, not just on your devices
- **Signed dashboard releases**, so a turned server can't quietly serve you different code
- **Courier**: Cardboard holds your third-party API keys and makes calls for your apps, so apps never see the keys
- **Offline** use of your personal box, file sharing by link, a Python SDK

## Development

```bash
npm test          # unit + integration + CLI tests
npm run typecheck
npm run build     # compiles to dist/ (what other apps install)
```

## License

[AGPL-3.0-or-later](LICENSE). Use it, change it, run it for your family or your company. If you run a changed copy for other people, you share your changes with them too.
