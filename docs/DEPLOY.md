# Putting Cardboard on a server

Two ways, both with real HTTPS, daily backups, and phones that open it with Face ID:

- **[A. Railway](#a-railway-no-server-to-look-after)**: no server to look after. About 10 minutes in a web browser, a few dollars a month. Best for trying it out with friends.
- **[B. Your own server](#b-your-own-server-docker--caddy)** (a VPS or a Raspberry Pi) with Docker. A bit more setup, full control.

**Decide the address before you rely on it.** Devices, Face ID locks and app sign-ins are tied to the address Cardboard is reached at. Moving later is possible (everyone signs back in with their recovery kit or by pairing, and turns Face ID on again), but it's easier not to.

## A. Railway (no server to look after)

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

6. Let it redeploy, then open the deployment's **logs**. On the very first start Cardboard prints the **host token** and an **invite link** for your own account, and the shake test's result (it should say `41/41 passed`).

Then carry on at [Make your account](#make-your-account).

To run host commands (invites, backups, the shake test) from your own computer:

```bash
cardboard host login https://your-address <host-token>
cardboard host invite --note "Siggi"
```

## B. Your own server (Docker + Caddy)

You need a small Linux server with Docker (1 CPU and 1 GB of memory is plenty for a family: Hetzner, DigitalOcean, a Raspberry Pi at home with ports 80 and 443 forwarded…) and a domain name.

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
3. **Add your laptop:** open the same address there and choose *Use a device I have*. It shows a QR code: scan it with your phone's camera and approve.
4. **Invite your friend:** *You → Invite a friend*. Send the link, or let them scan the QR code. Their account is theirs alone: you can't see into it, even as the host.
5. **Share a box with them:** open a box, then *People → Share with someone*.
6. **If something happens to you:** *You → If something happens to you* makes a link (and a printable QR code) for someone you trust.

## Connect your apps

On your computer:

```bash
cardboard pair https://your-address     # shows a QR code: scan it with your phone and approve
cd ~/code/my-app && cardboard connect    # box + tape + .env
```

Websites (like LORE) use Sign in with Cardboard: see [APPS.md](APPS.md).

## Backups

- Every day, Cardboard writes a snapshot to `/data/backups` and keeps the newest 10. Make one any time: `cardboard host backup`.
- **Copy them somewhere else now and then** (a backup on the same disk doesn't survive the disk). With Docker: `docker compose cp cardboard:/data/backups ./cardboard-backups`. Backups hold only sealed data, so any cloud drive is fine.
- **Keep one copy of `/data/server.key`** somewhere safe. It doesn't open anyone's data, but without it every app sees everyone as a new person after a restore.

To restore: stop Cardboard, put a backup in place as `/data/cardboard.db` (delete `cardboard.db-wal` and `cardboard.db-shm` if they're there, and put `server.key` next to it), then start it again.

## Updating

Railway redeploys by itself when the repository changes. With Docker:

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
| `--public-url` | `CARDBOARD_PUBLIC_URL` | The address people and apps use (the Sign in with Cardboard issuer) |
| `--port` | `CARDBOARD_PORT` or `PORT` | Default 8787 |
| `--data` | `CARDBOARD_DATA` | Where the database, server key and backups live |
| `--trust-proxy` | `CARDBOARD_TRUST_PROXY=1` | Behind one reverse proxy of your own |
| `--backup-every 1d` | `CARDBOARD_BACKUP_EVERY` | Scheduled backups |
| `--open-signup` | `CARDBOARD_OPEN_SIGNUP=1` | Anyone can make an account (default: invite only) |
| `--invites host` | `CARDBOARD_INVITES=host` | Only the host makes invites (default: everyone can invite friends, 5 waiting each) |

## What to know before you rely on it

- **Cardboard is 0.x and hasn't had an outside security audit.** The design keeps the host locked out, and the shake test checks that on every start, but keep your own exports of anything you can't lose (`cardboard export`).
- **The dashboard's code comes from your server.** Whoever controls the server (or your Railway account) could serve a dashboard that steals keys. Use a strong password and two-factor login on GitHub and Railway, or keep the server updated with SSH keys only.
- **Nobody can reset a lost account**, including you as the host. Make sure everyone saves their recovery kit.
