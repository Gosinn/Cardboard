import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fail } from "../shared/errors.ts";
import { newSecret, randomKey, sha256 } from "./crypto.ts";
import { getMeta, openDb, setMeta, type DB } from "./db.ts";
import { Vault } from "./vault.ts";

export interface Paths {
  dataDir: string;
  dbFile: string;
  keyFile: string;
}

export function resolvePaths(options: { dataDir?: string; keyFile?: string } = {}): Paths {
  const dataDir = resolve(options.dataDir ?? process.env["CARDBOARD_DATA"] ?? "cardboard-data");
  const keyFile = resolve(options.keyFile ?? process.env["CARDBOARD_KEY_FILE"] ?? join(dataDir, "master.key"));
  return { dataDir, dbFile: join(dataDir, "cardboard.db"), keyFile };
}

const KEY_PREFIX = "cbk1:";

function writeKeyFile(path: string, key: Buffer) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const body = [
    "# Cardboard master key.",
    "# Without it nothing in Cardboard can be read; with it, everything can.",
    "# Back it up somewhere that is NOT the data folder (a password manager is ideal).",
    `${KEY_PREFIX}${key.toString("base64")}`,
    "",
  ].join("\n");
  writeFileSync(path, body, { mode: 0o600, flag: "wx" });
}

function readKeyFile(path: string): Buffer {
  const line = readFileSync(path, "utf8")
    .split(/\r?\n/)
    .find((l) => l.startsWith(KEY_PREFIX));
  const key = line ? Buffer.from(line.slice(KEY_PREFIX.length).trim(), "base64") : Buffer.alloc(0);
  if (key.length !== 32) {
    throw fail("bad_key_file", 500, `${path} doesn't contain a valid Cardboard master key.`);
  }
  return key;
}

export interface Store {
  db: DB;
  vault: Vault;
  firstRun: boolean;
  /** Only set the very first time, when the owner token is created. */
  ownerToken?: string;
}

/**
 * Opens (or creates) the data folder. A new master key is only ever generated
 * for a brand-new database: Cardboard never silently replaces a key.
 */
export function openStore(paths: Paths, now: () => number = Date.now): Store {
  mkdirSync(paths.dataDir, { recursive: true, mode: 0o700 });
  const dbExists = existsSync(paths.dbFile);
  let masterKey: Buffer;
  if (existsSync(paths.keyFile)) {
    masterKey = readKeyFile(paths.keyFile);
  } else if (dbExists) {
    throw fail(
      "missing_key",
      500,
      `Found a database at ${paths.dbFile} but no master key at ${paths.keyFile}.`,
      "Without its key the data can't be read. Restore master.key, or set CARDBOARD_KEY_FILE to where it is.",
    );
  } else {
    masterKey = randomKey();
    writeKeyFile(paths.keyFile, masterKey);
  }

  const db = openDb(paths.dbFile);
  try {
    chmodSync(paths.dbFile, 0o600);
  } catch {
    // Not fatal (e.g. on some network filesystems); the shake test reports folder permissions.
  }
  let vault: Vault;
  try {
    vault = new Vault(db, masterKey, now);
  } catch (err) {
    db.close();
    throw err;
  } finally {
    masterKey.fill(0);
  }

  let ownerToken: string | undefined;
  if (!getMeta(db, "owner_hash")) {
    ownerToken = newSecret("cbo");
    setMeta(db, "owner_hash", sha256(ownerToken).toString("base64"));
    setMeta(db, "created_at", String(now()));
  }
  return { db, vault, firstRun: !dbExists, ownerToken };
}

/** Replaces the owner token. Needs the data folder and master key, i.e. access to the server itself. */
export function resetOwner(paths: Paths): string {
  if (!existsSync(paths.dbFile)) throw fail("no_data", 404, `There's no Cardboard data at ${paths.dataDir}.`);
  const { db } = openStore(paths);
  try {
    const token = newSecret("cbo");
    setMeta(db, "owner_hash", sha256(token).toString("base64"));
    return token;
  } finally {
    db.close();
  }
}
