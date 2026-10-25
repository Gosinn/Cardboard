/**
 * Moving Cardboard's storage (its database, server key and backups) to another folder or drive,
 * while it's stopped: copied under another name, checked, then renamed into place. The old copy is
 * left as it was; whoever moved it deletes it once Cardboard runs from the new place.
 */
import { DatabaseSync } from "node:sqlite";
import { cpSync, existsSync, readdirSync, renameSync, rmSync, statfsSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fail } from "../shared/errors.ts";
import { formatBytes } from "../shared/size.ts";

function folderSize(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    total += entry.isDirectory() ? folderSize(path) : statSync(path).size;
  }
  return total;
}

/** Where the storage goes when `to` is picked: that folder if it's empty or new, or already Cardboard's data, otherwise a "Cardboard data" folder in it (a drive like X:\ picks X:\Cardboard data). */
export function storageTarget(to: string): string {
  const picked = resolve(to);
  if (!existsSync(picked) || readdirSync(picked).length === 0 || existsSync(join(picked, "cardboard.db"))) return picked;
  return join(picked, "Cardboard data");
}

/** Copies the storage at `from` to `to` (see storageTarget), checks the copy opens and holds the same, and returns where it went. */
export function moveData(from: string, to: string): { target: string; bytes: number } {
  const source = resolve(from);
  const db = join(source, "cardboard.db");
  if (!existsSync(db)) throw fail("no_data", 404, `There's no Cardboard data at ${source}.`, "Point --data at the folder with cardboard.db in it.");
  const target = storageTarget(to);
  if (resolve(target).toLowerCase() === source.toLowerCase()) throw fail("same_place", 400, "Cardboard already keeps its data there.", "Pick another folder or drive.");
  if (existsSync(join(target, "cardboard.db"))) throw fail("data_there", 409, `There's already Cardboard data at ${target}.`, "Pick an empty folder, or move that one away first.");
  // Everything written so far goes into the main file first, so the copy is whole.
  const live = new DatabaseSync(db);
  live.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  live.close();
  const bytes = folderSize(source);
  const parent = resolve(target, "..");
  try {
    const fs = statfsSync(existsSync(target) ? target : parent);
    if (fs.bavail * fs.bsize < bytes + 256 * 1024 * 1024) throw fail("disk_full", 507, `There isn't room there: Cardboard's data is ${formatBytes(bytes)}, and ${formatBytes(fs.bavail * fs.bsize)} is free.`, "Pick a drive with more room.");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw fail("not_there", 404, `${parent} isn't there (is the drive plugged in?).`, "Plug it in, or pick another place.");
    if ((err as NodeJS.ErrnoException).code !== "ENOSYS") throw err;
  }
  // Copied under another name, checked, then renamed: a copy cut off half way never looks like Cardboard's data.
  const part = `${target}.moving`;
  rmSync(part, { recursive: true, force: true });
  cpSync(source, part, { recursive: true, filter: (path) => !/-(wal|shm)$/.test(basename(path)) });
  const copy = new DatabaseSync(join(part, "cardboard.db"));
  const check = (copy.prepare("PRAGMA quick_check").get() as Record<string, string>)["quick_check"];
  const counts = (d: DatabaseSync) => JSON.stringify(["accounts", "boxes", "items", "history"].map((t) => (d.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n));
  const original = new DatabaseSync(db, { readOnly: true });
  const same = counts(copy) === counts(original);
  copy.close();
  original.close();
  if (check !== "ok" || !same || folderSize(part) < bytes - 64 * 1024) {
    rmSync(part, { recursive: true, force: true });
    throw fail("copy_bad", 500, "The copy didn't come out the same, so nothing was moved.", "Try again, or pick another drive (this one may be failing).");
  }
  if (existsSync(target)) rmSync(target, { recursive: true }); // empty: storageTarget only picks an empty or new folder
  renameSync(part, target);
  return { target, bytes };
}
