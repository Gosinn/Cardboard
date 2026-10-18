// The container's entrypoint. Hosting platforms (Railway, Fly.io, Render…) often
// mount the data volume owned by root, so this starts as root only long enough
// to hand /data to the unprivileged `node` user, then drops to it before any
// Cardboard code runs.
import { chmodSync, chownSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DATA = process.env.CARDBOARD_DATA ?? "/data";
const UID = 1000;
const GID = 1000;

function handOver(path) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return;
  if (stat.uid !== UID || stat.gid !== GID) chownSync(path, UID, GID);
  if (stat.isDirectory()) for (const name of readdirSync(path)) handOver(join(path, name));
}

if (process.getuid?.() === 0) {
  try {
    handOver(DATA);
    chmodSync(DATA, 0o700);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  process.setgroups([GID]);
  process.setgid(GID);
  process.setuid(UID);
}
process.env.HOME = "/home/node";
await import("../src/cli.ts");
