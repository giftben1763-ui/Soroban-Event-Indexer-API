import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import type { DecodedEvent } from "../decode/eventDecoder.js";
import { safeParse, safeStringify } from "../util/json.js";
import { SCHEMA } from "./schema.js";

export interface Checkpoint {
  lastLedger: number;
  updatedAt: string;
}

export interface Gap {
  fromLedger: number;
  toLedger: number;
  reason: string;
}

export interface GapRecord extends Gap {
  id: number;
  detectedAt: string;
}

export interface MalformedEventInput {
  pagingToken: string | null;
  ledger: number | null;
  reason: string;
  raw: string;
}

export interface MalformedEventRecord extends MalformedEventInput {
  id: number;
  detectedAt: string;
}

export interface EventRow {
  id: number;
  pagingToken: string;
  ledger: number;
  ledgerClosedAt: string | null;
  contractId: string;
  eventType: string | null;
  topics: unknown[];
  value: unknown;
  txHash: string | null;
  createdAt: string;
}

export interface EventQuery {
  type?: string;
  contractId?: string;
  fromLedger?: number;
  toLedger?: number;
  limit: number;
  /** Keyset pagination cursor: an event `id` returned as `nextCursor` from a previous page. */
  cursor?: number;
  order?: "asc" | "desc";
}

export interface EventPage {
  rows: EventRow[];
  nextCursor: number | null;
}

interface EventRawRow {
  id: number;
  paging_token: string;
  ledger: number;
  ledger_closed_at: string | null;
  contract_id: string;
  event_type: string | null;
  topics: string;
  value: string;
  tx_hash: string | null;
  created_at: string;
}

function mapEventRow(row: EventRawRow): EventRow {
  return {
    id: row.id,
    pagingToken: row.paging_token,
    ledger: row.ledger,
    ledgerClosedAt: row.ledger_closed_at,
    contractId: row.contract_id,
    eventType: row.event_type,
    topics: safeParse(row.topics),
    value: safeParse(row.value),
    txHash: row.tx_hash,
    createdAt: row.created_at,
  };
}

/**
 * All persistence for the indexer. A thin wrapper over a single SQLite file
 * (WAL mode: one writer, many concurrent readers — see README "Limitations").
 */
export class IndexerDb {
  readonly raw: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      const dir = path.dirname(dbPath);
      if (dir && dir !== ".") fs.mkdirSync(dir, { recursive: true });
    }
    this.raw = new Database(dbPath);
    this.raw.pragma("journal_mode = WAL");
    this.raw.pragma("foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    this.raw.exec(SCHEMA);
  }

  getCheckpoint(): Checkpoint | null {
    const row = this.raw
      .prepare("SELECT last_ledger AS lastLedger, updated_at AS updatedAt FROM checkpoint WHERE id = 1")
      .get() as Checkpoint | undefined;
    return row ?? null;
  }

  setCheckpoint(lastLedger: number): void {
    this.raw
      .prepare(
        `INSERT INTO checkpoint (id, last_ledger, updated_at) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET last_ledger = excluded.last_ledger, updated_at = excluded.updated_at`,
      )
      .run(lastLedger, new Date().toISOString());
  }

  /** Returns true if a new row was inserted (false if it was a duplicate, i.e. already indexed). */
  insertEvent(e: DecodedEvent): boolean {
    const info = this.raw
      .prepare(
        `INSERT OR IGNORE INTO events
           (paging_token, ledger, ledger_closed_at, contract_id, event_type, topics, value, tx_hash, raw, created_at)
         VALUES (@pagingToken, @ledger, @ledgerClosedAt, @contractId, @eventType, @topics, @value, @txHash, @raw, @createdAt)`,
      )
      .run({
        pagingToken: e.pagingToken,
        ledger: e.ledger,
        ledgerClosedAt: e.ledgerClosedAt,
        contractId: e.contractId,
        eventType: e.eventType,
        topics: safeStringify(e.topics),
        value: safeStringify(e.value),
        txHash: e.txHash,
        raw: safeStringify(e.raw),
        createdAt: new Date().toISOString(),
      });
    return info.changes > 0;
  }

  insertGap(gap: Gap): void {
    this.raw
      .prepare("INSERT INTO gaps (from_ledger, to_ledger, reason, detected_at) VALUES (?, ?, ?, ?)")
      .run(gap.fromLedger, gap.toLedger, gap.reason, new Date().toISOString());
  }

  listGaps(limit = 50): GapRecord[] {
    const rows = this.raw
      .prepare(
        "SELECT id, from_ledger AS fromLedger, to_ledger AS toLedger, reason, detected_at AS detectedAt FROM gaps ORDER BY id DESC LIMIT ?",
      )
      .all(limit) as GapRecord[];
    return rows;
  }

  insertMalformedEvent(m: MalformedEventInput): void {
    this.raw
      .prepare(
        "INSERT INTO malformed_events (paging_token, ledger, reason, raw, detected_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(m.pagingToken, m.ledger, m.reason, m.raw, new Date().toISOString());
  }

  listMalformedEvents(limit = 50): MalformedEventRecord[] {
    const rows = this.raw
      .prepare(
        "SELECT id, paging_token AS pagingToken, ledger, reason, raw, detected_at AS detectedAt FROM malformed_events ORDER BY id DESC LIMIT ?",
      )
      .all(limit) as MalformedEventRecord[];
    return rows;
  }

  queryEvents(q: EventQuery): EventPage {
    const clauses: string[] = [];
    const params: Record<string, unknown> = { limit: q.limit };

    if (q.type) {
      clauses.push("event_type = @type");
      params.type = q.type;
    }
    if (q.contractId) {
      clauses.push("contract_id = @contractId");
      params.contractId = q.contractId;
    }
    if (q.fromLedger !== undefined) {
      clauses.push("ledger >= @fromLedger");
      params.fromLedger = q.fromLedger;
    }
    if (q.toLedger !== undefined) {
      clauses.push("ledger <= @toLedger");
      params.toLedger = q.toLedger;
    }

    const order = q.order === "asc" ? "ASC" : "DESC";
    if (q.cursor !== undefined) {
      clauses.push(order === "DESC" ? "id < @cursor" : "id > @cursor");
      params.cursor = q.cursor;
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const sql = `SELECT * FROM events ${where} ORDER BY id ${order} LIMIT @limit`;
    const rows = (this.raw.prepare(sql).all(params) as EventRawRow[]).map(mapEventRow);
    const nextCursor = rows.length === q.limit ? rows[rows.length - 1].id : null;
    return { rows, nextCursor };
  }

  getLatestEvent(opts: { type?: string; contractId?: string } = {}): EventRow | null {
    const page = this.queryEvents({ ...opts, limit: 1, order: "desc" });
    return page.rows[0] ?? null;
  }

  countEvents(): number {
    return (this.raw.prepare("SELECT COUNT(*) AS c FROM events").get() as { c: number }).c;
  }

  close(): void {
    this.raw.close();
  }
}
