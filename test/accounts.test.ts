import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { joinDevice, recoverWithFriends, recoverWithKit, signUp, startPairing, unlock } from "../src/client/account.ts";
import { keyPair, open, random, toB64u } from "../src/client/crypto.ts";
import { ctx } from "../src/shared/contexts.ts";
import { MemoryStore } from "../src/client/device.ts";
import { CardboardError } from "../src/sdk/index.ts";
import { startTestServer, type TestServer } from "./helpers.ts";

const rejectsWith = (promise: Promise<unknown>, code: string) =>
  assert.rejects(promise, (err: unknown) => err instanceof CardboardError && err.code === code);

describe("accounts, devices and recovery", () => {
  let t: TestServer;
  const device = () => ({ url: t.cb.url, store: new MemoryStore(), kind: "cli" as const });
  before(async () => {
    t = await startTestServer({ shake: false });
  });
  after(() => t.stop());

  it("needs an invite, which works exactly once", async () => {
    await rejectsWith(signUp({ ...device() }), "invite_required");
    await rejectsWith(signUp({ ...device(), invite: `cbi_${"x".repeat(43)}` }), "invite_required");
    const { body } = await t.host("host.invite", { note: "for Siggi" });
    assert.match(body.link, /#invite=cbi_/);
    const { account, kit } = await signUp({ ...device(), invite: body.link });
    assert.match(kit, /^[0-9A-Z]{4}(-[0-9A-Z]{1,4}){6}$/);
    assert.ok(account.id.startsWith("acct_"));
    await rejectsWith(signUp({ ...device(), invite: body.code }), "invite_used");
    const invites = (await t.host("host.invites")).body.invites;
    assert.ok(invites.some((i: any) => i.note === "for Siggi" && i.usedAt));
  });

  it("expires invites", async () => {
    const { body } = await t.host("host.invite", { ttl: "1h" });
    t.clock.advance(2 * 60 * 60 * 1000);
    await rejectsWith(signUp({ ...device(), invite: body.code }), "invite_expired");
  });

  it("opens again on the same device, and only there", async () => {
    const store = new MemoryStore();
    const { account } = await signUp({ ...device(), store, invite: (await t.host("host.invite")).body.code, label: "Laptop" });
    await account.createBox("hello");
    const again = await unlock(store);
    assert.equal(again!.id, account.id);
    assert.deepEqual((await again!.boxes()).map((b) => b.name), ["hello"]);
    const me = await again!.me();
    assert.equal(me.devices[0]!.name, "Laptop");
    assert.equal(me.recovery, "kit");
    assert.ok(me.recoveryReady);
    assert.equal(await unlock(new MemoryStore()), null, "a device that never signed in has nothing to open");
  });

  it("pairs a new device from one you have, without the server ever holding the code", async () => {
    const pending = await startPairing({ ...device(), label: "Phone" });
    assert.match(pending.code, /^[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}$/);
    const [phone] = await Promise.all([pending.wait({ everyMs: 50 }), t.me.approveDevice(pending.code, "Phone")]);
    assert.equal(phone.id, t.me.id);
    await phone.createBox("from-phone");
    assert.ok((await t.me.boxes()).some((b) => b.name === "from-phone"), "both devices see the same account");
    const names = (await t.me.me()).devices.map((d) => d.name);
    assert.ok(names.includes("Phone"));
    const pairings = t.cb.api.ctx.db.prepare("SELECT COUNT(*) AS n FROM pairings").get() as { n: number };
    assert.equal(pairings.n, 0, "the pairing is gone once used");
  });

  it("refuses a pairing whose key was swapped, or a wrong code", async () => {
    const pending = await startPairing(device());
    const evil = await keyPair();
    t.cb.api.ctx.db.prepare("UPDATE pairings SET public_key = ?").run(Buffer.from(evil.publicKey));
    await rejectsWith(t.me.approveDevice(pending.code), "pairing_tampered");
    await rejectsWith(t.me.approveDevice("00000-00000-00000"), "bad_code");
    t.cb.api.limiter.reset("127.0.0.1");
    t.clock.advance(11 * 60 * 1000);
    await rejectsWith(t.me.approveDevice(pending.code), "no_such_pairing");
    t.cb.api.limiter.reset("127.0.0.1");
  });

  it("adds a device when the numbers on both match, with nothing to type", async () => {
    const offering = t.me.offerDevice({ everyMs: 50 });
    const joining = await joinDevice({ ...device(), label: "Tablet", everyMs: 50 });
    const offer = await offering;
    assert.match(joining.number, /^\d{3} \d{3}$/);
    assert.equal(offer.number, joining.number, "both devices show the same number");
    assert.equal(offer.kind, "cli");
    const [tablet] = await Promise.all([joining.wait({ everyMs: 50 }), offer.approve("Tablet")]);
    assert.equal(tablet.id, t.me.id);
    await tablet.createBox("from-tablet");
    assert.ok((await t.me.boxes()).some((b) => b.name === "from-tablet"));
    assert.ok((await t.me.me()).devices.some((d) => d.name === "Tablet"));
    const left = t.cb.api.ctx.db.prepare("SELECT COUNT(*) AS n FROM pair_offers").get() as { n: number };
    assert.equal(left.n, 0, "the offer is gone once used");
  });

  it("catches a key swapped by the server, and lets only the first device answer", async () => {
    // The device you have waits longer between looks, so the swap lands before it reads the key.
    const offering = t.me.offerDevice({ everyMs: 400 });
    const joining = await joinDevice({ ...device(), everyMs: 50 });
    assert.ok(joining.number);
    const evil = await keyPair();
    t.cb.api.ctx.db.prepare("UPDATE pair_offers SET public_key = ?").run(Buffer.from(evil.publicKey));
    await rejectsWith(offering, "pairing_tampered");
    assert.equal((t.cb.api.ctx.db.prepare("SELECT COUNT(*) AS n FROM pair_offers").get() as { n: number }).n, 0, "a refused offer is closed");

    const second = t.me.offerDevice({ everyMs: 50 });
    const first = await joinDevice({ ...device(), everyMs: 50 });
    const id = (t.cb.api.ctx.db.prepare("SELECT id FROM pair_offers").get() as { id: Uint8Array }).id;
    const late = await fetch(`${t.cb.url}/v1/pair.join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ offer: toB64u(id), commitment: toB64u(random(32)), tokenHash: toB64u(random(32)), kind: "other" }),
    });
    assert.equal(((await late.json()) as { error: { code: string } }).error.code, "offer_taken");
    const offer = await second;
    assert.equal(offer.number, first.number);
    await offer.cancel();
    await rejectsWith(first.wait({ everyMs: 50 }), "no_such_offer");
    t.cb.api.limiter.reset("127.0.0.1");
  });

  it("closes an offer nobody answered after 5 minutes", async () => {
    const controller = new AbortController();
    const offering = t.me.offerDevice({ everyMs: 50, signal: controller.signal });
    await new Promise((r) => setTimeout(r, 100));
    const id = (t.cb.api.ctx.db.prepare("SELECT id FROM pair_offers").get() as { id: Uint8Array }).id;
    t.clock.advance(6 * 60 * 1000);
    await rejectsWith(offering, "no_such_offer");
    const res = await fetch(`${t.cb.url}/v1/pair.join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ offer: toB64u(id), commitment: toB64u(random(32)), tokenHash: toB64u(random(32)), kind: "other" }),
    });
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, "no_such_offer");
    await rejectsWith(joinDevice({ ...device(), everyMs: 10, lookForMs: 30 }), "no_such_offer");
    t.cb.api.limiter.reset("127.0.0.1");
    t.cb.api.pairings.reset("127.0.0.1");
  });

  it("gets you back in with your recovery kit, and a new kit retires the old one", async () => {
    const { account, kit } = await signUp({ ...device(), invite: (await t.host("host.invite")).body.code });
    const box = await account.createBox("precious");
    const opened = await account.open(box);
    await opened.put("x", "still here");

    const back = await recoverWithKit({ ...device(), code: kit.toLowerCase().replace(/-/g, " ") });
    assert.equal(await (await back.open("precious")).get("x"), "still here");
    assert.ok((await back.me()).alarms.some((a) => /recovery kit was used/.test(a.text)), "you hear about it");
    assert.ok((await back.insights()).some((i) => i.level === "danger" && /recovery kit was used/.test(i.title)));

    const fresh = await account.setRecovery("kit");
    await rejectsWith(recoverWithKit({ ...device(), code: kit }), "bad_recovery");
    t.cb.api.limiter.reset("127.0.0.1");
    const again = await recoverWithKit({ ...device(), code: fresh.kit! });
    assert.equal(again.id, account.id);
    await rejectsWith(recoverWithKit({ ...device(), code: fresh.kit!.replace(/^./, (c) => (c === "A" ? "B" : "A")) }), "bad_code");
  });

  it("splits recovery between trusted friends: any 2 of 3", async () => {
    const { account } = await signUp({ ...device(), invite: (await t.host("host.invite")).body.code });
    const { pieces, threshold } = await account.setRecovery("friends");
    assert.equal(pieces!.length, 3);
    assert.equal(threshold, 2);
    assert.equal((await account.me()).recovery, "friends");
    const back = await recoverWithFriends({ ...device(), pieces: [pieces![2]!, pieces![0]!] });
    assert.equal(back.id, account.id);
    await assert.rejects(recoverWithFriends({ ...device(), pieces: [pieces![1]!] }), /don't fit together/);
    const custom = await account.setRecovery("friends", { count: 5, threshold: 3 });
    assert.equal(custom.pieces!.length, 5);
    await rejectsWith(recoverWithFriends({ ...device(), pieces: custom.pieces!.slice(0, 2) }), "bad_recovery");
    t.cb.api.limiter.reset("127.0.0.1");
    assert.equal((await recoverWithFriends({ ...device(), pieces: custom.pieces!.slice(2) })).id, account.id);
  });

  it("other plans keep no copy at all, and say what that means", async () => {
    const { account, kit } = await signUp({ ...device(), invite: (await t.host("host.invite")).body.code });
    await account.setRecovery("device");
    await rejectsWith(recoverWithKit({ ...device(), code: kit }), "bad_recovery");
    t.cb.api.limiter.reset("127.0.0.1");
    const copies = t.cb.api.ctx.db.prepare("SELECT COUNT(*) AS n FROM recovery WHERE account_id = ?").get(account.id) as { n: number };
    assert.equal(copies.n, 0);
    assert.ok((await account.insights()).some((i) => /needs a second device/.test(i.title)));
    await account.setRecovery("none");
    assert.ok((await account.insights()).some((i) => /no recovery/.test(i.title)));
  });

  it("locks a removed device out for good", async () => {
    const pending = await startPairing(device());
    const [second] = await Promise.all([pending.wait({ everyMs: 50 }), t.me.approveDevice(pending.code)]);
    const token = second.rpc.token!;
    await t.me.removeDevice(second.deviceId);
    const res = await t.raw(token, "me", {});
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, "bad_device");
  });

  it("keeps your profile sealed, and deletes everything when you leave", async () => {
    const store = new MemoryStore();
    const { account } = await signUp({ ...device(), store, invite: (await t.host("host.invite")).body.code });
    await account.setProfile({ name: "Anna", email: "anna@example.is" });
    assert.deepEqual((await account.me()).profile, { name: "Anna", email: "anna@example.is" });
    await rejectsWith(account.setProfile({ email: "not-an-email" }), "bad_profile");
    await account.createBox("bye");
    await account.deleteAccount();
    assert.equal(await store.load(), null);
    const left = t.cb.api.ctx.db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE id = ?").get(account.id) as { n: number };
    assert.equal(left.n, 0);
  });

  it("locks a device with a passkey: without Face ID, holding the device gets you nothing", async () => {
    const store = new MemoryStore();
    const { account } = await signUp({ ...device(), store, invite: (await t.host("host.invite")).body.code, label: "Phone" });
    await account.createBox("diary");
    const before = (await store.load())!;
    const passkey = { credential: toB64u(random(16)), salt: toB64u(random(32)), secret: random(32) };
    await account.lockWithPasskey(passkey, { idleMs: 5 * 60 * 1000 });

    const locked = (await store.load())!;
    assert.equal(locked.token, null, "the token isn't kept unsealed any more");
    assert.equal(locked.lock?.kind, "passkey");
    assert.equal(locked.lock?.idleMs, 5 * 60 * 1000);
    assert.equal((await t.raw(before.token, "me")).status, 401, "the old, unsealed token stopped working");
    assert.equal((await account.me()).device.lock, "passkey", "this session carries on with the new token");

    await rejectsWith(unlock(store), "device_locked");
    await rejectsWith(unlock(store, { passkey: async () => random(32) }), "wrong_passkey");
    const again = await unlock(store, { passkey: async (lock) => (assert.equal(lock.credential, passkey.credential), passkey.secret) });
    assert.deepEqual((await again!.boxes()).map((b) => b.name), ["diary"]);
    assert.equal(again!.lock?.kind, "passkey");

    // The server's copy needs both this device's key and the passkey: the device key alone opens nothing.
    const envelope = new Uint8Array(t.cb.api.ctx.accounts.device(account.deviceId)!.envelope!);
    await assert.rejects(open(locked.key, envelope, ctx.accountKey("device")));
    const inner = await open(locked.key, envelope, ctx.lockedEnvelope);
    await assert.rejects(open(random(32), inner, ctx.accountKey("passkey")));

    const lines = await again!.log({ limit: 5 });
    assert.ok(lines.some((l) => /locked “Phone” with Face ID/.test(l.text)), lines.map((l) => l.text).join("\n"));
    const tips = await again!.insights();
    assert.ok(!tips.some((i) => /Lock this browser/.test(i.title)));

    await again!.removeLock();
    assert.equal((await store.load())!.lock, null);
    const plain = await unlock(store);
    assert.deepEqual((await plain!.boxes()).map((b) => b.name), ["diary"]);
    assert.equal((await plain!.me()).device.lock, null);
    await assert.rejects(account.me(), "the session from before the unlock uses a retired token");
  });

  it("refuses a lock without a new token", async () => {
    const res = await t.raw(t.me.rpc.token!, "device.envelope", { envelope: toB64u(random(60)), lock: "passkey" });
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /tokenHash/);
  });

  it("finds boxes and docks the way people type them, and says what name would work", async () => {
    await t.me.createBox("lore-world");
    assert.equal((await t.me.box("LORE World")).name, "lore-world");
    await t.me.createDock("story-bits");
    await t.me.dockSettings("Story Bits", { ttl: "1d" });
    await assert.rejects(t.me.createBox("LORE"), (err: unknown) => err instanceof CardboardError && err.code === "bad_box_name" && /try lore/.test(err.hint ?? ""));
  });

  it("slows down people guessing recovery codes and pairing ids", async () => {
    t.cb.api.limiter.reset("127.0.0.1");
    let last = 0;
    for (let i = 0; i < 31; i++) {
      last = (await t.raw(null, "recover", { kind: "kit", secret: toB64u(new Uint8Array(32).fill(i)), device: { tokenHash: toB64u(new Uint8Array(32).fill(i)), kind: "cli" } })).status;
    }
    assert.equal(last, 429);
    t.cb.api.limiter.reset("127.0.0.1");
  });
});

