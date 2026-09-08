import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/api/server.js";
import type { Config } from "../src/config.js";
import { decodeEvent } from "../src/decode/eventDecoder.js";
import { IndexerDb } from "../src/db/index.js";
import { makeRawEvent, resetFixtureCounter, TEST_CONTRACT_ID } from "./helpers/fixtures.js";

function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    rpcUrl: "http://mock-rpc.local",
    networkPassphrase: "Test SDF Network ; September 2015",
    contractId: TEST_CONTRACT_ID,
    dbPath: ":memory:",
    pollIntervalMs: 1000,
    maxLedgersPerRequest: 1000,
    pageLimit: 200,
    retentionWindowLedgers: 100_000,
    startLedger: 1,
    apiPort: 0,
    apiMaxPageSize: 50,
    ...overrides,
  };
}

describe("API", () => {
  let db: IndexerDb;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    resetFixtureCounter();
    db = new IndexerDb(":memory:");
    app = createApp(db, testConfig());
  });

  it("GET /health reports indexing status", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, contractId: TEST_CONTRACT_ID, lastIndexedLedger: null, eventCount: 0 });

    db.setCheckpoint(42);
    const res2 = await request(app).get("/health");
    expect(res2.body.lastIndexedLedger).toBe(42);
  });

  it("GET /events/latest returns 404 when nothing indexed", async () => {
    const res = await request(app).get("/events/latest");
    expect(res.status).toBe(404);
  });

  it("GET /events supports type/from/to filters and pagination", async () => {
    db.insertEvent(decodeEvent(makeRawEvent({ ledger: 1, topics: ["transfer"] })));
    db.insertEvent(decodeEvent(makeRawEvent({ ledger: 2, topics: ["mint"] })));
    db.insertEvent(decodeEvent(makeRawEvent({ ledger: 3, topics: ["transfer"] })));
    db.insertEvent(decodeEvent(makeRawEvent({ ledger: 4, topics: ["transfer"] })));

    const byType = await request(app).get("/events?type=transfer");
    expect(byType.status).toBe(200);
    expect(byType.body.events.map((e: any) => e.ledger)).toEqual([4, 3, 1]);

    const byRange = await request(app).get("/events?from=2&to=3");
    expect(byRange.body.events.map((e: any) => e.ledger)).toEqual([3, 2]);

    const paged = await request(app).get("/events?limit=2");
    expect(paged.body.events).toHaveLength(2);
    expect(paged.body.pagination.nextCursor).not.toBeNull();

    const nextPage = await request(app).get(`/events?limit=2&cursor=${paged.body.pagination.nextCursor}`);
    expect(nextPage.body.events).toHaveLength(2);
  });

  it("GET /events/latest returns the most recent event, optionally filtered by type", async () => {
    db.insertEvent(decodeEvent(makeRawEvent({ ledger: 1, topics: ["transfer"] })));
    db.insertEvent(decodeEvent(makeRawEvent({ ledger: 2, topics: ["mint"] })));

    const latest = await request(app).get("/events/latest");
    expect(latest.body.event.eventType).toBe("mint");

    const latestTransfer = await request(app).get("/events/latest?type=transfer");
    expect(latestTransfer.body.event.ledger).toBe(1);
  });

  it("caps limit at apiMaxPageSize", async () => {
    for (let i = 1; i <= 5; i++) db.insertEvent(decodeEvent(makeRawEvent({ ledger: i })));
    const res = await request(app).get("/events?limit=99999");
    expect(res.body.pagination.limit).toBe(50); // apiMaxPageSize in testConfig
  });

  it("rejects non-integer from/to/cursor", async () => {
    const res = await request(app).get("/events?from=not-a-number");
    expect(res.status).toBe(400);
  });

  it("GET /gaps and /malformed-events reflect what's stored", async () => {
    db.insertGap({ fromLedger: 1, toLedger: 5, reason: "pruned" });
    db.insertMalformedEvent({ pagingToken: null, ledger: 3, reason: "bad xdr", raw: "{}" });

    const gaps = await request(app).get("/gaps");
    expect(gaps.body.gaps).toHaveLength(1);

    const malformed = await request(app).get("/malformed-events");
    expect(malformed.body.malformedEvents).toHaveLength(1);
  });

  it("serves the dashboard at /", async () => {
    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(res.text).toContain("Soroban Event Indexer");
  });
});
