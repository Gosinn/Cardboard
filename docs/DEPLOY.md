# Putting Cardboard on a server

This gets Cardboard running at `https://cardboard.yourdomain.com`, with a real HTTPS certificate, daily backups, and phones that open it with Face ID. About ten minutes.

You need:

- **A small server.** 1 CPU and 1 GB of memory is plenty for a family (Hetzner CX22, a DigitalOcean droplet, a Raspberry Pi at home with a port forwarded…). Any Linux with Docker.
- **A domain name** you can add a DNS record to.

HTTPS isn't optional: browsers only allow Face ID (passkeys) on HTTPS, and your devices' tokens travel with every request.

## 1. Point your domain at the server

Add an `A` record (and `AAAA` if the server has IPv6) for `cardboard.yourdomain.com` pointing at the server's address. Wait until `ping cardboard.yourdomain.com` answers from that address.

## 2. Start it

On the server:

```bash
git clone https://github.com/Gosinn/Cardboard.git cardboard && cd cardboard
echo CARDBOARD_DOMAIN=cardboard.yourdomain.com > .env
docker compose up -d --build
```

That starts two containers:

- **cardboard**: the server. Its data lives in the `cardboard-data` volume. It backs itself up once a day.
- **caddy**: gets a certificate from Let's Encrypt on first start and renews it by itself. Ports 80 and 443 need to be open.

## 3. Make your account

```bash
docker compose logs cardboard
```

On the very first start it prints:

- **The host token** (`cbh_…`). It's what runs the server: invites, backups, the shake test. It can't open anyone's data. It's also saved inside the volume, so the commands below work without it.
- **An invite link** for your own account, and the shake test's result (it should say `40/40 passed`).

Open the invite link **on your phone**, make your account, and save the recovery kit it shows you (a password manager is a good place). Then:

1. **Add it to your home screen.** iPhone: Safari's Share button → *Add to Home Screen*. Android: Chrome's menu → *Add to Home screen*. It gets an icon, opens like an app, and the browser won't clear its storage (where this phone's key lives).
2. **Turn on Face ID:** *You → Lock with Face ID*.
3. **Add your laptop:** open the same address there, pick *Use a device I have*, and type the code it shows on your phone (*You → Add a device*).

## 4. Invite your family

```bash
docker compose exec cardboard node src/cli.ts host invite --note "Anna"
```

Send them the link. Each person gets their own account and their own keys: you, as the host, can't see their data either.

To share a box with them (a shopping list, a trip), open the box on your shelf, then *People → Share with someone*, and send them that link.

## 5. Connect your apps

On your computer, sign the CLI in to your server and connect an app:

```bash
cardboard pair https://cardboard.yourdomain.com     # shows a code: approve it on your phone
cd ~/code/my-app && cardboard connect                # box + tape + .env
```

Apps that use **Sign in with Cardboard** use `https://cardboard.yourdomain.com` as the issuer.

## Backups

- Every day, Cardboard writes a snapshot to `/data/backups` inside the volume and keeps the newest 10. Make one any time: `docker compose exec cardboard node src/cli.ts host backup`.
- **Copy them somewhere else** now and then (a backup on the same disk doesn't survive the disk): `docker compose cp cardboard:/data/backups ./cardboard-backups`. Backups hold only sealed data, so any cloud drive is fine.
- **Keep one copy of `/data/server.key`** somewhere safe (`docker compose cp cardboard:/data/server.key .`). It isn't needed to open anyone's data, but without it every app sees everyone as a new person after a restore.

To restore: stop Cardboard, put a backup in place as `/data/cardboard.db` (delete `cardboard.db-wal` and `cardboard.db-shm` if they're there, and put `server.key` next to it), then start it again.

## Updating

```bash
docker compose exec cardboard node src/cli.ts host backup
git pull && docker compose up -d --build
```

The database migrates itself on start.

## Keeping an eye on it

- `docker compose exec cardboard node src/cli.ts host` shows how the server is doing, with advice.
- `docker compose exec cardboard node src/cli.ts host shake` attacks the running server and reports what held. Everyone can see the latest result on their *Security* page.
- `https://cardboard.yourdomain.com/health` answers `{"ok":true}` (for uptime monitors).

## Without Docker

Node 22.18 or newer, then:

```bash
git clone https://github.com/Gosinn/Cardboard.git /opt/cardboard
CARDBOARD_DATA=/var/lib/cardboard/data node /opt/cardboard/src/cli.ts start \
  --public-url https://cardboard.yourdomain.com --trust-proxy --backup-every 1d
```

[`deploy/cardboard.service`](../deploy/cardboard.service) runs it as a locked-down systemd service. Put Caddy in front (`reverse_proxy 127.0.0.1:8787`, as in [`deploy/Caddyfile`](../deploy/Caddyfile)), or nginx. Only use `--trust-proxy` with exactly one proxy of your own in front.

## What to know before you rely on it

- **Cardboard is 0.x and hasn't had an outside security audit.** The design keeps the host locked out, and the shake test checks that on every start, but keep your own exports of anything you can't lose (`cardboard export`).
- **The dashboard's code comes from your server.** Whoever controls the server could serve a dashboard that steals keys. That's you, so look after the server: keep it updated, use SSH keys, and don't share root.
- **Nobody can reset a lost account**, including you as the host. Make sure everyone saves their recovery kit.
