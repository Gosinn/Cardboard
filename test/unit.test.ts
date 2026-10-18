import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describeDuration, parseDuration } from "../src/shared/duration.ts";
import { formatBytes, parseSize } from "../src/shared/size.ts";
import { combineShares, equalBytes, fromB64u, fromCode, keyPair, open, openWith, random, seal, sealTo, splitSecret, toB64u, toCode, utf8 } from "../src/client/crypto.ts";
import { accountKeys, boxKeys, itemIndex } from "../src/client/keys.ts";
import { mergePatch } from "../src/shared/data.ts";
import { describeCounts, luhn, scan, validIban, validKennitala } from "../src/shared/detect.ts";
import { matches, sortItems } from "../src/shared/query.ts";

describe("durations and sizes", () => {
  it("parses the ways people write durations", () => {
    assert.equal(parseDuration("30s"), 30_000);
    assert.equal(parseDuration("10m"), 600_000);
    assert.equal(parseDuration("12 hours"), 12 * 3_600_000);
    assert.equal(parseDuration("30d"), 30 * 86_400_000);
    assert.equal(parseDuration("2w"), 14 * 86_400_000);
    assert.equal(parseDuration(90), 90_000);
    assert.throws(() => parseDuration("soon"), /isn't a duration/);
    assert.throws(() => parseDuration("0d"));
    assert.equal(describeDuration(3 * 86_400_000), "3 days");
    assert.equal(describeDuration(60_000), "1 minute");
  });

  it("parses and formats sizes", () => {
    assert.equal(parseSize("500KB"), 500 * 1024);
    assert.equal(parseSize("1.5 GB"), 1.5 * 1024 ** 3);
    assert.equal(parseSize(2048), 2048);
    assert.throws(() => parseSize("lots"));
    assert.equal(formatBytes(1536), "1.5 KB");
    assert.equal(formatBytes(512 * 1024 * 1024), "512 MB");
  });
});

describe("crypto (on your devices)", () => {
  const locked = (err: unknown) => (err as { code?: string }).code === "locked";

  it("round-trips and binds sealed data to its context", async () => {
    const key = random(32);
    const sealed = await seal(key, "hello", "item|a");
    assert.equal(utf8.decode(await open(key, sealed, "item|a")), "hello");
    await assert.rejects(open(key, sealed, "item|b"), locked);
    await assert.rejects(open(random(32), sealed, "item|a"), locked);
    const bent = Uint8Array.from(sealed);
    bent[20]! ^= 1;
    await assert.rejects(open(key, bent, "item|a"), locked);
  });

  it("uses fresh IVs, so equal values don't look equal", async () => {
    const key = random(32);
    assert.ok(!equalBytes(await seal(key, "same", "c"), await seal(key, "same", "c")));
  });

  it("seals to a public key that only its holder can open", async () => {
    const alice = await keyPair();
    const eve = await keyPair();
    const sealed = await sealTo(alice.publicKey, "for alice", "to");
    assert.equal(utf8.decode(await openWith(alice, sealed, "to")), "for alice");
    await assert.rejects(openWith(eve, sealed, "to"), locked);
    await assert.rejects(openWith(alice, sealed, "other"), locked);
  });

  it("derives independent keys and stable, keyed fingerprints", async () => {
    const account = await accountKeys(random(32));
    assert.ok(!equalBytes(account.wrap, account.meta) && !equalBytes(account.meta, account.index));
    const a = await boxKeys(random(32));
    const b = await boxKeys(random(32));
    assert.equal(await itemIndex(a, "notes/1"), await itemIndex(a, "notes/1"));
    assert.notEqual(await itemIndex(a, "notes/1"), await itemIndex(b, "notes/1"), "the same name looks different in every box");
    assert.match(await itemIndex(a, "notes/1"), /^[A-Za-z0-9_-]{43}$/);
  });

  it("splits a secret so any k of n pieces rebuild it, and fewer reveal nothing usable", () => {
    const secret = random(16);
    const pieces = splitSecret(secret, 5, 3);
    assert.ok(equalBytes(combineShares([pieces[4]!, pieces[0]!, pieces[2]!]), secret));
    assert.ok(equalBytes(combineShares([pieces[1]!, pieces[3]!, pieces[2]!]), secret));
    assert.ok(!equalBytes(combineShares([pieces[1]!, pieces[3]!]), secret), "two of a 3-of-5 split give garbage");
    assert.throws(() => combineShares([pieces[0]!, pieces[0]!]), /don't fit together/);
  });

  it("writes human codes that survive sloppy typing but catch typos", () => {
    const bytes = random(16);
    const code = toCode(bytes);
    assert.match(code, /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{1,4}){6}$/);
    assert.ok(equalBytes(fromCode(code.toLowerCase().replace(/-/g, "  ").replace(/0/g, "o"), 16), bytes));
    const typo = code.replace(/^(.)/, (c) => (c === "7" ? "8" : "7"));
    assert.throws(() => fromCode(typo, 16), /typo/);
    assert.throws(() => fromCode("ABCD", 16), /doesn't look right/);
  });

  it("speaks base64url exactly like Node does", () => {
    for (const n of [0, 1, 2, 3, 31, 32, 33, 65]) {
      const b = random(n);
      assert.equal(toB64u(b), Buffer.from(b).toString("base64url"));
      assert.ok(equalBytes(fromB64u(toB64u(b)), b));
    }
    assert.throws(() => fromB64u("a+b/"));
  });
});

describe("sensitive data detection", () => {
  const kinds = (value: unknown) => scan(value).map((f) => f.kind).sort();

  it("spots provider keys and names them", () => {
    const [finding] = scan({ ai: "sk-proj-abcdefghijklmnopqrstuvwxyz0123" });
    assert.equal(finding?.kind, "api-key");
    assert.equal(finding?.what, "OpenAI");
    assert.equal(scan({ k: "AKIAABCDEFGHIJKLMNOP" })[0]?.what, "AWS");
    assert.equal(scan({ k: "ghp_" + "a".repeat(36) })[0]?.what, "GitHub");
    assert.equal(scan("sk-ant-api03-" + "x".repeat(40))[0]?.what, "Anthropic");
  });

  it("flags plain passwords but not password hashes", () => {
    assert.deepEqual(kinds({ password: "hunter2!" }), ["password"]);
    assert.deepEqual(kinds({ password: "$argon2id$v=19$m=65536,t=3,p=4$abc$def" }), []);
    assert.deepEqual(kinds({ password: "$2b$12$abcdefghijklmnopqrstuuJ5j5j5j5j5j5j5j5j5j5j5j5j5j5j5j" }), []);
  });

  it("validates card numbers, IBANs and kennitölur instead of guessing", () => {
    assert.ok(luhn("4111111111111111"));
    assert.ok(!luhn("4111111111111112"));
    assert.deepEqual(kinds({ card: "4111 1111 1111 1111" }), ["card-number"]);
    assert.deepEqual(kinds({ order: "Order 4111111111111112" }), []);
    assert.ok(validIban("GB82 WEST 1234 5698 7654 32"));
    assert.ok(!validIban("GB82 WEST 1234 5698 7654 33"));
    assert.ok(validKennitala("1201743399"));
    assert.ok(!validKennitala("1201743389"));
    assert.deepEqual(kinds({ kt: "120174-3399" }), ["kennitala"]);
    assert.deepEqual(kinds({ phoneish: "5551234567" }), []);
  });

  it("finds emails, phones, JWTs and private keys, with paths", () => {
    const findings = scan({
      contacts: [{ email: "anna@example.is", phone: "+354 555 1234" }],
      session: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      key: "-----BEGIN OPENSSH PRIVATE KEY-----\nabc",
    });
    const byPath = Object.fromEntries(findings.map((f) => [f.path, f.kind]));
    assert.equal(byPath["contacts[0].email"], "email");
    assert.equal(byPath["contacts[0].phone"], "phone");
    assert.equal(byPath["session"], "jwt");
    assert.equal(byPath["key"], "private-key");
  });

  it("leaves ordinary data alone", () => {
    assert.deepEqual(kinds({ title: "Lasagna", serves: 4, notes: "extra basil, 200g cheese", year: 2026 }), []);
  });

  it("stays fast on hostile input", () => {
    const start = performance.now();
    scan({ a: "a".repeat(200_000) + "@", b: "1 ".repeat(50_000), c: "eyJ".repeat(30_000) });
    assert.ok(performance.now() - start < 1000);
  });

  it("describes counts in plain English", () => {
    assert.equal(describeCounts({ email: 12, "api-key": 1 }), "1 API key or secret and 12 email addresses");
    assert.equal(describeCounts({ kennitala: 3 }), "3 kennitölur");
  });
});

describe("queries", () => {
  const doc = { title: "Lasagna", stars: 5, tags: ["dinner", "italian"], author: { name: "Gosinn" }, done: false };

  it("matches equality, arrays, dot paths and operators", () => {
    assert.ok(matches(doc, { done: false }));
    assert.ok(matches(doc, { tags: "dinner" }));
    assert.ok(matches(doc, { "author.name": "Gosinn" }));
    assert.ok(matches(doc, { stars: { $gte: 4, $lt: 6 } }));
    assert.ok(matches(doc, { title: { $contains: "sag" } }));
    assert.ok(matches(doc, { title: { $startsWith: "Las" } }));
    assert.ok(matches(doc, { stars: { $in: [4, 5] } }));
    assert.ok(matches(doc, { missing: { $exists: false } }));
    assert.ok(matches(doc, { $or: [{ stars: 1 }, { done: false }] }));
    assert.ok(!matches(doc, { $not: { done: false } }));
    assert.ok(!matches(doc, { stars: { $gt: "4" } }), "different types never compare");
    assert.throws(() => matches(doc, { stars: { $near: 4 } }), /Unknown operator/);
  });

  it("sorts with missing values last", () => {
    const items = [
      { key: "a", value: { n: 2 }, createdAt: 3, updatedAt: 3 },
      { key: "b", value: {}, createdAt: 1, updatedAt: 1 },
      { key: "c", value: { n: 1 }, createdAt: 2, updatedAt: 2 },
    ];
    assert.deepEqual(sortItems(items, "n").map((i) => i.key), ["c", "a", "b"]);
    assert.deepEqual(sortItems(items, "-n").map((i) => i.key), ["a", "c", "b"]);
    assert.deepEqual(sortItems(items, "-$createdAt").map((i) => i.key), ["a", "c", "b"]);
  });

  it("merge-patches objects", () => {
    assert.deepEqual(mergePatch({ a: 1, b: { c: 2, d: 3 } }, { a: null, b: { c: 4 }, e: 5 }), { b: { c: 4, d: 3 }, e: 5 });
    const sneaky = mergePatch({}, JSON.parse('{"__proto__": {"polluted": true}}')) as Record<string, unknown>;
    assert.equal(Object.getPrototypeOf(sneaky), Object.prototype);
    assert.equal(JSON.stringify(sneaky), '{"__proto__":{"polluted":true}}');
    assert.equal(({} as Record<string, unknown>)["polluted"], undefined);
  });
});
