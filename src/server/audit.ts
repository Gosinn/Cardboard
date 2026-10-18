import type { DB } from "./db.ts";
import { b64 } from "./wire.ts";

export type Outcome = "ok" | "denied" | "error";

/**
 * The packing slip: who touched what, when. The server writes what it knows
 * (the action, the outcome, how many) and copies sealed names from where they
 * live, so your device can show "Notes saved “groceries”" while the log on
 * disk only says "tape_x put <sealed>". Turning entries into sentences
 * happens on your device (src/shared/activity.ts).
 */
export interface LogInput {
  accountId: string | null;
  boxId?: string | null;
  dockId?: string | null;
  actor: string;
  action: string;
  outcome?: Outcome;
  count?: number;
  /** The server's own words. Never anything a person stored. */
  note?: string;
  /** A sealed name, and the context that opens it (e.g. "item-name|box_x|idx"). */
  ref?: { sealed: Uint8Array; ctx: string } | null;
  /** Sealed by whoever did it: the box key if there's a box, otherwise the account's meta key. */
  detail?: Uint8Array | null;
}

export interface LogEntry {
  id: number;
  at: number;
  box: string | null;
  dock: string | null;
  actor: string;
  action: string;
  outcome: Outcome;
  count: number | null;
  note: string | null;
  ref: { sealed: string; ctx: string } | null;
  detail: string | null;
}

const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

interface LogRow {
  id: number;
  box_id: string | null;
  dock_id: string | null;
  at: number;
  actor: string;
  action: string;
  outcome: Outcome;
  count: number | null;
  note: string | null;
  ref: Uint8Array | null;
  ref_ctx: string | null;
  detail: Uint8Array | null;
}

export class Audit {
  private readonly db: DB;
  private readonly now: () => number;

  constructor(db: DB, now: () => number) {
    this.db = db;
    this.now = now;
  }

  record(entry: LogInput) {
    this.db
      .prepare(
        "INSERT INTO log (account_id, box_id, dock_id, at, actor, action, outcome, count, note, ref, ref_ctx, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        entry.accountId,
        entry.boxId ?? null,
        entry.dockId ?? null,
        this.now(),
        entry.actor,
        entry.action,
        entry.outcome ?? "ok",
        entry.count ?? null,
        entry.note ?? null,
        entry.ref?.sealed ?? null,
        entry.ref?.ctx ?? null,
        entry.detail ?? null,
      );
  }

  /** One account's entries (or, with accountId null, the server's own: sign-ups, backups, failed logins). */
  read(accountId: string | null, options: { boxId?: string; limit?: number; before?: number } = {}): LogEntry[] {
    const limit = Math.min(500, Math.max(1, options.limit ?? 50));
    const where = [accountId === null ? "account_id IS NULL" : "account_id = ?"];
    const params: Array<string | number> = accountId === null ? [] : [accountId];
    if (options.boxId !== undefined) {
      where.push("box_id = ?");
      params.push(options.boxId);
    }
    if (options.before !== undefined) {
      where.push("id < ?");
      params.push(options.before);
    }
    const rows = this.db.prepare(`SELECT * FROM log WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?`).all(...params, limit) as unknown as LogRow[];
    return rows.map((row) => ({
      id: row.id,
      at: row.at,
      box: row.box_id,
      dock: row.dock_id,
      actor: row.actor,
      action: row.action,
      outcome: row.outcome,
      count: row.count,
      note: row.note,
      ref: row.ref && row.ref_ctx ? { sealed: b64(row.ref)!, ctx: row.ref_ctx } : null,
      detail: b64(row.detail),
    }));
  }

  lastActivity(boxId: string): number | null {
    const row = this.db.prepare("SELECT MAX(at) AS at FROM log WHERE box_id = ?").get(boxId) as { at: number | null };
    return row.at;
  }

  /** Denied entries for a box since `since`, optionally only (or never) for one action. */
  deniedSince(boxId: string, since: number, filter: { action?: string; excludeAction?: string } = {}): number {
    let sql = "SELECT COUNT(*) AS n FROM log WHERE box_id = ? AND at >= ? AND outcome = 'denied'";
    const params: Array<string | number> = [boxId, since];
    if (filter.action) {
      sql += " AND action = ?";
      params.push(filter.action);
    }
    if (filter.excludeAction) {
      sql += " AND action != ?";
      params.push(filter.excludeAction);
    }
    return (this.db.prepare(sql).get(...params) as { n: number }).n;
  }

  countSince(accountId: string | null, action: string, since: number): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM log WHERE ${accountId === null ? "account_id IS NULL" : "account_id = ?"} AND action = ? AND at >= ?`)
      .get(...(accountId === null ? [action, since] : [accountId, action, since])) as { n: number };
    return row.n;
  }

  /** Security events (recovery used, replayed sign-in codes) that every device should hear about. */
  alarmsSince(accountId: string, since: number): Array<{ at: number; text: string }> {
    const rows = this.db
      .prepare("SELECT at, note FROM log WHERE account_id = ? AND action IN ('recovered', 'alarm') AND at >= ? ORDER BY id DESC LIMIT 20")
      .all(accountId, since) as Array<{ at: number; note: string | null }>;
    return rows.map((r) => ({ at: r.at, text: r.note ?? "Something looked like an attack" }));
  }

  prune() {
    this.db.prepare("DELETE FROM log WHERE at < ?").run(this.now() - RETENTION_MS);
  }
}
