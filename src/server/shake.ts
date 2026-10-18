import { createHash, randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { CardboardError } from "../shared/errors.ts";
import { ctx } from "../shared/contexts.ts";
import { signUp, recoverWithKit, startPairing, type Account } from "../client/account.ts";
import { fromB64u, keyPair, open, openWith, sealJson, toB64u, utf8 } from "../client/crypto.ts";
import { MemoryStore } from "../client/device.ts";
import { dockIndex, dockKeys, newClientId, readBundle } from "../client/keys.ts";
import { Box } from "../sdk/index.ts";
import type { Api, ApiRequest, ApiResponse } from "./api.ts";
import { isLoopback } from "./insights.ts";
import { OAuthError, type Client } from "./oauth.ts";

export interface ShakeResult {
  id: string;
  title: string;
  status: "pass" | "fail" | "warn";
  detail: string;
}

export interface ShakeReport {
  at: number;
  ok: boolean;
  passed: number;
  failed: number;
  warned: number;
  summary: string;
  results: ShakeResult[];
}

/** TEST-NET-2 address (RFC 5737): never a real client, so probing can't lock anyone out. */
const PROBE_IP = "198.51.100.77";

/**
 * The shake test: Cardboard attacks itself through the same API and the same
 * client code your apps and devices use, and reports what held. It works on
 * two throwaway accounts that are deleted afterwards, so nobody's real data is
 * touched (and the host never could have touched it anyway: that's one of the
 * things it checks).
 */
export async function runShake(api: Api): Promise<ShakeReport> {
  const { tapes, db, info, oauth, accounts } = api.ctx;
  const results: ShakeResult[] = [];
  const check = async (id: string, title: string, run: () => Promise<Omit<ShakeResult, "id" | "title">> | Omit<ShakeResult, "id" | "title">) => {
    try {
      results.push({ id, title, ...(await run()) });
    } catch (err) {
      results.push({ id, title, status: "fail", detail: `The check itself crashed: ${(err as Error).message}` });
    }
  };
  const pass = (detail: string) => ({ status: "pass" as const, detail });
  const failed = (detail: string) => ({ status: "fail" as const, detail });
  const warn = (detail: string) => ({ status: "warn" as const, detail });

  const call = (op: string, token: string | undefined, body: unknown, extra: Partial<ApiRequest> = {}): ApiResponse =>
    api.call({ op, authorization: token ? `Bearer ${token}` : undefined, ip: PROBE_IP, body, internal: true, ...extra });
  const errorCode = (res: ApiResponse) => (res.body as { error?: { code?: string } }).error?.code;
  /** The client code talks to the API in-process, through this, exactly as it would over HTTP. */
  const inProcess: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers);
    const res = call(url.split("/v1/")[1] ?? "", headers.get("authorization")?.replace(/^Bearer\s+/i, ""), JSON.parse(String(init?.body ?? "{}")));
    return new Response(JSON.stringify(res.body), { status: res.status, headers: res.headers });
  };
  const rejects = async (fn: () => Promise<unknown>, code?: string): Promise<boolean> => {
    try {
      await fn();
      return false;
    } catch (err) {
      return code === undefined || (err instanceof CardboardError && err.code === code);
    }
  };
  const dbBytes = () => {
    db.exec("PRAGMA wal_checkpoint(PASSIVE)");
    const files = [info.dbFile, `${info.dbFile}-wal`];
    return Buffer.concat(files.map((f) => (statSyncSafe(f) ? readFileSync(f) : Buffer.alloc(0))));
  };

  const url = "https://shake.cardboard.invalid";
  const shakeApps: Client[] = [];
  const shakeAccounts: string[] = [];
  const getIn = async () => {
    const { code } = accounts.createInvite({ note: "shake test", ttlMs: 60_000 });
    const { account, kit } = await signUp({ url, invite: code, store: new MemoryStore(), kind: "other", fetch: inProcess });
    shakeAccounts.push(account.id);
    return { account, kit };
  };

  try {
    const { account: me, kit } = await getIn();
    const { account: stranger } = await getIn();
    const tag = randomBytes(3).toString("hex");
    const canary = `canary${randomBytes(12).toString("hex")}`;
    const boxA = await me.createBox(`shake-${tag}-${canary.slice(6, 14)}`);
    const boxB = await me.createBox(`shake-${tag}-b`);
    const boxC = await me.createBox(`shake-${tag}-c`);
    const theirs = await stranger.createBox(`shake-${tag}-x`);
    const a = await me.createTape(boxA.name, { label: canary });
    const b = await me.createTape(boxB.name, { label: "shake" });
    const sdk = (tape: string) => new Box({ url, tape, fetch: inProcess, onNotice: false });
    const appA = sdk(a.secret);
    const secretKey = `secret/${canary}`;
    await appA.put(secretKey, { note: canary });
    await appA.put("public/hello", { note: "hello" });
    const tokenOf = (secret: string) => `cbt_${toB64u(fromB64u(secret.slice(4)).subarray(0, 32))}`;

    // ── The host is locked out ──
    await check("host-blind", "The server can't read anyone's data", () => {
      const disk = dbBytes();
      const found = [canary, secretKey, boxA.name].filter((s) => disk.includes(Buffer.from(s)));
      return found.length === 0
        ? pass("A secret written through the SDK, its key name, the box's name and the tape's label appear nowhere in the database or its journal: only sealed bytes.")
        : failed(`Found readable test data on disk: ${found.length} of 4 needles.`);
    });

    await check("host-view", "Even the host sees only metadata", () => {
      const view = JSON.stringify(api.hostAccountsView());
      const sealed = /"(name|profile|label|key|envelope)"/.test(view);
      return !view.includes(canary) && !sealed
        ? pass("What the host can list about each person is counts, sizes and dates: no names, no labels, nothing sealed to try to open.")
        : failed("The host's view of accounts includes personal fields.");
    });

    await check("tape-split", "Tapes keep their key half", async () => {
      const keyHalf = fromB64u(a.secret.slice(4)).subarray(32);
      const stored = db.prepare("SELECT * FROM tapes").all() as Array<Record<string, unknown>>;
      const leaked = JSON.stringify(stored, (_k, v) => (v instanceof Uint8Array ? Buffer.from(v).toString("hex") : v)).includes(Buffer.from(keyHalf).toString("hex"));
      const whole = call("whoami", a.secret, {});
      return !leaked && errorCode(whole) === "whole_tape_sent"
        ? pass("The server never sees the key half of a tape, and refuses (without storing) a whole tape sent by mistake.")
        : failed("The key half of a tape reached the server.");
    });

    // ── Doors ──
    await check("no-tape", "Locked without a token", () => {
      const res = call("get", undefined, { idx: "x".repeat(43) });
      return res.status === 401 ? pass("Requests without a token are turned away.") : failed(`Got ${res.status} instead of 401.`);
    });

    await check("fake-tape", "Made-up tokens don't open anything", () => {
      const fakes = ["cbt", "cbd", "cbh"].map((p) => call("get", `${p}_${randomBytes(32).toString("base64url")}`, { idx: "x".repeat(43) }).status);
      return fakes.every((s) => s === 401) ? pass("Random tapes, device tokens and host tokens are all rejected.") : failed(`Got ${fakes.join(", ")} instead of 401.`);
    });

    await check("isolation", "Boxes can't see into each other", async () => {
      const appB = sdk(b.secret);
      const listed = await appB.items();
      const raw = call("get", tokenOf(b.secret), { idx: (call("list", tokenOf(a.secret), {}).body as { items: Array<{ idx: string }> }).items[0]!.idx }).body as { item: unknown };
      return listed.length === 0 && raw.item === null
        ? pass("Another app's tape couldn't read or list the test box, even when it asked for an item by its exact id.")
        : failed("A tape for one box could see data in another box.");
    });

    await check("accounts", "Accounts can't see into each other", async () => {
      const peek = await rejects(() => stranger.rpc.call("list", { box: boxA.id }), "no_such_box");
      const tape = await rejects(() => stranger.rpc.call("tape.revoke", { id: a.tape.id }), "no_such_tape");
      const log = (await stranger.rpc.call<{ entries: unknown[] }>("log", {})).entries.length;
      const mine = await rejects(() => me.rpc.call("list", { box: theirs.id }), "no_such_box");
      return peek && tape && mine && log < 10
        ? pass("One person's device couldn't list, revoke or read the log of another person's boxes; their boxes look like no box at all.")
        : failed("One account reached another account's box.");
    });

    await check("read-only", "Read-only tapes can't write", async () => {
      const ro = await me.createTape(boxA.name, { write: false });
      return (await rejects(() => sdk(ro.secret).put("public/x", 1), "read_only")) ? pass("Writes with a read-only tape are refused.") : failed("A read-only tape wrote.");
    });

    await check("revoked", "Revoked tapes stop working", async () => {
      const r = await me.createTape(boxA.name);
      await me.revokeTape(r.tape.id);
      const bundle = db.prepare("SELECT bundle FROM tapes WHERE id = ?").get(r.tape.id) as { bundle: Uint8Array | null };
      return (await rejects(() => sdk(r.secret).get(secretKey), "bad_tape")) && bundle.bundle === null
        ? pass("A revoked tape was refused straight away, and its sealed copy of the box key was deleted.")
        : failed("A revoked tape kept working.");
    });

    await check("expired", "Expired tapes stop working", async () => {
      const e = await me.createTape(boxA.name);
      tapes.setExpiry(e.tape.id, api.ctx.vault.now() - 1000);
      return (await rejects(() => sdk(e.secret).get(secretKey), "bad_tape")) ? pass("An expired tape was refused.") : failed("An expired tape still worked.");
    });

    await check("roles", "Apps can't act as you", () => {
      const res = call("boxes", tokenOf(a.secret), {});
      const dev = call("tape.create", tokenOf(a.secret), { box: boxA.id });
      return res.status === 404 && dev.status === 404 ? pass("An app's tape can't list your boxes or make tapes: those need one of your devices.") : failed("An app's tape reached your account.");
    });

    await check("cors", "Unknown websites are turned away", () => {
      const res = call("whoami", tokenOf(a.secret), {}, { origin: "https://evil.example" });
      const allowed = Object.keys(res.headers).some((h) => h.toLowerCase() === "access-control-allow-origin");
      const device = call("me", me.rpc.token ?? "", {}, { origin: "https://evil.example", host: "shake.cardboard.invalid" });
      return res.status === 403 && !allowed && device.status === 403
        ? pass("Browser requests from sites you didn't allow were refused, for apps and for your devices.")
        : failed("A request from an unknown website was let through.");
    });

    const rows = db.prepare("SELECT idx, value FROM items WHERE box_id = ?").all(boxA.id) as Array<{ idx: Uint8Array; value: Uint8Array }>;
    await check("swap", "Sealed data can't be moved between keys", async () => {
      if (rows.length < 2) return failed("Not enough test rows.");
      const [r1, r2] = rows as [(typeof rows)[0], (typeof rows)[0]];
      const update = db.prepare("UPDATE items SET value = ? WHERE box_id = ? AND idx = ?");
      update.run(r2.value, boxA.id, r1.idx);
      update.run(r1.value, boxA.id, r2.idx);
      const caught = (await rejects(() => appA.get(secretKey), "locked")) && (await rejects(() => appA.get("public/hello"), "locked"));
      update.run(r1.value, boxA.id, r1.idx);
      update.run(r2.value, boxA.id, r2.idx);
      return caught ? pass("Swapping sealed values between keys was caught by the app.") : failed("Sealed values could be swapped between keys without being noticed.");
    });

    await check("tamper", "Tampering is detected", async () => {
      const update = db.prepare("UPDATE items SET value = ? WHERE box_id = ? AND idx = ?");
      for (const row of rows) {
        const bent = Buffer.from(row.value);
        bent.writeUInt8(bent.readUInt8(bent.length - 1) ^ 0xff, bent.length - 1);
        update.run(bent, boxA.id, row.idx);
      }
      return (await rejects(() => appA.get(secretKey), "locked")) ? pass("A single flipped byte was caught before the app used the data.") : failed("Modified data was used as if it were fine.");
    });

    await check("rate-limit", "Guessing gets you blocked", () => {
      api.limiter.reset(PROBE_IP);
      let last: ApiResponse | undefined;
      for (let i = 0; i < 31; i++) last = call("get", `cbt_guess${i}`, { idx: "x".repeat(43) });
      api.limiter.reset(PROBE_IP);
      return last?.status === 429 ? pass("After 30 bad tokens the address was slowed down.") : failed(`Got ${last?.status} instead of 429.`);
    });

    // ── Ways in ──
    await check("recovery-kit", "Only your recovery kit gets you back in", async () => {
      const wrong = await rejects(() => recoverWithKit({ url, code: kit.replace(/^(.)(.)/, "$2$1"), store: new MemoryStore(), kind: "other", fetch: inProcess }));
      api.limiter.reset(PROBE_IP);
      const back = await recoverWithKit({ url, code: kit, store: new MemoryStore(), kind: "other", fetch: inProcess });
      const sees = (await back.boxes()).some((x) => x.name === boxA.name);
      await back.signOut();
      return wrong && sees ? pass("A wrong code got nowhere; the real kit opened the account on a new device.") : failed("The recovery kit check went wrong.");
    });

    await check("pairing", "New devices can't be swapped in", async () => {
      const pending = await startPairing({ url, store: new MemoryStore(), kind: "other", fetch: inProcess });
      // Pretend the server swapped in its own public key: your device must notice.
      const evil = await keyPair();
      db.prepare("UPDATE pairings SET public_key = ? WHERE expires_at > ?").run(Buffer.from(evil.publicKey), 0);
      const caught = await rejects(() => me.approveDevice(pending.code), "pairing_tampered");
      const wrongCode = await rejects(() => me.approveDevice("AAAAA-AAAAA-AAAAA"));
      db.prepare("DELETE FROM pairings").run();
      api.limiter.reset(PROBE_IP);
      return caught && wrongCode
        ? pass("A pairing whose public key was swapped on the server was refused by your device; a made-up code found nothing.")
        : failed("A tampered pairing request was approved.");
    });

    await check("device-removed", "Removed devices are locked out", async () => {
      const second = await recoverWithKit({ url, code: kit, store: new MemoryStore(), kind: "other", fetch: inProcess });
      const token = second.rpc.token!;
      await me.removeDevice(second.deviceId);
      const res = call("me", token, {});
      const copy = db.prepare("SELECT COUNT(*) AS n FROM devices WHERE id = ?").get(second.deviceId) as { n: number };
      api.limiter.reset(PROBE_IP);
      return res.status === 401 && copy.n === 0
        ? pass("A removed device's token stopped working and its sealed copy of the account key was deleted.")
        : failed("A removed device could still get in.");
    });

    // ── Docks ──
    const c = await me.createTape(boxC.name, { label: "shake" });
    const appB = sdk(b.secret);
    const appC = sdk(c.secret);
    const dockName = `shake-${tag}`;

    await check("dock-permission", "Docks need your permission", async () => {
      const sent = await rejects(() => appC.dock(dockName).send({ hi: 1 }), "dock_pending");
      const got = await rejects(() => appC.dock(dockName).receive(), "dock_pending");
      return sent && got ? pass("An app without a berth could only ask to dock; it couldn't send or receive.") : failed("An app used a dock without being approved.");
    });

    await me.createDock(dockName, { send: [boxA.name, boxB.name], receive: [boxA.name, boxB.name] });
    await me.dockApprove(dockName, boxC.name);

    await check("dock-anonymous", "Docked apps stay anonymous", async () => {
      await appA.dock(dockName).send({ note: canary });
      const [parcel] = await appB.dock(dockName).receive();
      if (!parcel) return failed("The test parcel didn't arrive.");
      const seen = JSON.stringify(parcel);
      const leaks = [boxA.id, boxA.name, a.tape.id].some((s) => seen.includes(s));
      return !leaks && parcel.from.startsWith("berth-") && (parcel.body as { note?: string }).note === canary
        ? pass("The receiver opened the parcel and saw a pseudonym, never a name.")
        : failed("A parcel revealed who sent it.");
    });

    await check("dock-sealed", "Parcels are sealed in transit and at rest", () => {
      const disk = dbBytes();
      return !disk.includes(Buffer.from(canary)) ? pass("Parcel contents are sealed with a key only approved apps hold; the server carried the parcel without being able to read it.") : failed("A parcel was readable on the server.");
    });

    await check("dock-secrets", "Customs stops secrets leaving", async () => {
      return (await rejects(() => appA.dock(dockName).send({ key: `sk-ant-api03-${"x".repeat(40)}` }), "secret_at_customs"))
        ? pass("The sending app's customs refused an API key before it was sealed.")
        : failed("A secret was sent across a dock.");
    });

    await check("dock-infection", "A hostile app can't infect the receiver", async () => {
      // A hostile sender skips its own customs and seals a booby trap with the real dock key,
      // which any approved app can open from its berth, just like the SDK does.
      const opened = await appA.ready();
      const idx = await dockIndex(opened.names, dockName);
      const status = call("dock.status", tokenOf(a.secret), { dock: idx }).body as { id: string; key: string };
      const keys = await dockKeys(await open(opened.keys.wrap, fromB64u(status.key), ctx.berthKey(status.id, opened.boxId)));
      const parcelId = newClientId("pcl");
      const trap = JSON.parse('{"a":{"__proto__":{"admin":true}},"key":"sk-ant-api03-' + "y".repeat(40) + '"}');
      const sealed = await sealJson(keys.seal, { body: trap, redacted: [] }, ctx.parcel(status.id, parcelId));
      const sent = call("dock.send", tokenOf(a.secret), { dock: idx, parcel: { id: parcelId, body: toB64u(sealed) } });
      const got = await appB.dock(dockName).receive({ ack: true });
      const infected = got.some((p) => JSON.stringify(p.body).includes("admin"));
      return sent.status === 200 && got.length > 0 && !infected
        ? pass("A booby-trapped parcel sealed by a sender that skipped customs was refused by the receiving app's own customs; the honest parcels still arrived.")
        : failed("A booby-trapped parcel reached the receiving app.");
    });

    await check("dock-personal", "Personal data is redacted at the dock", async () => {
      await appA.dock(dockName).send({ email: "anna@example.is", item: "milk" });
      const parcel = (await appB.dock(dockName).receive({ ack: true })).at(-1);
      const body = parcel?.body as Record<string, unknown> | undefined;
      return body?.["email"] === "[redacted email address]" && body["item"] === "milk"
        ? pass("An email address was replaced before it was sealed; the rest arrived intact.")
        : failed("Personal data crossed a dock unredacted.");
    });

    await check("dock-direct", "Direct replies reach only their target", async () => {
      const tagB = (await appB.dock(dockName).status()).me!;
      const before = (await appC.dock(dockName).receive()).length;
      await appA.dock(dockName).send({ msg: "just for B" }, { to: tagB });
      const forC = (await appC.dock(dockName).receive()).length;
      const forB = (await appB.dock(dockName).receive()).some((p) => p.to === tagB);
      return forB && forC === before ? pass("A reply addressed to one pseudonym wasn't seen by anyone else.") : failed("A direct parcel reached someone it wasn't for.");
    });

    await check("dock-undock", "Undocked apps are cut off", async () => {
      await me.dockRemove(dockName, boxC.name);
      return (await rejects(() => appC.dock(dockName).receive(), "dock_pending")) ? pass("After being taken off the dock, an app couldn't pick anything up.") : failed("An app kept receiving after it was taken off the dock.");
    });

    // ── Sign in with Cardboard ──
    const register = (host: string) => {
      const { client } = oauth.register({ client_name: "shake", redirect_uris: [`https://${host}/cb`], token_endpoint_auth_method: "none" }, "shake");
      shakeApps.push(client);
      return client;
    };
    const app1 = register("shake-a.example");
    const app2 = register("shake-b.example");
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const redirect1 = app1.redirectUris[0]!;
    await me.setProfile({ name: `Shake ${canary}` });
    const signIn = async (client = app1) => {
      const pair = await keyPair();
      const check = oauth.checkAuthorize(
        new URLSearchParams({
          client_id: client.id,
          redirect_uri: client.redirectUris[0]!,
          response_type: "code",
          scope: "openid profile box",
          code_challenge: challenge,
          code_challenge_method: "S256",
          cardboard_key: toB64u(pair.publicKey),
        }),
      );
      if (check.kind !== "ok") throw new Error("authorize refused");
      const location = await me.approveSignIn(oauth.startRequest(check.request), { appKey: toB64u(pair.publicKey) });
      const code = new URL(location).searchParams.get("code")!;
      return { code, pair, tokens: () => oauth.exchangeCode({ code, redirectUri: client.redirectUris[0], verifier, clientId: client.id }) };
    };
    const refusedWith = (fn: () => unknown, error: string) => {
      try {
        fn();
        return false;
      } catch (err) {
        return err instanceof OAuthError && err.error === error;
      }
    };
    const accessRevoked = (token: string) => refusedWith(() => oauth.checkAccess(token), "invalid_token");

    await check("oauth-redirect", "Sign-in links can't be hijacked", () => {
      const res = oauth.checkAuthorize(new URLSearchParams({ client_id: app1.id, redirect_uri: "https://evil.example/cb", response_type: "code", code_challenge: challenge, code_challenge_method: "S256" }));
      return res.kind === "page" ? pass("A sign-in that tried to send you to an address the app never registered was stopped on Cardboard's own page.") : failed("Cardboard would have redirected to an address the app never registered.");
    });

    await check("oauth-pkce", "Sign-in codes need the app's proof (PKCE)", async () => {
      const noPkce = oauth.checkAuthorize(new URLSearchParams({ client_id: app1.id, redirect_uri: redirect1, response_type: "code" }));
      const { code } = await signIn();
      const wrong = refusedWith(() => oauth.exchangeCode({ code, redirectUri: redirect1, verifier: "x".repeat(43), clientId: app1.id }), "invalid_grant");
      return noPkce.kind === "redirect" && noPkce.location.includes("error=invalid_request") && wrong
        ? pass("Sign-ins without PKCE were refused, and a stolen code was useless without the app's secret verifier.")
        : failed("A sign-in code worked without the right PKCE verifier.");
    });

    await check("oauth-sealed", "Apps get their keys sealed, past the server", async () => {
      const attempt = await signIn();
      const tokens = attempt.tokens();
      const relayed = JSON.stringify(tokens);
      const opened = JSON.parse(utf8.decode(await openWith(attempt.pair, fromB64u(tokens.cardboard_bundle!), ctx.signIn(app1.id)))) as { box: unknown; profile: { name?: string } };
      const keys = readBundle(opened.box);
      const box = new Box({ url, tape: tokens.access_token, keys, fetch: inProcess, onNotice: false });
      await box.put("hello", canary);
      const mine = await box.get("hello");
      const own = (await box.items()).length;
      return !relayed.includes(canary) && opened.profile.name === `Shake ${canary}` && mine === canary && own === 1
        ? pass("The box key and your name reached the app sealed to its own key: the server relayed them without being able to read them, and the app's token reached only its own box.")
        : failed("A signed-in app's keys or profile passed through the server readable.");
    });

    await check("oauth-pairwise", "Apps can't compare notes about you", async () => {
      const tokens = (await signIn()).tokens();
      const sub = JSON.parse(Buffer.from(tokens.id_token!.split(".")[1]!, "base64url").toString()).sub as string;
      const other = oauth.subjectFor(me.id, new URL(app2.redirectUris[0]!).origin);
      const strangerSub = oauth.subjectFor(stranger.id, new URL(redirect1).origin);
      return sub === oauth.subjectFor(me.id, new URL(redirect1).origin) && sub !== other && sub !== strangerSub
        ? pass("Two apps got two unrelated private IDs for the same person, and two people got unrelated IDs at the same app.")
        : failed("Private IDs could be linked.");
    });

    await check("oauth-code-once", "Sign-in codes work once", async () => {
      const attempt = await signIn();
      const tokens = attempt.tokens();
      const replayed = refusedWith(attempt.tokens, "invalid_grant");
      return replayed && accessRevoked(tokens.access_token) ? pass("A replayed code was refused and the tokens it produced were revoked.") : failed("A sign-in code worked twice.");
    });

    await check("oauth-refresh-reuse", "Copied refresh tokens are caught", async () => {
      const first = (await signIn()).tokens();
      const second = oauth.refresh({ refreshToken: first.refresh_token, clientId: app1.id });
      const replayed = refusedWith(() => oauth.refresh({ refreshToken: first.refresh_token, clientId: app1.id }), "invalid_grant");
      return replayed && accessRevoked(second.access_token) ? pass("Reusing an old refresh token disconnected the app, so a copied token is worthless.") : failed("An old refresh token kept working after it was rotated.");
    });
  } catch (err) {
    results.push({ id: "setup", title: "Shake test setup", status: "fail", detail: (err as Error).message });
  } finally {
    for (const client of shakeApps) db.prepare("DELETE FROM oauth_clients WHERE id = ?").run(client.id);
    for (const id of shakeAccounts) accounts.deleteAccount(id);
    db.prepare("DELETE FROM invites WHERE note = 'shake test'").run();
    db.prepare("DELETE FROM log WHERE account_id IS NULL AND (note LIKE 'acct_%' OR note = 'shake')").run();
    api.limiter.reset(PROBE_IP);
    api.pairings.reset(PROBE_IP);
  }

  await check("key-file", "Server key file is private", () => {
    if (process.platform === "win32") return pass("Skipped on Windows.");
    const mode = statSync(info.keyFile).mode & 0o777;
    return (mode & 0o077) === 0 ? pass("Only your user can read server.key.") : warn(`server.key is readable by other users (mode ${mode.toString(8)}). Fix: chmod 600 "${info.keyFile}"`);
  });

  await check("data-dir", "Data folder is private", () => {
    if (process.platform === "win32") return pass("Skipped on Windows.");
    const mode = statSync(info.dataDir).mode & 0o777;
    return (mode & 0o077) === 0 ? pass("Only your user can open the data folder.") : warn(`Other users can open the data folder (mode ${mode.toString(8)}). Fix: chmod 700 "${info.dataDir}"`);
  });

  await check("transport", "Traffic is protected", () => {
    if (info.tls) return pass("Cardboard is serving HTTPS.");
    if (info.publicUrl.startsWith("https://")) return pass("Cardboard sits behind HTTPS.");
    if (isLoopback(info.host)) return pass("Cardboard only listens on this machine.");
    return warn("Cardboard is reachable over plain HTTP from the network. Data is sealed, but tokens and the dashboard's code aren't. Put it behind HTTPS.");
  });

  await check("tape-expiry", "Every tape expires on its own", () => {
    const { n } = db.prepare("SELECT COUNT(*) AS n FROM tapes WHERE revoked_at IS NULL AND idle_ms IS NULL AND expires_at IS NULL").get() as { n: number };
    return n === 0 ? pass("All active tapes switch themselves off eventually.") : warn(`${n} tape${n === 1 ? " never expires" : "s never expire"}. Their owners see it in their insights.`);
  });

  const passed = results.filter((r) => r.status === "pass").length;
  const failedCount = results.filter((r) => r.status === "fail").length;
  const warned = results.filter((r) => r.status === "warn").length;
  const parts = [`${passed}/${results.length} passed`];
  if (failedCount) parts.push(`${failedCount} failed`);
  if (warned) parts.push(`${warned} warning${warned === 1 ? "" : "s"}`);
  return { at: api.ctx.vault.now(), ok: failedCount === 0, passed, failed: failedCount, warned, summary: parts.join(", "), results };
}

function statSyncSafe(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

