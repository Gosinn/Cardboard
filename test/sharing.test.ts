import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Account } from "../src/client/account.ts";
import { CardboardError, finishSignIn, open, registerApp, startSignIn, type SignInConfig } from "../src/sdk/index.ts";
import { DAY, startTestServer, tokenOf, type TestServer } from "./helpers.ts";

const rejectsWith = (promise: Promise<unknown>, code: string) =>
  assert.rejects(promise, (err: unknown) => err instanceof CardboardError && err.code === code);

describe("sharing boxes between people", () => {
  let t: TestServer;
  let anna: Account;
  let stranger: Account;
  before(async () => {
    t = await startTestServer({ shake: false });
    await t.me.setProfile({ name: "Gosinn" });
    anna = (await t.newAccount()).account;
    await anna.setProfile({ name: "Anna" });
    stranger = (await t.newAccount()).account;
  });
  after(() => t.stop());

  it("shares a box with one link: the other person joins and both see the same data", async () => {
    const { box: app } = await t.newBox("shopping");
    await app.put("milk", { qty: 2 });
    const { link, code, expiresAt } = await t.me.shareBox("shopping", { label: "Anna" });
    assert.ok(link.endsWith(`/#share=${code}`), "the secret rides in the fragment, which browsers never send");
    assert.ok(expiresAt > Date.now() + 2 * DAY);

    const preview = await anna.viewShare(link);
    assert.deepEqual([preview.name, preview.from, preview.write, preview.own, preview.member], ["shopping", "Gosinn", true, false, false]);

    const joined = await anna.joinShare(link);
    assert.equal(joined.name, "shopping");
    assert.deepEqual(joined.shared && [joined.shared.from, joined.shared.write], ["Gosinn", true]);
    const annaBox = await anna.open("shopping");
    assert.deepEqual(await annaBox.get("milk"), { qty: 2 }, "Anna opens what Gosinn's app stored");
    await annaBox.put("eggs", { qty: 12 });
    assert.deepEqual(await app.get("eggs"), { qty: 12 }, "and Gosinn's app sees what Anna added");

    const mine = await t.me.box("shopping");
    assert.deepEqual(
      mine.people.members.map((m) => [m.name, m.write, m.you]),
      [["Anna", true, false]],
    );
    assert.equal(mine.people.links.length, 0, "the link was used up");
    assert.deepEqual(
      (await anna.box("shopping")).people.members.map((m) => [m.name, m.you]),
      [["Anna", true]],
    );
  });

  it("works once: nobody else can use a link after it's been opened", async () => {
    const { link } = await t.me.shareBox("shopping");
    const third = (await t.newAccount()).account;
    await third.joinShare(link);
    await rejectsWith(stranger.joinShare(link), "no_such_share");
    await rejectsWith(stranger.viewShare(link), "no_such_share");
    await t.me.removeMember("shopping", (await t.me.box("shopping")).people.members.find((m) => m.name === "Someone")!.id);
  });

  it("keeps everyone else out: strangers, and the server itself", async () => {
    const box = await t.me.box("shopping");
    await rejectsWith(stranger.rpc.call("get", { box: box.id, idx: "A".repeat(43) }), "no_such_box");
    await rejectsWith(stranger.rpc.call("share.create", { box: box.id, lookup: "A".repeat(43), envelope: "AAAA" }), "no_such_box");
    await rejectsWith(anna.rpc.call("share.create", { box: box.id, lookup: "A".repeat(43), envelope: "AAAA" }), "no_such_box");
    const { link } = await t.me.shareBox("shopping", { label: "Siggi" });
    const disk = t.cb.api.ctx.db.prepare("SELECT envelope, label FROM shares").all() as Array<{ envelope: Uint8Array; label: Uint8Array }>;
    const raw = Buffer.concat(disk.flatMap((r) => [Buffer.from(r.envelope), Buffer.from(r.label)])).toString("latin1");
    assert.ok(!raw.includes("shopping") && !raw.includes("Siggi") && !raw.includes("Gosinn"), "the box's name and who it's for stay sealed");
    const id = (await t.me.box("shopping")).people.links[0]!.id;
    await t.me.cancelShare(id);
    await rejectsWith(anna.viewShare(link), "no_such_share");
  });

  it("can share read-only", async () => {
    await t.me.createBox("recipes");
    await (await t.me.open("recipes")).put("pancakes", { eggs: 2 });
    const { link } = await t.me.shareBox("recipes", { write: false });
    await anna.joinShare(link);
    const box = await anna.open("recipes");
    assert.deepEqual(await box.get("pancakes"), { eggs: 2 });
    await rejectsWith(box.put("pancakes", { eggs: 0 }), "read_only");
    const { secret, tape } = await anna.createTape("recipes", { label: "anna's app" });
    assert.equal(tape.write, false, "a tape never writes more than its account may");
    await rejectsWith(open({ url: t.cb.url, tape: secret, onNotice: false }).put("x", 1), "read_only");
    await rejectsWith(anna.shredBox("recipes"), "not_your_box");
    await rejectsWith(anna.rewind("recipes", "1h"), "not_your_box");
    await rejectsWith(anna.rpc.call("rewind", { box: (await anna.box("recipes")).id, to: "1h" }), "owner_only");
  });

  it("names people in each other's activity, and keeps each person's own business private", async () => {
    const annaLog = (await anna.log({ box: "shopping" })).map((l) => l.text);
    assert.ok(annaLog.some((l) => l === "You (this device) saved “eggs”"), annaLog.join("\n"));
    assert.ok(annaLog.some((l) => /^Gosinn \(in an app\) saved “milk”$/.test(l)), annaLog.join("\n"));
    assert.ok(!annaLog.some((l) => /tape/.test(l)), "Gosinn's tapes are none of Anna's business");
    const mine = (await t.me.log({ box: "shopping" })).map((l) => l.text);
    assert.ok(mine.includes("Anna saved “eggs”"), mine.join("\n"));
    assert.ok(mine.includes("Anna joined shopping (can change it)"), mine.join("\n"));
    const all = (await anna.log()).map((l) => l.text);
    assert.ok(all.includes("You (this device) saved “eggs”"), "shared boxes show up in your whole log too");
  });

  it("lets a member's own apps use the box, and cuts them off when they're taken off it", async () => {
    const { secret } = await anna.createTape("shopping", { label: "anna's phone" });
    const annaApp = open({ url: t.cb.url, tape: secret, onNotice: false });
    await annaApp.put("bread", { qty: 1 });
    assert.deepEqual(await (await t.me.open("shopping")).get("bread"), { qty: 1 });
    await rejectsWith(annaApp.dock("family").send({ hi: 1 }), "dock_shared_box");
    const fresh = (await t.me.boxes()).find((b) => b.name === "shopping")!;
    const member = fresh.people.members.find((m) => m.name === "Anna")!;
    assert.equal(member.apps, 1, "the owner sees how many apps, not which");
    assert.equal(fresh.tapes.length, 1, "and only their own tapes");

    await t.me.removeMember("shopping", member.id);
    await rejectsWith(annaApp.get("milk"), "bad_tape");
    assert.equal((await t.raw(tokenOf(secret), "get", { idx: "A".repeat(43) })).status, 401);
    assert.ok(!(await anna.boxes()).some((b) => b.name === "shopping"));
    await rejectsWith(anna.rpc.call("list", { box: fresh.id }), "no_such_box");
    const mine = (await t.me.log({ box: "shopping" })).map((l) => l.text);
    assert.ok(mine.includes("You (this device) took Anna off shopping"), mine.join("\n"));
    assert.ok(mine.includes("Anna (in an app) saved “bread”"), "people who left are still named in the log");
  });

  it("lets you leave a box someone shared with you", async () => {
    const { link } = await t.me.shareBox("shopping");
    const box = await anna.joinShare(link);
    await rejectsWith(anna.leaveBox("nonexistent"), "no_such_box");
    await rejectsWith(t.me.leaveBox("shopping"), "own_box");
    await anna.leaveBox(box.name);
    assert.ok(!(await anna.boxes()).some((b) => b.id === box.id));
    assert.ok((await t.me.log({ box: "shopping" })).some((l) => l.text === "Anna left shopping"));
  });

  it("gives you your own name for a shared box, without clashing with yours", async () => {
    await anna.createBox("shopping");
    const { link } = await t.me.shareBox("shopping");
    const joined = await anna.joinShare(link);
    assert.equal(joined.name, "shopping-2");
    await anna.renameBox("shopping-2", "family-shopping");
    assert.ok((await anna.boxes()).some((b) => b.name === "family-shopping" && b.shared));
    assert.equal((await t.me.box("shopping")).name, "shopping", "the owner's name for it is untouched");
  });

  it("expires links", async () => {
    const { link } = await t.me.shareBox("recipes", { expires: "1d" });
    t.clock.advance(2 * DAY);
    await rejectsWith(stranger.viewShare(link), "no_such_share");
  });

  it("signs an app in with a box shared with you, so both of you use the same data", async () => {
    const app = await registerApp(t.cb.url, { name: "Family List", redirectUris: ["http://localhost:5173/callback"] });
    const config: SignInConfig = { issuer: t.cb.url, clientId: app.clientId, redirectUri: "http://localhost:5173/callback", scopes: ["openid", "box"] };
    const pending = await startSignIn(config);
    const res = await fetch(pending.url, { redirect: "manual" });
    const id = res.headers.get("location")!.slice("/?connect=".length);
    const shared = await anna.box("family-shopping");
    const appKey = new URL(pending.url).hash.match(/cardboard_key=([\w-]+)/)?.[1] ?? null;
    const callback = await anna.approveSignIn(id, { appKey, box: shared.id });
    const session = await finishSignIn(config, callback, pending);
    assert.deepEqual(await session.box().get("milk"), { qty: 2 }, "Anna's app opens the family box");
    await session.box().put("apples", { qty: 6 });
    assert.deepEqual(await (await t.me.open("shopping")).get("apples"), { qty: 6 });
    const read = await t.me.shareBox("recipes", { write: false });
    const recipes = await anna.joinShare(read.link, { name: "recipes" }).catch(async () => anna.box("recipes"));
    const second = await startSignIn(config);
    const id2 = (await fetch(second.url, { redirect: "manual" })).headers.get("location")!.slice("/?connect=".length);
    await rejectsWith(anna.approveSignIn(id2, { box: recipes.id }), "read_only");
  });

  it("goes when its owner deletes their account", async () => {
    const { account: owner } = await t.newAccount();
    await owner.createBox("trip");
    const { link } = await owner.shareBox("trip");
    await anna.joinShare(link);
    await owner.deleteAccount();
    assert.ok(!(await anna.boxes()).some((b) => b.name.startsWith("trip")));
  });
});
