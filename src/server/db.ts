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
  `
  -- What an app has told Cardboard about itself (title, description, url, version).
  ALTER TABLE boxes ADD COLUMN profile TEXT NOT NULL DEFAULT '{}';

  -- Docks: named meeting points where apps swap data without learning who's who.
  CREATE TABLE docks (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    wrapped_key BLOB NOT NULL,
    settings    TEXT NOT NULL DEFAULT '{}',
    created_at  INTEGER NOT NULL,
    last_seq    INTEGER NOT NULL DEFAULT 0
  );

  -- An app's place at a dock. can_* is what's approved, want_* what it has asked for.
  -- tag is the app's pseudonym at this dock: a keyed hash, different at every dock.
  CREATE TABLE berths (
    dock_id      TEXT NOT NULL REFERENCES docks(id) ON DELETE CASCADE,
    box_id       TEXT NOT NULL REFERENCES boxes(id) ON DELETE CASCADE,
    tag          TEXT NOT NULL,
    can_send     INTEGER NOT NULL DEFAULT 0,
    can_receive  INTEGER NOT NULL DEFAULT 0,
    want_send    INTEGER NOT NULL DEFAULT 0,
    want_receive INTEGER NOT NULL DEFAULT 0,
    denied       INTEGER NOT NULL DEFAULT 0,
    requested_at INTEGER,
    approved_at  INTEGER,
    cursor       INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (dock_id, box_id)
  ) WITHOUT ROWID;
  CREATE UNIQUE INDEX berths_tag ON berths(dock_id, tag);
  CREATE INDEX berths_box ON berths(box_id);

  -- Parcels in flight. The sender is stored only as its pseudonym, plus an
  -- encrypted copy of its box id that only the owner can read. seq counts per
  -- dock, so apps can't gauge traffic on other docks.
  CREATE TABLE parcels (
    id         TEXT PRIMARY KEY,
    dock_id    TEXT NOT NULL REFERENCES docks(id) ON DELETE CASCADE,
    seq        INTEGER NOT NULL,
    sender_tag TEXT NOT NULL,
    to_tag     TEXT,
    body_enc   BLOB NOT NULL,
    sender_enc BLOB NOT NULL,
    size       INTEGER NOT NULL,
    sent_at    INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX parcels_dock ON parcels(dock_id, seq);
  CREATE INDEX parcels_expiry ON parcels(expires_at);
  `,
  `
  -- Sign in with Cardboard (OpenID Connect). Apps that connect get short-lived
  -- tapes linked to their grant, so revoking the grant revokes everything.
  ALTER TABLE tapes ADD COLUMN grant_id TEXT;
  CREATE INDEX tapes_grant ON tapes(grant_id) WHERE grant_id IS NOT NULL;

  CREATE TABLE oauth_clients (
    id            TEXT PRIMARY KEY,
    secret_hash   BLOB,
    name          TEXT NOT NULL,
    redirect_uris TEXT NOT NULL,
    client_uri    TEXT,
    registered_by TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    last_used_at  INTEGER
  );

  -- What you said yes to. sector is the app's web origin: it decides the app's
  -- private ID for you and which box it gets back if it reconnects.
  CREATE TABLE oauth_grants (
    id           TEXT PRIMARY KEY,
    client_id    TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
    sector       TEXT NOT NULL,
    scopes       TEXT NOT NULL,
    box_id       TEXT REFERENCES boxes(id) ON DELETE SET NULL,
    created_at   INTEGER NOT NULL,
    last_used_at INTEGER,
    revoked_at   INTEGER
  );
  CREATE INDEX oauth_grants_client ON oauth_grants(client_id);
  CREATE INDEX oauth_grants_sector ON oauth_grants(sector);

  -- Access and refresh tokens, stored only as hashes.
  CREATE TABLE oauth_tokens (
    hash       BLOB PRIMARY KEY,
    grant_id   TEXT NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at    INTEGER,
    created_at INTEGER NOT NULL
  ) WITHOUT ROWID;
  CREATE INDEX oauth_tokens_grant ON oauth_tokens(grant_id);

  -- Browser sessions for the sign-in and consent pages (cookie value stored hashed).
  CREATE TABLE sessions (
    hash         BLOB PRIMARY KEY,
    created_at   INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL,
    last_seen_at INTEGER
  ) WITHOUT ROWID;
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
