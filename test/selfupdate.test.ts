import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { newerVersion, selfUpdate } from "../src/node/selfupdate.ts";

describe("keeping itself up to date while it runs", () => {
  const root = mkdtempSync(join(tmpdir(), "cardboard-update-"));
  after(() => rmSync(root, { recursive: true, force: true }));
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd, stdio: "pipe" }).toString().trim();
  const upstream = join(root, "upstream");
  const here = join(root, "here");

  it("brings in a newer version and asks to start again; leaves a checkout with its own changes alone", async () => {
    execFileSync("git", ["init", "-q", "-b", "main", upstream]);
    writeFileSync(join(upstream, "a.txt"), "1");
    git(upstream, "add", ".");
    git(upstream, "commit", "-qm", "one");
    execFileSync("git", ["clone", "-q", upstream, here]);
    assert.equal(await newerVersion(here), null, "nothing newer yet");
    writeFileSync(join(upstream, "a.txt"), "2");
    git(upstream, "commit", "-qam", "two");
    const two = git(upstream, "rev-parse", "HEAD");
    assert.equal(await newerVersion(here), two);
    // Its timers don't keep a server alive on their own; this keeps the test alive until it's done.
    const alive = setInterval(() => {}, 1000);
    const restarted = await new Promise<string>((resolve) => {
      const stop = selfUpdate(here, (v) => (stop(), resolve(v)), { firstMs: 10, everyMs: 60_000 });
    });
    clearInterval(alive);
    assert.equal(restarted, two.slice(0, 7));
    assert.equal(git(here, "rev-parse", "HEAD"), two, "the new version is in");
    // A commit made here: never pulled over.
    writeFileSync(join(here, "b.txt"), "mine");
    git(here, "add", ".");
    git(here, "commit", "-qm", "mine");
    writeFileSync(join(upstream, "a.txt"), "3");
    git(upstream, "commit", "-qam", "three");
    assert.equal(await newerVersion(here), null);
  });
});
