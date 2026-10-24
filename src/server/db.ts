import { DatabaseSync } from "node:sqlite";
import { fail } from "../shared/errors.ts";

export type DB = DatabaseSync;

/**
 * Cardboard 0.2 schema. The server is blind: every column that holds something
 * a person wrote (names, values, labels, profiles) holds it sealed by a key
 * that only that person's devices have. The rest is what the server needs to
 * do its job: ids, sizes, times, permissions.
 *
 * user_version starts at 100, so a 0.1 database (versions 1–5, server-side
 * encryption) is recognised and never half-migrated.
 */
const BASE = 100;

const MIGRATIONS: string[] = [
  `
  CREATE TABLE meta (
    k TEXT PRIMARY KEY,
    v TEXT NOT NULL
  );

  -- One row per person. profile (your name and email, for apps you allow) is sealed.
  CREATE TABLE accounts (
    id           TEXT PRIMARY KEY,
    created_at   INTEGER NOT NULL,
    last_seen_at INTEGER,
    recovery     TEXT NOT NULL DEFAULT 'kit',
    profile      BLOB,
    quota_bytes  INTEGER,
    internal     INTEGER NOT NULL DEFAULT 0
  );

  -- Every device you're signed in on. envelope is the account key sealed by a
  -- key that never leaves that device: remove the device and its copy is gone.
  CREATE TABLE devices (
    id           TEXT PRIMARY KEY,
    account_id   TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    token_hash   BLOB NOT NULL UNIQUE,
    envelope     BLOB,
    label        BLOB,
    kind         TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    last_seen_at INTEGER
  );
  CREATE INDEX devices_account ON devices(account_id);

  -- Recovery kit and trusted-friends copies of the account key, sealed by keys
  -- derived from codes only you (or your friends) hold. lookup is a hash that
  -- finds the account without revealing the code.
  CREATE TABLE recovery (
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL,
    lookup     BLOB NOT NULL UNIQUE,
    envelope   BLOB NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (account_id, kind)
  ) WITHOUT ROWID;

  -- A new device asking to join. id and mac come from a code shown on that
  -- device, which the server never sees; envelope is the account key sealed to
  -- the new device's public key by the device that said yes.
  CREATE TABLE pairings (
    id          BLOB PRIMARY KEY,
    public_key  BLOB NOT NULL,
    token_hash  BLOB NOT NULL,
    mac         BLOB NOT NULL,
    kind        TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL,
    account_id  TEXT REFERENCES accounts(id) ON DELETE CASCADE,
    device_id   TEXT,
    envelope    BLOB
  ) WITHOUT ROWID;

  CREATE TABLE invites (
    hash       BLOB PRIMARY KEY,
    note       TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at    INTEGER,
    account_id TEXT
  ) WITHOUT ROWID;

  -- idx is a keyed hash of the box's name (the key is yours); name and key are sealed,
  -- profile is sealed by the box key. settings are plain: the server enforces them.
  CREATE TABLE boxes (
    id         TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    idx        BLOB NOT NULL,
    name       BLOB NOT NULL,
    key        BLOB NOT NULL,
    profile    BLOB,
    settings   TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    UNIQUE (account_id, idx)
  );

  -- An app's access to one box. The token half of a tape is stored hashed; the
  -- key half never reaches the server, and opens bundle (the box key, sealed).
  CREATE TABLE tapes (
    id           TEXT PRIMARY KEY,
    account_id   TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    box_id       TEXT NOT NULL REFERENCES boxes(id) ON DELETE CASCADE,
    token_hash   BLOB NOT NULL UNIQUE,
    bundle       BLOB,
    label        BLOB,
    kind         TEXT NOT NULL DEFAULT 'app',
    can_read     INTEGER NOT NULL,
    can_write    INTEGER NOT NULL,
    idle_ms      INTEGER,
    expires_at   INTEGER,
    created_at   INTEGER NOT NULL,
    last_used_at INTEGER,
    revoked_at   INTEGER,
    grant_id     TEXT
  );
  CREATE INDEX tapes_box ON tapes(box_id);
  CREATE INDEX tapes_grant ON tapes(grant_id) WHERE grant_id IS NOT NULL;

  -- idx is a keyed hash of the item's name; name and value are sealed by the box key.
  CREATE TABLE items (
    box_id     TEXT NOT NULL REFERENCES boxes(id) ON DELETE CASCADE,
    idx        BLOB NOT NULL,
    name       BLOB NOT NULL,
    value      BLOB NOT NULL,
    size       INTEGER NOT NULL,
    version    INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    expires_at INTEGER,
    PRIMARY KEY (box_id, idx)
  ) WITHOUT ROWID;
  CREATE INDEX items_expiry ON items(expires_at) WHERE expires_at IS NOT NULL;

  -- Every version, sealed exactly as it was written. value NULL = deleted.
  CREATE TABLE history (
    box_id  TEXT NOT NULL REFERENCES boxes(id) ON DELETE CASCADE,
    idx     BLOB NOT NULL,
    version INTEGER NOT NULL,
    name    BLOB NOT NULL,
    value   BLOB,
    size    INTEGER NOT NULL,
    at      INTEGER NOT NULL,
    actor   TEXT NOT NULL,
    PRIMARY KEY (box_id, idx, version)
  ) WITHOUT ROWID;
  CREATE INDEX history_at ON history(box_id, at);

  -- Who did what, when. action, outcome and count are plain so they can be
  -- counted. ref is a sealed name copied from where it lives (an item's, a
  -- dock's) and ref_ctx says how to open it; detail is sealed by whoever did
  -- it. note is the server's own words and never contains anything you stored.
  CREATE TABLE log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
    box_id     TEXT REFERENCES boxes(id) ON DELETE CASCADE,
    dock_id    TEXT,
    at         INTEGER NOT NULL,
    actor      TEXT NOT NULL,
    action     TEXT NOT NULL,
    outcome    TEXT NOT NULL,
    count      INTEGER,
    note       TEXT,
    ref        BLOB,
    ref_ctx    TEXT,
    detail     BLOB
  );
  CREATE INDEX log_account_at ON log(account_id, at);
  CREATE INDEX log_box_at ON log(box_id, at);

  -- Docks: meeting points where your apps swap parcels without learning who's who.
  -- name and key stay NULL while an app has only asked for a dock you haven't made.
  CREATE TABLE docks (
    id         TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    idx        BLOB NOT NULL,
    name       BLOB,
    key        BLOB,
    settings   TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    last_seq   INTEGER NOT NULL DEFAULT 0,
    UNIQUE (account_id, idx)
  );

  -- key: the dock key sealed by this box's key (set when you approve).
  -- ask: the dock's name sealed by the asking app, so you can read its request.
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
    key          BLOB,
    ask          BLOB,
    PRIMARY KEY (dock_id, box_id)
  ) WITHOUT ROWID;
  CREATE UNIQUE INDEX berths_tag ON berths(dock_id, tag);
  CREATE INDEX berths_box ON berths(box_id);

  -- Parcels in flight, sealed by the dock key. Apps only ever see sender_tag.
  -- Shredding the sending box takes its parcels with it.
  CREATE TABLE parcels (
    id         TEXT PRIMARY KEY,
    dock_id    TEXT NOT NULL REFERENCES docks(id) ON DELETE CASCADE,
    seq        INTEGER NOT NULL,
    sender_tag TEXT NOT NULL,
    sender_box TEXT NOT NULL REFERENCES boxes(id) ON DELETE CASCADE,
    to_tag     TEXT,
    body       BLOB NOT NULL,
    size       INTEGER NOT NULL,
    sent_at    INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX parcels_dock ON parcels(dock_id, seq);
  CREATE INDEX parcels_expiry ON parcels(expires_at);

  -- Sign in with Cardboard (OpenID Connect). registered_by is 'self' (the app
  -- registered itself) or the id of the account that added it.
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

  -- claims: a name/email you chose to pass to an app that can't take sealed
  -- data. It goes through the server, so it's sealed by the server's own key.
  CREATE TABLE oauth_grants (
    id           TEXT PRIMARY KEY,
    account_id   TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    client_id    TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
    sector       TEXT NOT NULL,
    scopes       TEXT NOT NULL,
    box_id       TEXT REFERENCES boxes(id) ON DELETE SET NULL,
    claims       BLOB,
    created_at   INTEGER NOT NULL,
    last_used_at INTEGER,
    revoked_at   INTEGER
  );
  CREATE INDEX oauth_grants_account ON oauth_grants(account_id);
  CREATE INDEX oauth_grants_client ON oauth_grants(client_id);

  CREATE TABLE oauth_tokens (
    hash       BLOB PRIMARY KEY,
    grant_id   TEXT NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at    INTEGER,
    created_at INTEGER NOT NULL
  ) WITHOUT ROWID;
  CREATE INDEX oauth_tokens_grant ON oauth_tokens(grant_id);
  `,
  `
  -- 'passkey' when the device is locked with Face ID, Touch ID, Windows Hello…:
  -- its envelope then also needs a secret only the passkey can produce.
  ALTER TABLE devices ADD COLUMN lock TEXT;

  -- The owner's name as the people a box is shared with see it, sealed by the box key.
  ALTER TABLE boxes ADD COLUMN owner_label BLOB;

  -- A box shared by link, waiting for someone to accept. The secret is in the
  -- link (a fragment the server never sees); lookup is a hash of a key made
  -- from it, and envelope (the box key and name) is sealed by another. One
  -- use, then it's gone. label is the owner's note on who it's for.
  CREATE TABLE shares (
    id         TEXT PRIMARY KEY,
    box_id     TEXT NOT NULL REFERENCES boxes(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    lookup     BLOB NOT NULL UNIQUE,
    envelope   BLOB NOT NULL,
    label      BLOB,
    can_write  INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX shares_box ON shares(box_id);

  -- People a box is shared with. key is the box key sealed by the member's own
  -- account key, name is what they call the box (sealed by them), label is
  -- what the box's people see them as (sealed by the box key). When someone
  -- leaves, their key and name go; the label stays so the log can still say
  -- who did what.
  CREATE TABLE members (
    id         TEXT PRIMARY KEY,
    box_id     TEXT NOT NULL REFERENCES boxes(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    key        BLOB,
    name       BLOB,
    label      BLOB,
    can_write  INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    removed_at INTEGER,
    UNIQUE (box_id, account_id)
  );
  CREATE INDEX members_account ON members(account_id);
  `,
  `
  -- Emergency access: a link you give someone you trust. If they use it, every
  -- one of your devices is told, and after wait_ms (unless you stop it, or say
  -- yes sooner) they can open your Cardboard. The link's secret never reaches
  -- the server: envelope (the account key) and note (who it's from, and your
  -- message) are sealed by keys made from it, lookup is a hash of another.
  -- label is your own note on who it's for, sealed by your meta key.
  CREATE TABLE emergency (
    id           TEXT PRIMARY KEY,
    account_id   TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    lookup       BLOB NOT NULL UNIQUE,
    envelope     BLOB NOT NULL,
    note         BLOB NOT NULL,
    label        BLOB,
    wait_ms      INTEGER NOT NULL,
    created_at   INTEGER NOT NULL,
    requested_at INTEGER,
    approved_at  INTEGER
  );
  CREATE INDEX emergency_account ON emergency(account_id);

  -- Who made an invite: an account (when the host lets people invite friends), or NULL for the host.
  ALTER TABLE invites ADD COLUMN created_by TEXT;
  `,
  `
  -- Each value is kept once. The live version lives in items, and its history
  -- row holds NULL until a newer version (or a delete) copies it in. Before
  -- this, every value was stored twice. (A history row with value NULL is now
  -- a deletion only when it isn't the live version.)
  UPDATE history SET value = NULL
   WHERE value IS NOT NULL AND EXISTS (
     SELECT 1 FROM items i WHERE i.box_id = history.box_id AND i.idx = history.idx AND i.version = history.version);
  `,
  `
  -- Versions written with an expiry. When an item expires, only these go:
  -- versions meant to be kept stay in history, so an app can't wipe an item's
  -- past by rewriting it with a short expiry.
  ALTER TABLE history ADD COLUMN temporary INTEGER NOT NULL DEFAULT 0;
  `,
  `
  -- Adding a device by matching numbers. A device you have opens an offer; the
  -- new device joins it with a commitment to its public key; the offering
  -- device adds a random nonce; then the new device reveals its key. Both show
  -- a number made from all of it, and you check they match. The server only
  -- passes these along, and can't pick a key that gives the same number.
  CREATE TABLE pair_offers (
    id          BLOB PRIMARY KEY,
    account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL,
    commitment  BLOB,
    kind        TEXT,
    token_hash  BLOB,
    nonce_a     BLOB,
    public_key  BLOB,
    nonce_n     BLOB,
    device_id   TEXT,
    envelope    BLOB
  ) WITHOUT ROWID;
  `,
  `
  -- The new device says yes too (its numbers match), and the device you have may
  -- say yes first: its sealed key and label wait here until both have.
  ALTER TABLE pair_offers ADD COLUMN confirmed INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE pair_offers ADD COLUMN label BLOB;
  `,
  // Sizes, versions and dates are stored after the (up to 1 MB) value, so reading them meant reading every value:
  // adding up a box's size read the whole box, on every write. These indexes hold them on their own.
  `
  CREATE INDEX items_meta ON items(box_id, idx, name, size, version, created_at, updated_at, expires_at);
  CREATE INDEX history_kept ON history(box_id, (value IS NULL), size);
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
  try {
    migrate(db, path);
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

function migrate(db: DB, path: string) {
  const { user_version: current } = db.prepare("PRAGMA user_version").get() as { user_version: number };
  if (current > 0 && current < BASE) {
    throw fail(
      "old_data",
      500,
      `${path} was made by Cardboard 0.1, which kept the keys to your data on the server.`,
      "Cardboard 0.2 keeps keys only on your devices, so it needs a new data folder. Export your boxes with 0.1 (cardboard export <box>), then import them into your new account.",
    );
  }
  for (let v = Math.max(current - BASE, 0); v < MIGRATIONS.length; v++) {
    transaction(db, () => {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${BASE + v + 1}`);
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
