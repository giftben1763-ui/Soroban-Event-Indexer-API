import { beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { IndexerDb } from "../src/db/index.js";
import { indexOnce } from "../src/indexer/worker.js";
import { silentLogger } from "../src/logger.js";
import { SorobanRpcClient } from "../src/rpc/sorobanRpcClient.js";
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

describe("indexOnce - malformed event handling", () => {
  let db: IndexerDb;

  beforeEach(() => {
    resetFixtureCounter();
    db = new IndexerDb(":memory:");
  });

  it("skips malformed events, keeps good ones, and doesn't crash the cycle", async () => {
    const config = testConfig();
    const good1 = makeRawEvent({ ledger: 5, topics: ["transfer"] });
    const good2 = makeRawEvent({ ledger: 6, topics: ["mint"] });
    const missingContractId = { ...makeRawEvent({ ledger: 7 }), contractId: "" };
    const badTopicXdr = { ...makeRawEvent({ ledger: 8 }), topic: ["not-valid-base64-xdr!!!"] };
    const badValueType = { ...makeRawEvent({ ledger: 9 }), value: 12345 as unknown as string };
    const nullEvent = null;

    const handler: RpcHandler = (method) => {
      if (method === "getLatestLedger") return { id: "l", protocolVersion: 21, sequence: 50 };
      if (method === "getEvents") {
        return {
          latestLedger: 50,
          oldestLedger: 1,
          events: [good1, missingContractId, good2, badTopicXdr, badValueType, nullEvent],
        };
      }
      throw new Error("unexpected");
    };
    const rpc = new SorobanRpcClient(config.rpcUrl, createMockFetch(handler));

    const result = await indexOnce({ rpc, db, config, logger: silentLogger });

    expect(result.eventsInserted).toBe(2);
    expect(result.malformed).toBe(4);
    expect(db.countEvents()).toBe(2);
    expect(db.getCheckpoint()?.lastLedger).toBe(50); // cycle still completes and advances

    const malformed = db.listMalformedEvents();
    expect(malformed).toHaveLength(4);
    expect(malformed.map((m) => m.reason).join(" | ")).toMatch(/contractId/);
    expect(malformed.map((m) => m.reason).join(" | ")).toMatch(/topic/i);
    expect(malformed.map((m) => m.reason).join(" | ")).toMatch(/value/i);

    const types = db.queryEvents({ limit: 10 }).rows.map((r) => r.eventType);
    expect(types.sort()).toEqual(["mint", "transfer"]);
  });

  it("does not let a duplicate pagingToken silently overwrite or double-count", async () => {
    const config = testConfig();
    const event = makeRawEvent({ ledger: 5 });
    const handler: RpcHandler = (method) => {
      if (method === "getLatestLedger") return { id: "l", protocolVersion: 21, sequence: 50 };
      if (method === "getEvents") return { latestLedger: 50, oldestLedger: 1, events: [event, event] };
      throw new Error("unexpected");
    };
    const rpc = new SorobanRpcClient(config.rpcUrl, createMockFetch(handler));

    const result = await indexOnce({ rpc, db, config, logger: silentLogger });

    expect(result.eventsInserted).toBe(1);
    expect(result.eventsDuplicate).toBe(1);
    expect(db.countEvents()).toBe(1);
  });
});
