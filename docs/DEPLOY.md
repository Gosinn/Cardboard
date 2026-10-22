# Putting Cardboard online

Three ways, all with real HTTPS (which Face ID needs) and phones that open it like an app:

- **[A. Free, on your own computer](#a-free-on-your-own-computer)**: one command, no hosting, no money. Online while the computer is on and awake. Best for trying it out with a friend.
- **[B. Railway](#b-railway-paid-always-on)**: a few dollars a month, always on, nothing to look after.
- **[C. Your own server](#c-your-own-server-docker--caddy)** (a VPS or a Raspberry Pi) with Docker. Always on, full control.

**Decide the address before you rely on it.** Devices, Face ID locks and app sign-ins are tied to the address Cardboard is reached at. Moving later is possible (everyone signs back in with their recovery kit or by pairing, and turns Face ID on again), and your data comes along, but it's easier not to.

## A. Free, on your own computer

Your computer runs Cardboard, and Tailscale Funnel (free) gives it an `https://` address anyone can reach. Cardboard itself only listens on your computer: nothing else on your network is opened up, and HTTPS ends on your computer (Tailscale only passes encrypted traffic along).

You need **Node.js** (nodejs.org, the LTS version), **Git**, and **Tailscale** (tailscale.com/download), installed, with Tailscale signed in. On Windows, PowerShell installs the first two for you:

```
winget install --id OpenJS.NodeJS.LTS -e
winget install --id Git.Git -e
```

Then **close PowerShell and open it again** (until you do, it says `git` or `node` "is not recognized").

**1. Get Cardboard** (once). In PowerShell (Windows) or Terminal (Mac):

```
git clone https://github.com/Gosinn/Cardboard.git
cd Cardboard
```

**2. Start it:**

```
node src/cli.ts start --tunnel tailscale
```

**3. Only the very first time:** the window may say *"Tailscale needs you to switch Funnel on"* and show a link starting with `https://login.tailscale.com/…`. Copy that link into your browser, sign in to Tailscale if it asks, and click **Enable**. Go back to the window: it carries on by itself.

**4. When it's running**, the window shows:

- `Cardboard is online at https://….ts.net` (or `…ts.net:8443` if your Tailscale already uses the usual port for something else). That's your Cardboard's address, the same every time.
- **A square QR code drawn in the window itself**, made of black and white blocks. Point your phone's camera at it and tap the link that pops up: that opens *Welcome to Cardboard* on your phone. Tap **Make my account**.

A moment later it checks the address itself and says **✓ Your address works** once phones can open it. The very first time, that can take up to 10 minutes while the internet learns the new address; the window tells you while it's waiting.

**5. Leave the window open.** Cardboard is online while it runs. Ctrl+C stops it (and takes the address offline).

**No more typing it, on Windows:** double-click **`Cardboard.exe`** in the Cardboard folder (or a copy of it anywhere, like your desktop: it finds the folder). Cardboard starts in the background (no window to keep open) and opens in its own app window. The first time, it puts Cardboard on your desktop and in the Start menu, and asks whether to start with Windows and keep the computer awake while it's plugged in. Open it again any time from the desktop: if Cardboard is already running, it just opens the window. Each start gets the newest version. To stop Cardboard: Task Manager → *Cardboard* → End task.

To see what Cardboard says while it runs (when something's wrong), double-click **`start-cardboard.cmd`** in the Cardboard folder instead. It gets the newest version, starts Cardboard online, and starts it again if it ever stops. Or have it start by itself whenever you sign in to Windows:

```
node src/cli.ts autostart on
```

That also stops the computer sleeping while it's plugged in, and keeps it running with the lid closed (a laptop that sleeps takes Cardboard offline). `node src/cli.ts autostart off` undoes the starting.

**Not working?** Open a second PowerShell (or Terminal) window, `cd Cardboard`, and run `node src/cli.ts doctor`. It says what's running, what Tailscale is sharing, and whether the address answers, with nothing secret in it, so you can paste it to whoever is helping you.

To start it again later: open PowerShell, `cd Cardboard`, and run the same `node src/cli.ts start --tunnel tailscale`. Same address, same data (it's kept in the `cardboard-data` folder inside `Cardboard`).

Good to know:

- **Use the `https://` address everywhere, on this computer too.** `http://127.0.0.1:8787` counts as a different place to your browser, with its own sign-in.
- **Keep the computer awake.** Windows: Settings → System → Power → *when plugged in, put my device to sleep after*: **Never**. Mac: start it with `caffeinate -i node src/cli.ts start --tunnel tailscale`.
- **Linux:** let your user set up Funnel once: `sudo tailscale set --operator=$USER`.
- **Updating:** stop it (Ctrl+C), run `git pull`, start it again.

**No account at all, just for an afternoon?** `node src/cli.ts start --tunnel cloudflare` (install `cloudflared` first: `winget install Cloudflare.cloudflared` on Windows, `brew install cloudflared` on a Mac). No sign-up, but it's a **new address every time** it starts (then everyone signs back in with their recovery kit or by pairing), live updates may not get through, and HTTPS ends at Cloudflare rather than on your computer.

**Always on, still free:** the same command on an old laptop or a Raspberry Pi that stays on at home. (Free cloud servers exist too, such as Oracle Cloud's Always Free tier, but they usually ask for a card at sign-up to check you're real.)

Then carry on at [Make your account](#make-your-account).

## B. Railway (paid, always on)

1. Go to [railway.com](https://railway.com) and sign in with GitHub.
2. **New project → Deploy from GitHub repo → Gosinn/Cardboard.** Railway builds it from the `Dockerfile`; `railway.json` tells it how to check it's healthy.
3. **Add a volume** to the service with the mount path `/data`. Do this before anything else: without a volume, everything is wiped on every deploy.
4. In the service's **Settings → Networking**, choose **Generate Domain**. You get an address like `https://cardboard-production-1234.up.railway.app` (or add your own domain there).
5. In **Variables**, add:

   | Variable | Value |
   |---|---|
   | `CARDBOARD_PUBLIC_URL` | `https://${{RAILWAY_PUBLIC_DOMAIN}}` (or `https://` plus your own domain) |
   | `CARDBOARD_TRUST_PROXY` | `1` |
   | `CARDBOARD_BACKUP_EVERY` | `1d` |

6. Let it redeploy, then open the deployment's **logs**. On the very first start Cardboard prints the **host token** and an **invite link** for your own account, and the shake test's result (it should say every check passed, like `43/43 passed`).

Then carry on at [Make your account](#make-your-account).

To run host commands (invites, backups, the shake test) from your own computer:

```bash
cardboard host login https://your-address <host-token>
cardboard host invite --note "Siggi"
```

## C. Your own server (Docker + Caddy)

You need a small Linux server with Docker (1 CPU and 1 GB of memory is plenty for a family: 1984 Hosting in Iceland, Hetzner, DigitalOcean, a Raspberry Pi at home with ports 80 and 443 forwarded…) and a domain name. Pick the disk size for what you'll keep: photos and videos need room (the database holds everything, and backups need about as much again).

1. Add an `A` record (and `AAAA` for IPv6) for `cardboard.yourdomain.com` pointing at the server. Wait until `ping cardboard.yourdomain.com` answers from that address.
2. On the server:

   ```bash
   git clone https://github.com/Gosinn/Cardboard.git cardboard && cd cardboard
   echo CARDBOARD_DOMAIN=cardboard.yourdomain.com > .env
   docker compose up -d --build
   docker compose logs cardboard        # the host token, your invite link, the shake test
   ```

   That starts **cardboard** (its data in the `cardboard-data` volume, backed up daily) and **caddy**, which gets a certificate from Let's Encrypt and renews it by itself.

Host commands run inside the container: `docker compose exec cardboard cardboard host invite --note "Siggi"`.

## Make your account

Open the invite link **on your phone**, make your account, and save the recovery kit it shows (a password manager is a good place). Then:

1. **Add it to your home screen.** iPhone: Safari's Share button → *Add to Home Screen*. Android: Chrome's menu → *Add to Home screen*. It gets an icon, opens like an app, and the browser won't clear its storage (where this phone's key lives).
2. **Turn on Face ID:** *You → Lock with Face ID*.
3. **Make your personal box:** on the shelf, *Make my personal box*. Notes, passwords, links and files, just for you, on every device you sign in on.
4. **Add your laptop:** open the same address there and choose *Use a device I have*. It shows a QR code: scan it with your phone's camera and approve.
5. **Invite your friend:** *You → Invite a friend*. Send the link, or let them scan the QR code. Their account is theirs alone: you can't see into it, even as the host.
6. **Share a box with them:** open a box, then *People → Share with someone*.
7. **If something happens to you:** *You → If something happens to you* makes a link (and a printable QR code) for someone you trust.

## Connect your apps

On your computer:

```bash
cardboard pair https://your-address     # shows a QR code: scan it with your phone and approve
cd ~/code/my-app && cardboard connect    # box + tape + .env
```

Websites (like LORE) use Sign in with Cardboard: see [APPS.md](APPS.md).

## Backups

- Every day, Cardboard writes a snapshot to `/data/backups` and keeps the newest 10 (3 once the database is over 1 GB, say with videos in it). Make one any time: `cardboard host backup`.
- **Space:** each person gets 10 GB unless you say otherwise (`--account-quota 50GB` for everyone, or `cardboard host quota <account-id> 50GB` for one person; `cardboard host accounts` lists the ids). Whatever the limits, Cardboard stops taking new data when less than 1 GB is left on the disk, so it can't fill the computer it runs on.
- **Copy them somewhere else now and then** (a backup on the same disk doesn't survive the disk). With Docker: `docker compose cp cardboard:/data/backups ./cardboard-backups`. Backups hold only sealed data, so any cloud drive is fine.
- **Keep one copy of `/data/server.key`** somewhere safe. It doesn't open anyone's data, but without it every app sees everyone as a new person after a restore.

To restore: stop Cardboard, put a backup in place as `/data/cardboard.db` (delete `cardboard.db-wal` and `cardboard.db-shm` if they're there, and put `server.key` next to it), then start it again.

## Updating

On your own computer: stop it (Ctrl+C), `git pull`, start it again. Railway redeploys by itself when the repository changes. With Docker:

```bash
docker compose exec cardboard cardboard host backup
git pull && docker compose up -d --build
```

The database migrates itself on start.

## Keeping an eye on it

- `cardboard host` shows how the server is doing, with advice.
- `cardboard host shake` attacks the running server and reports what held. Everyone sees the latest result on their *Security* page.
- `/health` answers `{"ok":true}`, for uptime monitors.

## Without Docker

Node 22.18 or newer, then:

```bash
git clone https://github.com/Gosinn/Cardboard.git /opt/cardboard
CARDBOARD_DATA=/var/lib/cardboard/data node /opt/cardboard/src/cli.ts start \
  --public-url https://cardboard.yourdomain.com --trust-proxy --backup-every 1d
```

[`deploy/cardboard.service`](../deploy/cardboard.service) runs it as a locked-down systemd service. Put Caddy in front (`reverse_proxy 127.0.0.1:8787`, as in [`deploy/Caddyfile`](../deploy/Caddyfile)), or nginx. Only use `--trust-proxy` with exactly one proxy of your own in front.

## Settings

| Option | Environment | |
|---|---|---|
| `--tunnel tailscale\|cloudflare` | `CARDBOARD_TUNNEL` | Online from this computer: sets the address and HTTPS for you |
| `--public-url` | `CARDBOARD_PUBLIC_URL` | The address people and apps use (the Sign in with Cardboard issuer) |
| `--port` | `CARDBOARD_PORT` or `PORT` | Default 8787 |
| `--data` | `CARDBOARD_DATA` | Where the database, server key and backups live |
| `--trust-proxy` | `CARDBOARD_TRUST_PROXY=1` | Behind one reverse proxy of your own |
| `--backup-every 1d` | `CARDBOARD_BACKUP_EVERY` | Scheduled backups |
| `--open-signup` | `CARDBOARD_OPEN_SIGNUP=1` | Anyone can make an account (default: invite only) |
| `--invites host` | `CARDBOARD_INVITES=host` | Only the host makes invites (default: everyone can invite friends, 5 waiting each) |
| `--account-quota 50GB` | `CARDBOARD_ACCOUNT_QUOTA` | Room each person gets (default 10 GB) |

## What to know before you rely on it

- **Cardboard is 0.x and hasn't had an outside security audit.** The design keeps the host locked out, and the shake test checks that on every start, but keep your own exports of anything you can't lose (`cardboard export`).
- **The dashboard's code comes from your server.** Whoever controls the server (or your Railway account) could serve a dashboard that steals keys. Use a strong password and two-factor login on GitHub and Railway, or keep the server updated with SSH keys only.
- **Nobody can reset a lost account**, including you as the host. Make sure everyone saves their recovery kit.
