import { beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { IndexerDb } from "../src/db/index.js";
import { indexOnce } from "../src/indexer/worker.js";
import { SorobanRpcClient } from "../src/rpc/sorobanRpcClient.js";
import { silentLogger } from "../src/logger.js";
import { makeRawEvent, resetFixtureCounter, TEST_CONTRACT_ID } from "./helpers/fixtures.js";
import { createMockFetch, type RpcHandler } from "./helpers/mockRpc.js";

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
    apiMaxPageSize: 200,
    ...overrides,
  };
}

describe("indexOnce - normal indexing", () => {
  let db: IndexerDb;

  beforeEach(() => {
    resetFixtureCounter();
    db = new IndexerDb(":memory:");
  });

  it("indexes events from a cold start (no checkpoint)", async () => {
    const config = testConfig();
    const handler: RpcHandler = (method, params) => {
      if (method === "getLatestLedger") return { id: "l", protocolVersion: 21, sequence: 50 };
      if (method === "getEvents") {
        expect(params.startLedger).toBe(1);
        return {
          latestLedger: 50,
          oldestLedger: 1,
          events: [
            makeRawEvent({ ledger: 5, topics: ["transfer"], value: { amount: 10n } }),
            makeRawEvent({ ledger: 6, topics: ["mint"], value: { amount: 20n } }),
          ],
        };
      }
      throw new Error(`unexpected method ${method}`);
    };
    const rpc = new SorobanRpcClient(config.rpcUrl, createMockFetch(handler));

    const result = await indexOnce({ rpc, db, config, logger: silentLogger });

    expect(result.upToDate).toBe(false);
    expect(result.eventsInserted).toBe(2);
    expect(result.malformed).toBe(0);
    expect(result.endLedger).toBe(50);
    expect(db.countEvents()).toBe(2);
    expect(db.getCheckpoint()?.lastLedger).toBe(50);

    const latest = db.getLatestEvent();
    expect(latest?.eventType).toBe("mint");
    expect(latest?.value).toEqual({ amount: "20" });
  });

  it("is idempotent: re-running with the same chain tip finds nothing new", async () => {
    const config = testConfig();
    const handler: RpcHandler = (method, params) => {
      if (method === "getLatestLedger") return { id: "l", protocolVersion: 21, sequence: 50 };
      if (method === "getEvents") {
        return {
          latestLedger: 50,
          oldestLedger: 1,
          events: [makeRawEvent({ ledger: 10 })],
        };
      }
      throw new Error("unexpected");
    };
    const rpc = new SorobanRpcClient(config.rpcUrl, createMockFetch(handler));

    await indexOnce({ rpc, db, config, logger: silentLogger });
    expect(db.countEvents()).toBe(1);

    const second = await indexOnce({ rpc, db, config, logger: silentLogger });
    expect(second.upToDate).toBe(true);
    expect(db.countEvents()).toBe(1); // unchanged
  });

  it("picks up new ledgers on subsequent cycles (checkpoint advances)", async () => {
    const config = testConfig();
    let latestLedger = 50;
    const handler: RpcHandler = (method, params) => {
      if (method === "getLatestLedger") return { id: "l", protocolVersion: 21, sequence: latestLedger };
      if (method === "getEvents") {
        if (params.startLedger === 1) {
          return { latestLedger, oldestLedger: 1, events: [makeRawEvent({ ledger: 5 })] };
        }
        if (params.startLedger === 51) {
          return { latestLedger, oldestLedger: 1, events: [makeRawEvent({ ledger: 55 })] };
        }
        return { latestLedger, oldestLedger: 1, events: [] };
      }
      throw new Error("unexpected");
    };
    const rpc = new SorobanRpcClient(config.rpcUrl, createMockFetch(handler));

    await indexOnce({ rpc, db, config, logger: silentLogger });
    expect(db.countEvents()).toBe(1);

    latestLedger = 60;
    const second = await indexOnce({ rpc, db, config, logger: silentLogger });
    expect(second.startLedger).toBe(51);
    expect(second.eventsInserted).toBe(1);
    expect(db.countEvents()).toBe(2);
  });

  it("pages through results using the last event's pagingToken as cursor", async () => {
    const config = testConfig({ pageLimit: 2 });
    const allEvents = [
      makeRawEvent({ ledger: 5 }),
      makeRawEvent({ ledger: 6 }),
      makeRawEvent({ ledger: 7 }),
      makeRawEvent({ ledger: 8 }),
      makeRawEvent({ ledger: 9 }),
    ];
    const seenCursors: (string | undefined)[] = [];
    const handler: RpcHandler = (method, params) => {
      if (method === "getLatestLedger") return { id: "l", protocolVersion: 21, sequence: 50 };
      if (method === "getEvents") {
        const cursor: string | undefined = params.pagination?.cursor;
        seenCursors.push(cursor);
        const startIdx = cursor ? allEvents.findIndex((e) => e.pagingToken === cursor) + 1 : 0;
        const page = allEvents.slice(startIdx, startIdx + 2);
        return { latestLedger: 50, oldestLedger: 1, events: page };
      }
      throw new Error("unexpected");
    };
    const rpc = new SorobanRpcClient(config.rpcUrl, createMockFetch(handler));

    const result = await indexOnce({ rpc, db, config, logger: silentLogger });

    expect(result.eventsInserted).toBe(5);
    expect(result.pagesFetched).toBe(3); // 2 + 2 + 1
    expect(db.countEvents()).toBe(5);
    expect(seenCursors[0]).toBeUndefined();
    expect(seenCursors[1]).toBe(allEvents[1].pagingToken);
    expect(seenCursors[2]).toBe(allEvents[3].pagingToken);
  });

  it("resumes from the persisted checkpoint after a restart", async () => {
    const config = testConfig();
    const handler: RpcHandler = (method, params) => {
      if (method === "getLatestLedger") return { id: "l", protocolVersion: 21, sequence: 50 };
      if (method === "getEvents") {
        expect(params.startLedger).toBe(1);
        return { latestLedger: 50, oldestLedger: 1, events: [makeRawEvent({ ledger: 20 })] };
      }
      throw new Error("unexpected");
    };
    const rpc = new SorobanRpcClient(config.rpcUrl, createMockFetch(handler));
    await indexOnce({ rpc, db, config, logger: silentLogger });
    expect(db.getCheckpoint()?.lastLedger).toBe(50);

    // Simulate a restart: a fresh worker run must not re-request ledger 1,
    // it should continue from the checkpoint the previous process wrote.
    const handler2: RpcHandler = (method, params) => {
      if (method === "getLatestLedger") return { id: "l", protocolVersion: 21, sequence: 80 };
      if (method === "getEvents") {
        expect(params.startLedger).toBe(51);
        return { latestLedger: 80, oldestLedger: 1, events: [] };
      }
      throw new Error("unexpected");
    };
    const rpc2 = new SorobanRpcClient(config.rpcUrl, createMockFetch(handler2));
    const result = await indexOnce({ rpc: rpc2, db, config, logger: silentLogger });
    expect(result.startLedger).toBe(51);
    expect(result.endLedger).toBe(80);
  });
});
