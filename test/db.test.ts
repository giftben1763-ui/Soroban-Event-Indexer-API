import { beforeEach, describe, expect, it } from "vitest";
import { IndexerDb } from "../src/db/index.js";
import { decodeEvent } from "../src/decode/eventDecoder.js";
import { makeRawEvent, resetFixtureCounter } from "./helpers/fixtures.js";

describe("IndexerDb", () => {
  let db: IndexerDb;

  beforeEach(() => {
    resetFixtureCounter();
    db = new IndexerDb(":memory:");
  });

  it("returns null checkpoint before anything is set", () => {
    expect(db.getCheckpoint()).toBeNull();
  });

  it("upserts the checkpoint", () => {
    db.setCheckpoint(100);
    expect(db.getCheckpoint()?.lastLedger).toBe(100);
    db.setCheckpoint(200);
    expect(db.getCheckpoint()?.lastLedger).toBe(200);
  });

  it("paginates with a keyset cursor, newest first by default", () => {
    for (let i = 1; i <= 5; i++) {
      db.insertEvent(decodeEvent(makeRawEvent({ ledger: i })));
    }
    const page1 = db.queryEvents({ limit: 2 });
    expect(page1.rows.map((r) => r.ledger)).toEqual([5, 4]);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = db.queryEvents({ limit: 2, cursor: page1.nextCursor! });
    expect(page2.rows.map((r) => r.ledger)).toEqual([3, 2]);

    const page3 = db.queryEvents({ limit: 2, cursor: page2.nextCursor! });
    expect(page3.rows.map((r) => r.ledger)).toEqual([1]);
    expect(page3.nextCursor).toBeNull();
  });

  it("filters by type and ledger range", () => {
    db.insertEvent(decodeEvent(makeRawEvent({ ledger: 1, topics: ["transfer"] })));
    db.insertEvent(decodeEvent(makeRawEvent({ ledger: 2, topics: ["mint"] })));
    db.insertEvent(decodeEvent(makeRawEvent({ ledger: 3, topics: ["transfer"] })));

    expect(db.queryEvents({ limit: 10, type: "transfer" }).rows.map((r) => r.ledger)).toEqual([3, 1]);
    expect(db.queryEvents({ limit: 10, fromLedger: 2, toLedger: 3 }).rows.map((r) => r.ledger)).toEqual([3, 2]);
  });

  it("round-trips bigint values as decimal strings", () => {
    db.insertEvent(decodeEvent(makeRawEvent({ ledger: 1, value: { amount: 9007199254740993n } })));
    const row = db.getLatestEvent();
    expect(row?.value).toEqual({ amount: "9007199254740993" });
  });

  it("records and lists gaps and malformed events", () => {
    db.insertGap({ fromLedger: 10, toLedger: 20, reason: "pruned" });
    expect(db.listGaps()).toHaveLength(1);

    db.insertMalformedEvent({ pagingToken: "5-0", ledger: 5, reason: "bad xdr", raw: "{}" });
    expect(db.listMalformedEvents()).toHaveLength(1);
  });
});