describe("open sign-up", () => {
  it("lets anyone in when the host says so", async () => {
    const t = await startTestServer({ shake: false, openSignup: true });
    try {
      const { account } = await signUp({ url: t.cb.url, store: new MemoryStore(), kind: "cli" });
      assert.ok(account.id);
      assert.equal(t.cb.firstInvite, undefined);
      assert.ok((await t.host("host.overview")).body.insights.some((i: any) => /Anyone who finds/.test(i.title)));
    } finally {
      await t.stop();
    }
  });
});

describe("the first invite", () => {
  it("is fresh on every start until someone has made an account, so stopping early can't lock you out", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { startServer } = await import("../src/server/index.ts");
    const dir = mkdtempSync(join(tmpdir(), "cardboard-first-"));
    const start = () => startServer({ dataDir: join(dir, "data"), port: 0, shake: false });
    try {
      const first = await start();
      const old = first.firstInvite!;
      await first.close();
      const second = await start();
      assert.ok(second.firstInvite && second.firstInvite !== old);
      await rejectsWith(signUp({ url: second.url, invite: old, store: new MemoryStore(), kind: "cli" }), "invite_required");
      await signUp({ url: second.url, invite: second.firstInvite, store: new MemoryStore(), kind: "cli" });
      await second.close();
      const third = await start();
      assert.equal(third.firstInvite, undefined, "once there's an account, invites come from the host or from people here");
      await third.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
