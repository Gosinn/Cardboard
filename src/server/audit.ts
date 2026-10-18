import type { DB } from "./db.ts";
import type { Tapes } from "./tapes.ts";
import type { Vault } from "./vault.ts";

export type Outcome = "ok" | "denied" | "error";

export interface LogDetail {
  key?: string;
  prefix?: string;
  count?: number;
  ip?: string;
  note?: string;
  name?: string;
  label?: string;
}

export interface LogEntry {
  id: number;
  at: number;
  box: string | null;
  actor: string;
  who: string;
  action: string;
  outcome: Outcome;
  detail: LogDetail;
  text: string;
}

const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

interface LogRow {
  id: number;
  box_id: string | null;
  at: number;
  actor: string;
  action: string;
  outcome: Outcome;
  detail_enc: Uint8Array | null;
}

/**
 * The packing slip: who touched what, when. Actions are stored in the clear so
 * they can be counted; details (key names, IPs) are encrypted with the box's
 * own key, so shredding a box also shreds its history of access.
 */
export class Audit {
  private readonly db: DB;
  private readonly vault: Vault;
  private readonly tapes: Tapes;
  /** Names actors this module doesn't know about (e.g. "grant:…" for AI assistants). */
  resolveActor: (actor: string) => string | null = () => null;

  constructor(db: DB, vault: Vault, tapes: Tapes) {
    this.db = db;
    this.vault = vault;
    this.tapes = tapes;
  }

  record(boxId: string | null, actor: string, action: string, outcome: Outcome, detail: LogDetail = {}) {
    const clean = Object.fromEntries(Object.entries(detail).filter(([, v]) => v !== undefined && v !== ""));
    const sealed = Object.keys(clean).length > 0 ? this.vault.sealDetail(boxId, clean) : null;
    this.db
      .prepare("INSERT INTO log (box_id, at, actor, action, outcome, detail_enc) VALUES (?, ?, ?, ?, ?, ?)")
      .run(boxId, this.vault.now(), actor, action, outcome, sealed);
  }

