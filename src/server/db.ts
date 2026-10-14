import { DatabaseSync } from "node:sqlite";

export type DB = DatabaseSync;

const MIGRATIONS: string[] = [
  `
  CREATE TABLE meta (
    k TEXT PRIMARY KEY,
    v TEXT NOT NULL
  );

  CREATE TABLE boxes (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    wrapped_key BLOB NOT NULL,
    settings    TEXT NOT NULL DEFAULT '{}',
    created_at  INTEGER NOT NULL,
    system      INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE tapes (
    id           TEXT PRIMARY KEY,
    box_id       TEXT NOT NULL REFERENCES boxes(id) ON DELETE CASCADE,
    label        TEXT NOT NULL,
    secret_hash  BLOB NOT NULL UNIQUE,
    can_read     INTEGER NOT NULL,
    can_write    INTEGER NOT NULL,
    prefix       TEXT,
    idle_ms      INTEGER,
    expires_at   INTEGER,
    created_at   INTEGER NOT NULL,
    last_used_at INTEGER,
    revoked_at   INTEGER
  );
  CREATE INDEX tapes_box ON tapes(box_id);

  -- Current state. Key names are stored encrypted (key_enc) and looked up by
  -- a keyed HMAC (key_id), so the database never holds them in plain text.
  CREATE TABLE items (
    box_id     TEXT NOT NULL REFERENCES boxes(id) ON DELETE CASCADE,
    key_id     BLOB NOT NULL,
    key_enc    BLOB NOT NULL,
    value_enc  BLOB NOT NULL,
    size       INTEGER NOT NULL,
    version    INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    expires_at INTEGER,
    PRIMARY KEY (box_id, key_id)
  ) WITHOUT ROWID;
  CREATE INDEX items_expiry ON items(expires_at) WHERE expires_at IS NOT NULL;

  -- Every version ever written (until retention prunes it). value_enc NULL = deleted.
  CREATE TABLE history (
    box_id    TEXT NOT NULL REFERENCES boxes(id) ON DELETE CASCADE,
    key_id    BLOB NOT NULL,
    version   INTEGER NOT NULL,
    key_enc   BLOB NOT NULL,
    value_enc BLOB,
    size      INTEGER NOT NULL,
    at        INTEGER NOT NULL,
    actor     TEXT NOT NULL,
    PRIMARY KEY (box_id, key_id, version)
  ) WITHOUT ROWID;
  CREATE INDEX history_at ON history(box_id, at);

  -- Audit log. Who/what/when are plain; the details (key names, IPs) are encrypted.
  CREATE TABLE log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    box_id     TEXT REFERENCES boxes(id) ON DELETE CASCADE,
    at         INTEGER NOT NULL,
    actor      TEXT NOT NULL,
    action     TEXT NOT NULL,
    outcome    TEXT NOT NULL,
    detail_enc BLOB
  );
  CREATE INDEX log_box_at ON log(box_id, at);
  CREATE INDEX log_at ON log(at);
  `,
];

export function openDb(path: string): DB {
  const db = new DatabaseSync(path);
  // secure_delete overwrites deleted rows on disk, so shredded data doesn't linger in free pages.
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA secure_delete = ON;
    PRAGMA busy_timeout = 5000;
  `);
  migrate(db);
  return db;
}

function migrate(db: DB) {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  for (let v = row.user_version; v < MIGRATIONS.length; v++) {
    transaction(db, () => {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
}

export function transaction<T>(db: DB, fn: () => T): T {
  if (db.isTransaction) return fn();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function getMeta(db: DB, key: string): string | undefined {
  const row = db.prepare("SELECT v FROM meta WHERE k = ?").get(key) as { v: string } | undefined;
  return row?.v;
}

export function setMeta(db: DB, key: string, value: string) {
  db.prepare("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(key, value);
}
