import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { CardboardError, finishSignIn, registerApp, startSignIn, type SignInConfig } from "../src/sdk/index.ts";
import { HOUR, startTestServer, type TestServer } from "./helpers.ts";

/** Just enough of a browser: keeps cookies, doesn't follow redirects, sends Origin on posts. */
class Browser {
  private readonly cookies = new Map<string, string>();
  private readonly origin: string;
  constructor(origin: string) {
    this.origin = origin;
  }

  private remember(res: Response) {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const [name, ...value] = pair!.split("=");
      this.cookies.set(name!, value.join("="));
    }
  }

  private cookieHeader() {
    return [...this.cookies].filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join("; ");
  }

  async get(url: string) {
    const res = await fetch(url, { redirect: "manual", headers: { cookie: this.cookieHeader() } });
    this.remember(res);
    return { status: res.status, location: res.headers.get("location"), html: await res.text() };
  }

  async post(url: string, form: Record<string, string>, origin = this.origin) {
    const res = await fetch(url, {
      method: "POST",
      redirect: "manual",
      headers: { cookie: this.cookieHeader(), origin, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
    });
    this.remember(res);
    return { status: res.status, location: res.headers.get("location"), html: await res.text() };
  }
}

function hiddenFields(html: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const m of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)" \/>/g)) {
    fields[m[1]!] = m[2]!.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  }
  return fields;
}

