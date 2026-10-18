import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { CardboardError, finishSignIn, registerApp, resumeSession, startSignIn, type SignInConfig } from "../src/sdk/index.ts";
import { HOUR, startTestServer, type TestServer } from "./helpers.ts";

describe("Sign in with Cardboard", () => {
  let t: TestServer;
  let config: SignInConfig;

  /** Follows /oauth/authorize to the dashboard's #connect page. */
  async function requestId(url: string): Promise<{ id: string | null; status: number; location: string | null; html: string }> {
    const res = await fetch(url, { redirect: "manual" });
    const location = res.headers.get("location");
    return { id: location?.startsWith("/?connect=") ? location.slice("/?connect=".length) : null, status: res.status, location, html: await res.text() };
  }

  /** The whole dance: the app starts, your dashboard (here: your device) says yes or no, the app finishes. */
  async function signIn(cfg: SignInConfig, decision: "allow" | "deny" = "allow", extra: (url: string) => string = (u) => u) {
    const pending = await startSignIn(cfg);
    const { id } = await requestId(extra(pending.url));
    assert.ok(id, "authorize hands the browser to the dashboard");
    const request = await t.me.signInRequest(id);
    // What the browser keeps from the app's URL: the fragment, which the server never saw.
    const appKey = new URL(pending.url).hash.match(/cardboard_key=([\w-]+)/)?.[1] ?? null;
    const callback = decision === "allow" ? await t.me.approveSignIn(id, { appKey }) : await t.me.denySignIn(id);
    return { pending, callback, request };
  }

  before(async () => {
    t = await startTestServer({ shake: false });
    await t.me.setProfile({ name: "Gosinn", email: "gosinn@example.is" });
    const app = await registerApp(t.cb.url, { name: "Recipe Planner", redirectUris: ["http://localhost:5173/callback"] });
    config = { issuer: t.cb.url, clientId: app.clientId, redirectUri: "http://localhost:5173/callback", scopes: ["openid", "profile", "email", "box"] };
  });
  after(() => t.stop());

  it("publishes standard discovery so any OpenID Connect library can connect", async () => {
    const doc = (await (await fetch(`${t.cb.url}/.well-known/openid-configuration`)).json()) as Record<string, unknown>;
    assert.equal(doc["issuer"], t.cb.url);
    assert.deepEqual(doc["code_challenge_methods_supported"], ["S256"]);
    assert.deepEqual(doc["subject_types_supported"], ["pairwise"]);
    assert.equal(doc["registration_endpoint"], `${t.cb.url}/oauth/register`);
  });

  it("signs a person in and gives the app a box in THEIR Cardboard, with its key sealed past the server", async () => {
    const { pending, callback, request } = await signIn(config);
    assert.deepEqual(request.scopes, ["openid", "profile", "email", "box"]);
    assert.ok(request.appKey, "the SDK sent its own public key");
    assert.match(callback, /^http:\/\/localhost:5173\/callback\?code=/);
    const session = await finishSignIn(config, callback, pending);
    assert.match(session.user.id, /^[A-Za-z0-9_-]{27}$/);
    assert.equal(session.user.name, "Gosinn", "your name arrived sealed to the app");
    assert.equal(session.user.email, "gosinn@example.is");

    await session.box().put("prefs", { theme: "dark" });
    const box = (await t.me.boxes()).find((b) => b.name === "recipe-planner")!;
    assert.equal(box.profile.title, "Recipe Planner");
    assert.equal(box.items, 1);
    assert.deepEqual(await (await t.me.open(box)).get("prefs"), { theme: "dark" }, "you can open what the app stored");

    const apps = await t.me.apps();
    assert.equal(apps.connected[0]!.name, "Recipe Planner");
    assert.equal(apps.connected[0]!.boxName, "recipe-planner");
    assert.equal(apps.connected[0]!.privateId, session.user.id);

    const userinfo = await (await fetch(`${t.cb.url}/oauth/userinfo`, { headers: { authorization: `Bearer ${session.accessToken}` } })).json();
    assert.deepEqual(userinfo, { sub: session.user.id }, "the server itself never had your name to give out");
  });

  it("relays only sealed bytes: nothing readable passes through the token endpoint", async () => {
    const pending = await startSignIn(config);
    const { id } = await requestId(pending.url);
    const callback = await t.me.approveSignIn(id!);
    const res = await fetch(`${t.cb.url}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: new URL(callback).searchParams.get("code")!, redirect_uri: config.redirectUri, client_id: config.clientId, code_verifier: pending.verifier }).toString(),
    });
    const text = await res.text();
    assert.ok(text.includes("cardboard_bundle"));
    assert.ok(!text.includes("Gosinn") && !text.includes("gosinn@example.is"));
  });

  it("signs ID tokens that verify against the published keys", async () => {
    const pending = await startSignIn(config);
    const { id } = await requestId(pending.url);
    const callback = await t.me.approveSignIn(id!);
    const res = await fetch(`${t.cb.url}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: new URL(callback).searchParams.get("code")!, redirect_uri: config.redirectUri, client_id: config.clientId, code_verifier: pending.verifier }).toString(),
    });
    const tokens = (await res.json()) as { id_token: string };
    const [header, payload, signature] = tokens.id_token.split(".") as [string, string, string];
    const { keys } = (await (await fetch(`${t.cb.url}/oauth/jwks`)).json()) as { keys: Array<Record<string, string>> };
    const kid = JSON.parse(Buffer.from(header, "base64url").toString()).kid;
    const jwk = keys.find((k) => k["kid"] === kid)!;
    const ok = verify("sha256", Buffer.from(`${header}.${payload}`), { key: createPublicKey({ key: jwk, format: "jwk" }), dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url"));
    assert.ok(ok, "ES256 signature verifies");
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    assert.equal(claims.iss, t.cb.url);
    assert.equal(claims.aud, config.clientId);
    assert.equal(claims.nonce, pending.nonce);
    assert.equal(claims.name, undefined, "names never go into server-signed tokens for apps that take sealed data");
  });

  it("remembers: the same private ID and the same box next time, and after a restart of the app", async () => {
    const first = await signIn(config);
    const a = await finishSignIn(config, first.callback, first.pending);
    const second = await signIn(config);
    assert.ok(second.request.returning, "your dashboard knows you said yes before");
    const b = await finishSignIn(config, second.callback, second.pending);
    assert.equal(a.user.id, b.user.id);
    assert.deepEqual(await b.box().get("prefs"), { theme: "dark" }, "same box, same data");
    const resumed = await resumeSession(config, b.save());
    assert.deepEqual(await resumed.box().get("prefs"), { theme: "dark" });
    assert.equal(resumed.user.name, "Gosinn");
  });

  it("gives every app (and every person) a different private ID", async () => {
    const other = await registerApp(t.cb.url, { name: "Fitness", redirectUris: ["http://127.0.0.1:4000/cb"] });
    const otherConfig: SignInConfig = { issuer: t.cb.url, clientId: other.clientId, redirectUri: "http://127.0.0.1:4000/cb", scopes: ["openid"] };
    const a = await signIn(config);
    const b = await signIn(otherConfig);
    const sa = await finishSignIn(config, a.callback, a.pending);
    const sb = await finishSignIn(otherConfig, b.callback, b.pending);
    assert.notEqual(sa.user.id, sb.user.id);
    assert.equal(sb.user.name, undefined, "only what was asked for");
    assert.throws(() => sb.box(), /didn't get a box/);
  });

  it("refreshes tokens by itself, and disconnects an app whose refresh token gets copied", async () => {
    const { pending, callback } = await signIn(config);
    const session = await finishSignIn(config, callback, pending);
    const box = session.box();
    t.clock.advance(2 * HOUR);
    assert.deepEqual(await box.get("prefs"), { theme: "dark" }, "the SDK refreshed on its own");
    const stolen = session.refreshToken;
    await session.refresh();
    const replay = await fetch(`${t.cb.url}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: stolen, client_id: config.clientId }).toString(),
    });
    assert.equal(replay.status, 400);
    assert.equal(((await replay.json()) as { error: string }).error, "invalid_grant");
    await assert.rejects(session.box().get("prefs"), (err: unknown) => err instanceof CardboardError);
    const log = (await t.me.log()).map((e) => e.text);
    assert.ok(log.some((l) => l.startsWith("Security: A refresh token for Recipe Planner was used twice")), log.join("\n"));
  });

  it("refuses codes without the PKCE secret, and codes used twice", async () => {
    const { pending, callback } = await signIn(config);
    await assert.rejects(finishSignIn(config, callback, { ...pending, verifier: "x".repeat(43) }), (err: unknown) => err instanceof CardboardError && err.code === "invalid_grant");
    const again = await signIn(config);
    const ok = await finishSignIn(config, again.callback, again.pending);
    await assert.rejects(finishSignIn(config, again.callback, again.pending), (err: unknown) => err instanceof CardboardError && err.code === "invalid_grant");
    await assert.rejects(ok.box().get("prefs"), "tokens from a replayed code are revoked");
  });

  it("catches a server that swaps in its own key to read the box key", async () => {
    const pending = await startSignIn(config);
    const { id } = await requestId(pending.url);
    const appKey = new URL(pending.url).hash.match(/cardboard_key=([\w-]+)/)![1]!;
    const parked = (t.cb.api.ctx.oauth as unknown as { requests: Map<string, { request: { appKey: Buffer } }> }).requests.get(id!)!;
    const evil = Buffer.from(parked.request.appKey);
    evil[evil.length - 1]! ^= 1;
    parked.request.appKey = evil;
    await assert.rejects(t.me.approveSignIn(id!, { appKey }), (err: unknown) => err instanceof CardboardError && err.code === "app_key_swapped");
  });

  it("never redirects anywhere the app didn't register", async () => {
    const pending = await startSignIn({ ...config, redirectUri: "https://evil.example/steal" });
    const page = await requestId(pending.url);
    assert.equal(page.status, 400);
    assert.equal(page.location, null);
    assert.match(page.html, /never registered/);
  });

  it("only hands out a box to apps that can take its key sealed", async () => {
    const pending = await startSignIn(config);
    const url = new URL(pending.url);
    url.searchParams.delete("cardboard_key");
    const page = await requestId(url.toString());
    assert.equal(page.status, 302);
    assert.match(page.location ?? "", /error=invalid_scope/);
  });

  it("works for plain OpenID Connect apps too, passing your name only if you say so", async () => {
    const plain = await registerApp(t.cb.url, { name: "Old School", redirectUris: ["https://old.example/cb"] });
    const cfg: SignInConfig = { issuer: t.cb.url, clientId: plain.clientId, redirectUri: "https://old.example/cb", scopes: ["openid", "profile"] };
    const withoutKey = (u: string) => {
      const url = new URL(u);
      url.searchParams.delete("cardboard_key");
      return url.toString();
    };
    const first = await startSignIn(cfg);
    const { id } = await requestId(withoutKey(first.url));
    assert.equal((await t.me.signInRequest(id!)).appKey, null);
    const callback = await t.me.approveSignIn(id!);
    const s1 = await finishSignIn(cfg, callback, first);
    assert.equal(s1.user.name, undefined, "nothing passed unless you tick the box");
    const second = await startSignIn(cfg);
    const next = await requestId(withoutKey(second.url));
    const s2 = await finishSignIn(cfg, await t.me.approveSignIn(next.id!, { claims: { name: "Gosinn" } }), second);
    assert.equal(s2.user.name, "Gosinn");
  });

  it("lets you say no, and tells apps when this browser isn't signed in", async () => {
    const shy = await registerApp(t.cb.url, { name: "Nosy App", redirectUris: ["https://nosy.example/cb"] });
    const shyConfig: SignInConfig = { issuer: t.cb.url, clientId: shy.clientId, redirectUri: "https://nosy.example/cb" };
    const { pending, callback } = await signIn(shyConfig, "deny");
    await assert.rejects(finishSignIn(shyConfig, callback, pending), (err: unknown) => err instanceof CardboardError && err.code === "access_denied");
    const silent = await startSignIn(shyConfig);
    const { id } = await requestId(`${silent.url}&prompt=none`);
    const cancelled = await t.raw(null, "oauth.cancel", { id, error: "login_required" });
    assert.match(cancelled.body.redirect, /error=login_required/);
  });

  it("disconnects an app and shreds what it kept about you", async () => {
    const { pending, callback } = await signIn(config);
    const session = await finishSignIn(config, callback, pending);
    const grant = (await t.me.apps()).connected.find((a) => a.name === "Recipe Planner")!.grant;
    const res = await t.me.disconnectApp(grant, { shred: true });
    assert.ok(res.shredded);
    await assert.rejects(session.box().get("prefs"));
    assert.ok(!(await t.me.boxes()).some((b) => b.name === "recipe-planner"));
    const userinfo = await fetch(`${t.cb.url}/oauth/userinfo`, { headers: { authorization: `Bearer ${session.accessToken}` } });
    assert.equal(userinfo.status, 401);
  });
});