  /** `boxId: undefined` reads everything; `null` reads only system entries. */
  read(options: { boxId?: string | null; limit?: number; before?: number } = {}): LogEntry[] {
    const limit = Math.min(500, Math.max(1, options.limit ?? 50));
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (options.boxId === null) where.push("box_id IS NULL");
    else if (options.boxId !== undefined) {
      where.push("box_id = ?");
      params.push(options.boxId);
    }
    if (options.before !== undefined) {
      where.push("id < ?");
      params.push(options.before);
    }
    const rows = this.db
      .prepare(`SELECT * FROM log ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`)
      .all(...params, limit) as unknown as LogRow[];

    const boxNames = new Map<string, string>();
    const boxName = (id: string | null) => {
      if (!id) return null;
      if (!boxNames.has(id)) boxNames.set(id, this.vault.getBox(id)?.name ?? "(shredded box)");
      return boxNames.get(id)!;
    };
    return rows.map((row) => {
      let detail: LogDetail = {};
      let readable = true;
      if (row.detail_enc) {
        try {
          detail = this.vault.openDetail(row.box_id, row.detail_enc) as LogDetail;
        } catch {
          readable = false;
        }
      }
      const box = boxName(row.box_id);
      const who = this.describeActor(row.actor, box);
      return {
        id: row.id,
        at: row.at,
        box,
        actor: row.actor,
        who,
        action: row.action,
        outcome: row.outcome,
        detail,
        text: readable ? describe(who, row.action, row.outcome, detail, box) : `${who} did something (entry unreadable)`,
      };
    });
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

  counts(boxId: string, since: number): { ok: number; denied: number } {
    const rows = this.db
      .prepare("SELECT outcome, COUNT(*) AS n FROM log WHERE box_id = ? AND at >= ? GROUP BY outcome")
      .all(boxId, since) as Array<{ outcome: Outcome; n: number }>;
    return {
      ok: rows.find((r) => r.outcome === "ok")?.n ?? 0,
      denied: rows.find((r) => r.outcome === "denied")?.n ?? 0,
    };
  }

  prune() {
    this.db.prepare("DELETE FROM log WHERE at < ?").run(this.vault.now() - RETENTION_MS);
  }

  private describeActor(actor: string, box: string | null): string {
    if (actor === "owner") return "You";
    if (actor === "system") return "Cardboard";
    if (actor === "anonymous") return "Someone without a valid tape";
    const resolved = this.resolveActor(actor);
    if (resolved) return resolved;
    if (actor.startsWith("tape:")) {
      const tape = this.tapes.get(actor.slice(5));
      if (!tape) return "A tape that no longer exists";
      return `${box ?? "An app"} (tape “${tape.label}”)`;
    }
    return actor;
  }
}

function describe(who: string, action: string, outcome: Outcome, d: LogDetail, box: string | null): string {
  const key = d.key ? `“${d.key}”` : "";
  const where = d.prefix ? `under “${d.prefix}”` : `in ${box ?? "the box"}`;
  const count = (n: number | undefined, word: string) => `${n ?? 0} ${word}${n === 1 ? "" : "s"}`;
  const dock = d.name ? `dock “${d.name}”` : "a dock";
  if (action === "app.alarm") return `Security: ${d.note ?? "something looked like an attack"}`;
  if (outcome === "denied" && action === "dock.customs") return `Customs stopped a parcel from ${who} on ${dock}: ${d.note ?? ""}`.trim();
  if (outcome === "denied") {
    return `${who} was blocked${action !== "auth" ? ` (${action}${key ? ` ${key}` : ""})` : ""}: ${d.note ?? "not allowed"}`;
  }
  if (outcome === "error") return `${who} hit an error (${action}${key ? ` ${key}` : ""}): ${d.note ?? "unknown error"}`;
  switch (action) {
    case "read":
      return `${who} read ${key}`;
    case "put":
      return `${who} saved ${key}`;
    case "patch":
      return `${who} updated ${key}`;
    case "add":
      return `${who} added ${key}`;
    case "delete":
      return `${who} deleted ${key}`;
    case "purge":
      return `${who} permanently deleted ${key} and its history`;
    case "list":
      return `${who} listed ${count(d.count, "key")} ${where}`;
    case "query":
      return `${who} searched ${where} and got ${count(d.count, "result")}`;
    case "history":
      return `${who} looked at the history of ${key}`;
    case "undo":
      return `${who} undid a change to ${key}`;
    case "batch":
      return `${who} made ${count(d.count, "change")} in one go`;
    case "watch":
      return `${who} started watching ${where}`;
    case "sensitive":
      return `${who} stored something sensitive at ${key}: ${d.note ?? ""}`.trim();
    case "expire":
      return `${count(d.count, "item")} in ${box ?? "a box"} expired and were deleted for good`;
    case "box.create":
      return `${who} created the box ${d.name ?? box ?? ""}`;
    case "box.shred":
      return `${who} shredded the box ${d.name ?? ""}`;
    case "box.settings":
      return `${who} changed the settings of ${box}`;
    case "box.rewind":
      return `${who} rewound ${box} (${count(d.count, "key")} changed)${d.note ? ` to ${d.note}` : ""}`;
    case "box.export":
      return `${who} exported ${box} (${count(d.count, "item")})`;
    case "box.import":
      return `${who} imported ${count(d.count, "item")} into ${box}`;
    case "box.read":
      return `${who} opened ${key}`;
    case "tape.create":
      return `${who} made a new tape “${d.label ?? ""}”${d.prefix ? ` limited to “${d.prefix}”` : ""}`;
    case "tape.revoke":
      return `${who} revoked the tape “${d.label ?? ""}”`;
    case "search":
      return `${who} searched every box`;
    case "introduce":
      return `${who} introduced itself as “${d.name ?? ""}”`;
    case "dock.request":
      return `${who} asked to ${d.note ?? "dock"} on ${dock}`;
    case "dock.send":
      return `${who} sent a parcel on ${dock} (to ${count(d.count, "app")})`;
    case "dock.receive":
      return `${who} picked up ${count(d.count, "parcel")} from ${dock}`;
    case "dock.watch":
      return `${who} started listening on ${dock}`;
    case "dock.create":
      return `${who} opened ${dock}`;
    case "dock.grant":
      return `${who} let ${box ?? "an app"} ${d.note ?? "dock"} on ${dock}`;
    case "dock.approve":
      return `${who} approved ${box ?? "an app"} to ${d.note ?? "dock"} on ${dock}`;
    case "dock.deny":
      return `${who} refused ${box ?? "an app"} on ${dock}`;
    case "dock.remove":
      return `${who} took ${box ?? "an app"} off ${dock}`;
    case "dock.settings":
      return `${who} changed the settings of ${dock}`;
    case "dock.peek":
      return `${who} looked inside ${dock}`;
    case "dock.shred":
      return `${who} shredded ${dock}`;
    case "backup":
      return `${who} made an encrypted backup`;
    case "session":
      return `${who} signed in to Cardboard in a browser`;
    case "app.register":
      return `${d.name ?? "An app"} registered with Cardboard (${d.note ?? ""})`;
    case "app.connect":
      return `${who} let ${d.name ?? "an app"} in (${d.note ?? ""})`;
    case "app.deny":
      return `${who} turned down ${d.name ?? "an app"}`;
    case "app.disconnect":
      return `${who} disconnected ${d.name ?? "an app"}${d.note ? ` ${d.note}` : ""}`;
    case "app.share":
      return `${who} changed what ${d.name ?? "an assistant"} can see: ${d.note ?? ""}`;
    case "app.forget":
      return `${who} forgot the app ${d.name ?? ""}`;
    default:
      return `${who}: ${action}${key ? ` ${key}` : ""}`;
  }
}
