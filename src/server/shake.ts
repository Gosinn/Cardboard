import { createHash, randomBytes } from "node:crypto";
import { statSync } from "node:fs";
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
 * The shake test: Cardboard attacks itself through the same API your apps use
 * and reports what held. It works on two throwaway boxes that are shredded
 * afterwards, so your real data is never touched.
 */
export function runShake(api: Api): ShakeReport {
  const { vault, tapes, db, info, docks, oauth } = api.ctx;
  const results: ShakeResult[] = [];
  const check = (id: string, title: string, run: () => Omit<ShakeResult, "id" | "title">) => {
    try {
      results.push({ id, title, ...run() });
    } catch (err) {
      results.push({ id, title, status: "fail", detail: `The check itself crashed: ${(err as Error).message}` });
    }
  };
  const pass = (detail: string) => ({ status: "pass" as const, detail });
  const failed = (detail: string) => ({ status: "fail" as const, detail });
  const warn = (detail: string) => ({ status: "warn" as const, detail });

  const call = (op: string, secret: string | undefined, body: unknown, extra: Partial<ApiRequest> = {}): ApiResponse =>
    api.call({
      op,
      admin: false,
      authorization: secret ? `Bearer ${secret}` : undefined,
      ip: PROBE_IP,
      body,
      internal: true,
      ...extra,
    });
  const errorCode = (res: ApiResponse) => (res.body as { error?: { code?: string } }).error?.code;

  const tag = randomBytes(4).toString("hex");
  const boxA = vault.createBox(`__shake-${tag}-a`, { system: true });
  const boxB = vault.createBox(`__shake-${tag}-b`, { system: true });
  const boxC = vault.createBox(`__shake-${tag}-c`, { system: true });
  const dock1 = docks.create(`__shake-${tag}-1`, { internal: true });
  const dock2 = docks.create(`__shake-${tag}-2`, { internal: true });
  const shakeApps: Client[] = [];
  const shakeBoxes: string[] = [];
  try {
    const a = tapes.create(boxA.id, { label: "shake" });
    const b = tapes.create(boxB.id, { label: "shake" });
    const canary = `canary-${randomBytes(12).toString("hex")}`;
    const secretKey = `secret/${canary}`;
    const setup = call("put", a.secret, { key: secretKey, value: { note: canary } });
    const setup2 = call("put", a.secret, { key: "public/hello", value: { note: "hello" } });
    if (setup.status !== 200 || setup2.status !== 200) throw new Error("couldn't write test data");

    check("no-tape", "Locked without a tape", () => {
      const res = call("get", undefined, { key: secretKey });
      return res.status === 401 ? pass("Requests without a tape are turned away.") : failed(`Got ${res.status} instead of 401.`);
    });

    check("fake-tape", "Made-up tapes don't open anything", () => {
      const res = call("get", `cbt_${randomBytes(32).toString("base64url")}`, { key: secretKey });
      return res.status === 401 ? pass("Random tapes are rejected.") : failed(`Got ${res.status} instead of 401.`);
    });

    check("isolation", "Boxes can't see into each other", () => {
      const got = call("get", b.secret, { key: secretKey }).body as { item?: unknown };
      const listed = call("list", b.secret, {}).body as { items?: unknown[] };
      const found = call("query", b.secret, { where: { note: canary } }).body as { items?: unknown[] };
      if (got.item === null && listed.items?.length === 0 && found.items?.length === 0) {
        return pass("Another app's tape couldn't read, list or search the test box.");
      }
      return failed("A tape for one box could see data in another box.");
    });

    check("read-only", "Read-only tapes can't write", () => {
      const ro = tapes.create(boxA.id, { write: false });
      const res = call("put", ro.secret, { key: "public/x", value: 1 });
      return res.status === 403 ? pass("Writes with a read-only tape are refused.") : failed(`Got ${res.status} instead of 403.`);
    });

    check("prefix", "Limited tapes stay inside their limits", () => {
      const limited = tapes.create(boxA.id, { prefix: "public/" });
      const outside = call("get", limited.secret, { key: secretKey });
      const listed = call("list", limited.secret, {}).body as { items?: Array<{ key: string }> };
      const leaked = listed.items?.some((i) => !i.key.startsWith("public/")) ?? true;
      if (outside.status === 403 && !leaked) return pass("A tape limited to “public/” couldn't read or list anything else.");
      return failed("A prefix-limited tape reached keys outside its prefix.");
    });

    check("revoked", "Revoked tapes stop working", () => {
      const r = tapes.create(boxA.id);
      tapes.revoke(r.tape.id);
      const res = call("get", r.secret, { key: secretKey });
      return res.status === 401 ? pass("A revoked tape was refused straight away.") : failed(`Got ${res.status} instead of 401.`);
    });

    check("expired", "Expired tapes stop working", () => {
      const e = tapes.create(boxA.id, { expiresAt: vault.now() - 1000 });
      const res = call("get", e.secret, { key: secretKey });
      return res.status === 401 ? pass("An expired tape was refused.") : failed(`Got ${res.status} instead of 401.`);
    });

    check("admin", "App tapes can't use the owner API", () => {
      const res = call("boxes", a.secret, {}, { admin: true });
      return res.status === 401 ? pass("The owner API ignored an app's tape.") : failed(`Got ${res.status} instead of 401.`);
    });

    check("cors", "Unknown websites are turned away", () => {
      const res = call("get", a.secret, { key: secretKey }, { origin: "https://evil.example" });
      const allowed = Object.keys(res.headers).some((h) => h.toLowerCase() === "access-control-allow-origin");
      return res.status === 403 && !allowed
        ? pass("A browser request from a site you didn't allow was refused.")
        : failed("A request from an unknown website was let through.");
    });

    check("at-rest", "Nothing readable at rest", () => {
      const needle = Buffer.from(canary);
      const rows = [
        ...(db.prepare("SELECT key_enc AS a, value_enc AS b FROM items WHERE box_id = ?").all(boxA.id) as Array<{ a: Uint8Array; b: Uint8Array | null }>),
        ...(db.prepare("SELECT key_enc AS a, value_enc AS b FROM history WHERE box_id = ?").all(boxA.id) as Array<{ a: Uint8Array; b: Uint8Array | null }>),
      ];
      const plain = rows.some((r) => Buffer.from(r.a).includes(needle) || (r.b !== null && Buffer.from(r.b).includes(needle)));
      return rows.length > 0 && !plain
        ? pass("Key names and values in the database are encrypted.")
        : failed("Test data was found in plain text in the database.");
    });

    const rows = db.prepare("SELECT key_id, value_enc FROM items WHERE box_id = ?").all(boxA.id) as Array<{
      key_id: Uint8Array;
      value_enc: Uint8Array;
    }>;

    check("swap", "Data can't be moved between keys", () => {
      if (rows.length < 2) return failed("Not enough test rows.");
      const [r1, r2] = rows as [(typeof rows)[0], (typeof rows)[0]];
      const update = db.prepare("UPDATE items SET value_enc = ? WHERE box_id = ? AND key_id = ?");
      update.run(r2.value_enc, boxA.id, r1.key_id);
      update.run(r1.value_enc, boxA.id, r2.key_id);
      const res1 = call("get", a.secret, { key: secretKey });
      const res2 = call("get", a.secret, { key: "public/hello" });
      update.run(r1.value_enc, boxA.id, r1.key_id);
      update.run(r2.value_enc, boxA.id, r2.key_id);
      return errorCode(res1) === "tampered" && errorCode(res2) === "tampered"
        ? pass("Swapping encrypted values between keys was detected.")
        : failed("Encrypted values could be swapped between keys without being noticed.");
    });

    check("tamper", "Tampering is detected", () => {
      const update = db.prepare("UPDATE items SET value_enc = ? WHERE box_id = ? AND key_id = ?");
      for (const row of rows) {
        const bent = Buffer.from(row.value_enc);
        bent.writeUInt8(bent.readUInt8(bent.length - 1) ^ 0xff, bent.length - 1);
        update.run(bent, boxA.id, row.key_id);
      }
      const res = call("get", a.secret, { key: secretKey });
      return errorCode(res) === "tampered"
        ? pass("A single flipped byte in the database was caught.")
        : failed("Modified data was returned as if it were fine.");
    });

    check("rate-limit", "Guessing tapes gets you blocked", () => {
      api.limiter.reset(PROBE_IP);
      let last: ApiResponse | undefined;
      for (let i = 0; i < 31; i++) last = call("get", `cbt_guess${i}`, { key: secretKey });
      api.limiter.reset(PROBE_IP);
      return last?.status === 429 ? pass("After 30 bad tapes the address was slowed down.") : failed(`Got ${last?.status} instead of 429.`);
    });

    // ── Docks ──
    const da = tapes.create(boxA.id, { label: "shake" });
    const db_ = tapes.create(boxB.id, { label: "shake" });
    const dc = tapes.create(boxC.id, { label: "shake" });
    const parcelsOf = (res: ApiResponse) => ((res.body as { parcels?: Array<Record<string, unknown>> }).parcels ?? []);

    check("dock-permission", "Docks need your permission", () => {
      const sent = call("dock.send", dc.secret, { dock: dock1.name, body: { hi: 1 } });
      const got = call("dock.receive", dc.secret, { dock: dock1.name });
      return errorCode(sent) === "dock_pending" && errorCode(got) === "dock_pending"
        ? pass("An app without a berth could only ask to dock; it couldn't send or receive.")
        : failed("An app used a dock without being approved.");
    });

    docks.grant(dock1.id, boxA.id, { send: true, receive: true });
    docks.grant(dock1.id, boxB.id, { send: true, receive: true });
    docks.grant(dock1.id, boxC.id, { receive: true });
    docks.grant(dock2.id, boxA.id, { send: true });

    check("dock-anonymous", "Docked apps stay anonymous", () => {
      const sent = call("dock.send", da.secret, { dock: dock1.name, body: { note: canary } });
      const [parcel] = parcelsOf(call("dock.receive", db_.secret, { dock: dock1.name }));
      if (sent.status !== 200 || !parcel) return failed("The test parcel didn't arrive.");
      const seen = JSON.stringify(parcel);
      const leaks = [boxA.id, boxA.name, da.tape.id].some((s) => seen.includes(s));
      const tag1 = docks.tagFor(dock1.id, boxA.id);
      const tag2 = docks.tagFor(dock2.id, boxA.id);
      return !leaks && parcel["from"] === tag1 && tag1 !== tag2
        ? pass("The receiver saw a pseudonym, never a name, and the sender's pseudonym is different at every dock.")
        : failed("A parcel revealed who sent it, or pseudonyms could be linked across docks.");
    });

    check("dock-secrets", "Customs stops secrets", () => {
      const res = call("dock.send", da.secret, { dock: dock1.name, body: { key: `sk-ant-api03-${"x".repeat(40)}` } });
      return errorCode(res) === "secret_at_customs" ? pass("An API key was refused at the dock.") : failed("A secret crossed a dock.");
    });

    check("dock-infection", "Customs stops booby-trapped parcels", () => {
      const res = call("dock.send", da.secret, { dock: dock1.name, body: JSON.parse('{"a":{"__proto__":{"admin":true}}}') });
      return errorCode(res) === "unsafe_parcel" ? pass("A prototype-pollution parcel was refused.") : failed("A booby-trapped parcel was carried.");
    });

    check("dock-personal", "Personal data is redacted at the dock", () => {
      call("dock.send", da.secret, { dock: dock1.name, body: { email: "anna@example.is", item: "milk" } });
      const parcel = parcelsOf(call("dock.receive", db_.secret, { dock: dock1.name })).at(-1);
      const body = parcel?.["body"] as Record<string, unknown> | undefined;
      return body?.["email"] === "[redacted email address]" && body["item"] === "milk"
        ? pass("An email address was replaced before delivery; the rest arrived intact.")
        : failed("Personal data crossed a dock unredacted.");
    });

    check("dock-direct", "Direct replies reach only their target", () => {
      const tagB = docks.tagFor(dock1.id, boxB.id);
      const before = parcelsOf(call("dock.receive", dc.secret, { dock: dock1.name })).length;
      call("dock.send", da.secret, { dock: dock1.name, body: { secret: false, msg: "just for B" }, to: tagB });
      const forC = parcelsOf(call("dock.receive", dc.secret, { dock: dock1.name })).length;
      const forB = parcelsOf(call("dock.receive", db_.secret, { dock: dock1.name })).some((p) => p["to"] === tagB);
      const forA = parcelsOf(call("dock.receive", da.secret, { dock: dock1.name })).some((p) => (p["body"] as { msg?: string })?.msg === "just for B");
      return forB && forC === before && !forA
        ? pass("A reply addressed to one pseudonym wasn't seen by anyone else, including its sender.")
        : failed("A direct parcel reached someone it wasn't for.");
    });

    check("dock-at-rest", "Parcels are encrypted at rest", () => {
      const rows = db.prepare("SELECT body_enc, sender_enc FROM parcels WHERE dock_id = ?").all(dock1.id) as Array<{ body_enc: Uint8Array; sender_enc: Uint8Array }>;
      const needles = [Buffer.from(canary), Buffer.from(boxA.id)];
      const plain = rows.some((r) => needles.some((n) => Buffer.from(r.body_enc).includes(n) || Buffer.from(r.sender_enc).includes(n)));
      return rows.length > 0 && !plain ? pass("Parcel contents and senders are encrypted in the database.") : failed("A parcel was readable in the database.");
    });

    check("dock-undock", "Undocked apps are cut off", () => {
      docks.remove(dock1.id, boxC.id);
      const res = call("dock.receive", dc.secret, { dock: dock1.name });
      return errorCode(res) === "dock_pending" && parcelsOf(res).length === 0
        ? pass("After being taken off the dock, an app couldn't pick anything up.")
        : failed("An app kept receiving after it was taken off the dock.");
    });

    // ── Sign in with Cardboard ──
    const register = (host: string) => {
      const { client } = oauth.register({ client_name: "shake", redirect_uris: [`https://${host}/cb`], token_endpoint_auth_method: "none" }, "shake");
      shakeApps.push(client);
      return client;
    };
    const appA = register("shake-a.example");
    const appB = register("shake-b.example");
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const redirectA = appA.redirectUris[0]!;
    let grantA = oauth.consent({ client: appA, redirectUri: redirectA, scopes: ["openid", "box"] }, { internal: true });
    if (grantA.boxId) shakeBoxes.push(grantA.boxId);
    const signIn = () => {
      const code = oauth.issueCode(grantA, { client: appA, redirectUri: redirectA, codeChallenge: challenge, nonce: null }, vault.now());
      return { code, tokens: () => oauth.exchangeCode({ code, redirectUri: redirectA, verifier, clientId: appA.id }) };
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

    check("oauth-redirect", "Sign-in links can't be hijacked", () => {
      const res = oauth.checkAuthorize(
        new URLSearchParams({ client_id: appA.id, redirect_uri: "https://evil.example/cb", response_type: "code", code_challenge: challenge, code_challenge_method: "S256" }),
      );
      return res.kind === "page"
        ? pass("A sign-in that tried to send you to an address the app never registered was stopped on Cardboard's own page.")
        : failed("Cardboard would have redirected to an address the app never registered.");
    });

    check("oauth-pkce", "Sign-in codes need the app's proof (PKCE)", () => {
      const noPkce = oauth.checkAuthorize(new URLSearchParams({ client_id: appA.id, redirect_uri: redirectA, response_type: "code" }));
      const { code } = signIn();
      const wrong = refusedWith(() => oauth.exchangeCode({ code, redirectUri: redirectA, verifier: "x".repeat(43), clientId: appA.id }), "invalid_grant");
      return noPkce.kind === "redirect" && noPkce.location.includes("error=invalid_request") && wrong
        ? pass("Sign-ins without PKCE were refused, and a stolen code was useless without the app's secret verifier.")
        : failed("A sign-in code worked without the right PKCE verifier.");
    });

    check("oauth-pairwise", "Apps can't compare notes about you", () => {
      const tokens = signIn().tokens();
      const sub = JSON.parse(Buffer.from(tokens.id_token!.split(".")[1]!, "base64url").toString()).sub as string;
      const other = oauth.subjectFor(new URL(appB.redirectUris[0]!).origin);
      return sub === oauth.subjectFor(new URL(redirectA).origin) && sub !== other
        ? pass("Two apps got two unrelated private IDs for the same person.")
        : failed("Two apps got matching IDs for the same person.");
    });

    check("oauth-box", "Signed-in apps stay in their own box", () => {
      const tokens = signIn().tokens();
      const listed = call("list", tokens.access_token, {}).body as { items?: unknown[] };
      const got = call("get", tokens.access_token, { key: secretKey }).body as { item?: unknown };
      return listed.items?.length === 0 && got.item === null
        ? pass("An app's sign-in token only reached the app's own box.")
        : failed("A sign-in token reached data outside the app's box.");
    });

    check("oauth-code-once", "Sign-in codes work once", () => {
      const attempt = signIn();
      const tokens = attempt.tokens();
      const replayed = refusedWith(attempt.tokens, "invalid_grant");
      return replayed && accessRevoked(tokens.access_token)
        ? pass("A replayed code was refused and the tokens it produced were revoked.")
        : failed("A sign-in code worked twice.");
    });

    check("oauth-refresh-reuse", "Copied refresh tokens are caught", () => {
      grantA = oauth.consent({ client: appA, redirectUri: redirectA, scopes: ["openid", "box"] }, { internal: true });
      const first = signIn().tokens();
      const second = oauth.refresh({ refreshToken: first.refresh_token, clientId: appA.id });
      const replayed = refusedWith(() => oauth.refresh({ refreshToken: first.refresh_token, clientId: appA.id }), "invalid_grant");
      return replayed && accessRevoked(second.access_token)
        ? pass("Reusing an old refresh token disconnected the app, so a copied token is worthless.")
        : failed("An old refresh token kept working after it was rotated.");
    });
  } catch (err) {
    results.push({ id: "setup", title: "Shake test setup", status: "fail", detail: (err as Error).message });
  } finally {
    for (const client of shakeApps) oauth.forgetClient(client.id);
    for (const boxId of shakeBoxes) if (vault.getBox(boxId)) vault.shredBox(boxId);
    docks.shred(dock1.id);
    docks.shred(dock2.id);
    vault.shredBox(boxA.id);
    vault.shredBox(boxB.id);
    vault.shredBox(boxC.id);
    api.limiter.reset(PROBE_IP);
  }

  check("key-file", "Master key file is private", () => {
    if (process.platform === "win32") return pass("Skipped on Windows.");
    const mode = statSync(info.keyFile).mode & 0o777;
    return (mode & 0o077) === 0
      ? pass("Only your user can read master.key.")
      : warn(`master.key is readable by other users (mode ${mode.toString(8)}). Fix: chmod 600 "${info.keyFile}"`);
  });

  check("data-dir", "Data folder is private", () => {
    if (process.platform === "win32") return pass("Skipped on Windows.");
    const mode = statSync(info.dataDir).mode & 0o777;
    return (mode & 0o077) === 0
      ? pass("Only your user can open the data folder.")
      : warn(`Other users can open the data folder (mode ${mode.toString(8)}). Fix: chmod 700 "${info.dataDir}"`);
  });

  check("transport", "Traffic is protected", () => {
    if (info.tls) return pass("Cardboard is serving HTTPS.");
    if (isLoopback(info.host)) return pass("Cardboard only listens on this machine.");
    return warn("Cardboard is reachable over plain HTTP from the network. Put it behind HTTPS.");
  });

  check("tape-expiry", "Every tape expires on its own", () => {
    const forever = tapes
      .listAll()
      .filter((t) => tapes.state(t) === "active" && t.idleMs === null && t.expiresAt === null);
    return forever.length === 0
      ? pass("All active tapes switch themselves off eventually.")
      : warn(`${forever.length} tape${forever.length === 1 ? " never expires" : "s never expire"}. See insights to revoke ${forever.length === 1 ? "it" : "them"}.`);
  });

  const passed = results.filter((r) => r.status === "pass").length;
  const failedCount = results.filter((r) => r.status === "fail").length;
  const warned = results.filter((r) => r.status === "warn").length;
  const parts = [`${passed}/${results.length} passed`];
  if (failedCount) parts.push(`${failedCount} failed`);
  if (warned) parts.push(`${warned} warning${warned === 1 ? "" : "s"}`);
  return {
    at: vault.now(),
    ok: failedCount === 0,
    passed,
    failed: failedCount,
    warned,
    summary: parts.join(", "),
    results,
  };
}
