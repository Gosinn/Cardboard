import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fail } from "../shared/errors.ts";
import { derive, newSecret, randomKey, seal, sha256, unseal } from "./crypto.ts";
import { getMeta, openDb, setMeta, type DB } from "./db.ts";

export interface Paths {
  dataDir: string;
  dbFile: string;
  keyFile: string;
}

export function resolvePaths(options: { dataDir?: string; keyFile?: string } = {}): Paths {
  const dataDir = resolve(options.dataDir ?? process.env["CARDBOARD_DATA"] ?? "cardboard-data");
  const keyFile = resolve(options.keyFile ?? process.env["CARDBOARD_KEY_FILE"] ?? join(dataDir, "server.key"));
  return { dataDir, dbFile: join(dataDir, "cardboard.db"), keyFile };
}

const KEY_PREFIX = "cbk2:";

/**
 * The server key protects the server's own secrets: the key that signs
 * sign-in tokens, the key behind apps' private IDs for you, and the key behind
 * dock pseudonyms. It does NOT protect anyone's data (that's sealed with keys
 * only their devices hold), so losing it never loses data. It does change
 * every app's private ID for every person, so keep it with your backups.
 */
export interface ServerKeys {
  subkey(purpose: string): Buffer;
}

function writeKeyFile(path: string, key: Buffer) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const body = [
    "# Cardboard server key.",
    "# It protects the server's own secrets (sign-in signing key, private IDs, dock pseudonyms).",
    "# People's data is sealed with keys only their devices hold, so this key can't open it.",
    "# Keep it with your backups: without it, apps see everyone as a new person.",
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
  if (key.length !== 32) throw fail("bad_key_file", 500, `${path} doesn't contain a valid Cardboard server key.`);
  return key;
}

export interface Store {
  db: DB;
  keys: ServerKeys;
  firstRun: boolean;
  /** Only set the very first time, when the host token is created. */
  hostToken?: string;
}

/**
 * Opens (or creates) the data folder. A new server key is only ever generated
 * for a brand-new database: Cardboard never silently replaces a key.
 */
export function openStore(paths: Paths, now: () => number = Date.now): Store {
  mkdirSync(paths.dataDir, { recursive: true, mode: 0o700 });
  const dbExists = existsSync(paths.dbFile);
  let serverKey: Buffer;
  if (existsSync(paths.keyFile)) {
    serverKey = readKeyFile(paths.keyFile);
  } else if (dbExists) {
    openDb(paths.dbFile).close(); // A 0.1 data folder gets a clearer message than "missing key".
    throw fail(
      "missing_key",
      500,
      `Found a database at ${paths.dbFile} but no server key at ${paths.keyFile}.`,
      "Restore server.key from your backup, or set CARDBOARD_KEY_FILE to where it is.",
    );
  } else {
    serverKey = randomKey();
    writeKeyFile(paths.keyFile, serverKey);
  }

  const db = openDb(paths.dbFile);
  try {
    chmodSync(paths.dbFile, 0o600);
  } catch {
    // Not fatal (e.g. on some network filesystems); the shake test reports folder permissions.
  }
  const system = derive(serverKey, "server");
  serverKey.fill(0);
  try {
    verifyKey(db, derive(system, "check"));
  } catch (err) {
    db.close();
    throw err;
  }
  const keys: ServerKeys = { subkey: (purpose) => derive(system, purpose) };

  let hostToken: string | undefined;
  if (!getMeta(db, "host_hash")) {
    hostToken = newSecret("cbh");
    setMeta(db, "host_hash", sha256(hostToken).toString("base64"));
    setMeta(db, "created_at", String(now()));
  }
  return { db, keys, firstRun: !dbExists, hostToken };
}

function verifyKey(db: DB, checkKey: Buffer) {
  const stored = getMeta(db, "key_check");
  if (!stored) {
    setMeta(db, "key_check", seal(checkKey, "cardboard", "key-check").toString("base64"));
    return;
  }
  try {
    unseal(checkKey, Buffer.from(stored, "base64"), "key-check");
  } catch {
    throw fail(
      "wrong_key",
      500,
      "This server key doesn't belong to this database.",
      "Point CARDBOARD_KEY_FILE at the server.key that was created together with this data folder.",
    );
  }
}

/** Replaces the host token. Needs the data folder and server key, i.e. access to the server itself. */
export function resetHost(paths: Paths): string {
  if (!existsSync(paths.dbFile)) throw fail("no_data", 404, `There's no Cardboard data at ${paths.dataDir}.`);
  const { db } = openStore(paths);
  try {
    const token = newSecret("cbh");
    setMeta(db, "host_hash", sha256(token).toString("base64"));
    return token;
  } finally {
    db.close();
  }
}