describe("Sign in with Cardboard", () => {
  let t: TestServer;
  let browser: Browser;
  let config: SignInConfig;

  /** Runs the whole dance in the browser and returns where Cardboard sent us back. */
  async function signIn(cfg: SignInConfig, decision: "allow" | "deny" = "allow") {
    const pending = await startSignIn(cfg);
    let page = await browser.get(pending.url);
    if (page.status === 200 && page.html.includes("Open your Cardboard")) {
      const login = await browser.post(`${t.cb.url}/oauth/login`, { token: t.owner, return_to: hiddenFields(page.html)["return_to"]! });
      assert.equal(login.status, 303);
      page = await browser.get(`${t.cb.url}${login.location}`);
    }
    if (page.status === 302) return { pending, callback: page.location!, consented: false };
    assert.equal(page.status, 200, page.html);
    assert.match(page.html, /Let <span class="mono">/);
    const answer = await browser.post(`${t.cb.url}/oauth/authorize`, { ...hiddenFields(page.html), decision });
    assert.equal(answer.status, 303);
    return { pending, callback: answer.location!, consented: true };
  }

  before(async () => {
    t = await startTestServer({ shake: false });
    browser = new Browser(t.cb.url);
    await t.admin("profile.set", { name: "Gosinn", email: "gosinn@example.is" });
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

  it("signs a person in, with consent, and gives the app a box in THEIR Cardboard", async () => {
    const { pending, callback, consented } = await signIn(config);
    assert.ok(consented);
    assert.match(callback, /^http:\/\/localhost:5173\/callback\?code=/);
    const session = await finishSignIn(config, callback, pending);
    assert.match(session.user.id, /^[A-Za-z0-9_-]{27}$/);
    assert.equal(session.user.name, "Gosinn");
    assert.equal(session.user.email, "gosinn@example.is");

    await session.box().put("prefs", { theme: "dark" });
    const boxes = (await t.admin("boxes")).body.boxes;
    const box = boxes.find((b: any) => b.name === "recipe-planner");
    assert.equal(box.profile.title, "Recipe Planner");
    assert.equal(box.items, 1);

    const apps = (await t.admin("apps")).body;
    assert.equal(apps.connected[0].name, "Recipe Planner");
    assert.equal(apps.connected[0].box, "recipe-planner");
    assert.equal(apps.connected[0].privateId, session.user.id);

    const userinfo = await (await fetch(`${t.cb.url}/oauth/userinfo`, { headers: { authorization: `Bearer ${session.accessToken}` } })).json();
    assert.deepEqual(userinfo, { sub: session.user.id, name: "Gosinn", email: "gosinn@example.is" });
  });

  it("signs ID tokens that verify against the published keys", async () => {
    const { pending, callback } = await signIn(config);
    const res = await fetch(`${t.cb.url}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: new URL(callback).searchParams.get("code")!,
        redirect_uri: config.redirectUri,
        client_id: config.clientId,
        code_verifier: pending.verifier,
      }).toString(),
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
  });

  it("remembers: the next sign-in skips the questions and gives the same private ID", async () => {
    const first = await signIn(config);
    const a = await finishSignIn(config, first.callback, first.pending);
    const second = await signIn(config);
    assert.equal(second.consented, false, "no consent screen the second time");
    const b = await finishSignIn(config, second.callback, second.pending);
    assert.equal(a.user.id, b.user.id);
    assert.deepEqual(await b.box().get("prefs"), { theme: "dark" }, "same box, same data");
  });

  it("gives every app a different private ID, so apps can't compare notes", async () => {
    const other = await registerApp(t.cb.url, { name: "Fitness", redirectUris: ["http://127.0.0.1:4000/cb"] });
    const otherConfig: SignInConfig = { issuer: t.cb.url, clientId: other.clientId, redirectUri: "http://127.0.0.1:4000/cb" };
    const a = await signIn(config);
    const b = await signIn(otherConfig);
    const sa = await finishSignIn(config, a.callback, a.pending);
    const sb = await finishSignIn(otherConfig, b.callback, b.pending);
    assert.notEqual(sa.user.id, sb.user.id);
    assert.equal(sb.user.name, undefined, "only what was consented to");
  });

  it("refreshes tokens by itself, and disconnects an app whose refresh token gets copied", async () => {
    const { pending, callback } = await signIn(config);
    const session = await finishSignIn(config, callback, pending);
    const box = session.box();
    t.clock.advance(2 * HOUR); // access token expired
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
    const log = (await t.admin("log")).body.entries.map((e: any) => e.text);
    assert.ok(log.some((l: string) => l.startsWith("Security: A refresh token for Recipe Planner was used twice")));
  });

  it("refuses codes without the PKCE secret, and codes used twice", async () => {
    const { pending, callback } = await signIn(config);
    await assert.rejects(finishSignIn(config, callback, { ...pending, verifier: "x".repeat(43) }), (err: unknown) => err instanceof CardboardError && err.code === "invalid_grant");
    const again = await signIn(config);
    const ok = await finishSignIn(config, again.callback, again.pending);
    await assert.rejects(finishSignIn(config, again.callback, again.pending), (err: unknown) => err instanceof CardboardError && err.code === "invalid_grant");
    await assert.rejects(ok.box().get("prefs"), "tokens from a replayed code are revoked");
  });

  it("never redirects anywhere the app didn't register, and refuses forged forms", async () => {
    const pending = await startSignIn({ ...config, redirectUri: "https://evil.example/steal" });
    const page = await browser.get(pending.url);
    assert.equal(page.status, 400);
    assert.equal(page.location, null);
    assert.match(page.html, /never registered/);

    const good = await startSignIn({ ...config, scopes: ["openid", "profile", "email", "box"] });
    const consent = await browser.get(good.url.replace("scope=openid", "prompt=consent&scope=openid"));
    assert.equal(consent.status, 200);
    const fields = hiddenFields(consent.html);
    assert.equal((await browser.post(`${t.cb.url}/oauth/authorize`, { ...fields, csrf: "forged", decision: "allow" })).status, 403);
    assert.equal((await browser.post(`${t.cb.url}/oauth/authorize`, { ...fields, decision: "allow" }, "https://evil.example")).status, 403);
  });

  it("lets you say no", async () => {
    const shy = await registerApp(t.cb.url, { name: "Nosy App", redirectUris: ["https://nosy.example/cb"] });
    const shyConfig: SignInConfig = { issuer: t.cb.url, clientId: shy.clientId, redirectUri: "https://nosy.example/cb" };
    const { pending, callback } = await signIn(shyConfig, "deny");
    await assert.rejects(finishSignIn(shyConfig, callback, pending), (err: unknown) => err instanceof CardboardError && err.code === "access_denied");
  });

  it("disconnects an app and shreds what it kept about you", async () => {
    const { pending, callback } = await signIn(config);
    const session = await finishSignIn(config, callback, pending);
    const grant = (await t.admin("apps")).body.connected.find((a: any) => a.name === "Recipe Planner").grant;
    const res = await t.admin("apps.disconnect", { grant, shred: true });
    assert.equal(res.body.shredded, "recipe-planner");
    await assert.rejects(session.box().get("prefs"));
    assert.ok(!(await t.admin("boxes")).body.boxes.some((b: any) => b.name === "recipe-planner"));
    const userinfo = await fetch(`${t.cb.url}/oauth/userinfo`, { headers: { authorization: `Bearer ${session.accessToken}` } });
    assert.equal(userinfo.status, 401);
  });
});
