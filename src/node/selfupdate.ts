/**
 * Keeps a Cardboard that runs from a git checkout up to date while it runs: every hour it
 * asks git whether there's a newer version, and if there is (and it's only newer, nothing
 * changed by hand), it brings it in and stops, so whatever started it (start-cardboard.cmd,
 * Cardboard.exe, systemd) starts it again on the new version: a few seconds offline.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const git = (dir: string, ...args: string[]) =>
  new Promise<string | null>((resolve) => execFile("git", args, { cwd: dir, timeout: 120_000, windowsHide: true }, (err, out) => resolve(err ? null : String(out).trim())));

/** Whether there's a newer version to bring in: its commit, or null. */
export async function newerVersion(dir: string): Promise<string | null> {
  if (!existsSync(join(dir, ".git"))) return null;
  await git(dir, "fetch", "--quiet");
  const [head, upstream] = await Promise.all([git(dir, "rev-parse", "HEAD"), git(dir, "rev-parse", "@{u}")]);
  if (!head || !upstream || head === upstream) return null;
  // Only forward: a checkout with its own commits isn't touched.
  return (await git(dir, "merge-base", "--is-ancestor", "HEAD", "@{u}")) === null ? null : upstream;
}

/** Checks now and then every `everyMs`; on a newer version, brings it in and calls `restart`. */
export function selfUpdate(dir: string, restart: (version: string) => void, options: { everyMs?: number; firstMs?: number; say?: (line: string) => void } = {}): () => void {
  let tried = "";
  const check = async () => {
    const newer = await newerVersion(dir);
    if (!newer || newer === tried) return;
    tried = newer;
    if ((await git(dir, "pull", "--ff-only", "--quiet")) === null) {
      options.say?.("A newer version of Cardboard is out, but git couldn't bring it in (files changed by hand?). Run git pull in the Cardboard folder to see why.");
      return;
    }
    restart(newer.slice(0, 7));
  };
  const first = setTimeout(check, options.firstMs ?? 60_000);
  const every = setInterval(check, options.everyMs ?? 60 * 60 * 1000);
  first.unref();
  every.unref();
  return () => (clearTimeout(first), clearInterval(every));
}
