import { beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { IndexerDb } from "../src/db/index.js";
import { indexOnce } from "../src/indexer/worker.js";
import { silentLogger } from "../src/logger.js";
import { SorobanRpcClient } from "../src/rpc/sorobanRpcClient.js";
import { RpcError } from "../src/rpc/types.js";
import { makeRawEvent, resetFixtureCounter, TEST_CONTRACT_ID } from "./helpers/fixtures.js";
import { createFailingFetch, createMockFetch, type RpcHandler } from "./helpers/mockRpc.js";

function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    rpcUrl: "http://mock-rpc.local",
    networkPassphrase: "Test SDF Network ; September 2015",
    contractId: TEST_CONTRACT_ID,
    dbPath: ":memory:",
    pollIntervalMs: 1000,
    maxLedgersPerRequest: 1000,
    pageLimit: 200,
    retentionWindowLedgers: 20,
    startLedger: 1,
    apiPort: 0,
    apiMaxPageSize: 200,
    ...overrides,
  };
}

describe("indexOnce - gap detection and recovery", () => {
  let db: IndexerDb;

  beforeEach(() => {
    resetFixtureCounter();
    db = new IndexerDb(":memory:");
  });

  it("detects a checkpoint that has fallen behind the RPC retention window, logs it, and jumps forward", async () => {
    const config = testConfig({ retentionWindowLedgers: 20 });
    db.setCheckpoint(10); // indexer was down a long time; chain has moved far ahead

    const handler: RpcHandler = (method, params) => {
      if (method === "getLatestLedger") return { id: "l", protocolVersion: 21, sequence: 1000 };
      if (method === "getEvents") {
        // oldestSafe = 1000 - 20 + 1 = 981
        expect(params.startLedger).toBe(981);
        return { latestLedger: 1000, oldestLedger: 981, events: [makeRawEvent({ ledger: 990 })] };
      }
      throw new Error("unexpected");
    };
    const rpc = new SorobanRpcClient(config.rpcUrl, createMockFetch(handler));

    const result = await indexOnce({ rpc, db, config, logger: silentLogger });

    expect(result.gapDetected).toEqual({
      fromLedger: 11,
      toLedger: 980,
      reason: expect.stringContaining("retention window"),
    });
    expect(result.startLedger).toBe(981);
    expect(result.eventsInserted).toBe(1);

    const gaps = db.listGaps();
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ fromLedger: 11, toLedger: 980 });

    expect(db.getCheckpoint()?.lastLedger).toBe(1000);
  });

  it("does not report a gap when the checkpoint is within the retention window", async () => {
    const config = testConfig({ retentionWindowLedgers: 20 });
    db.setCheckpoint(995); // only slightly behind

    const handler: RpcHandler = (method) => {
      if (method === "getLatestLedger") return { id: "l", protocolVersion: 21, sequence: 1000 };
      if (method === "getEvents") return { latestLedger: 1000, oldestLedger: 981, events: [] };
      throw new Error("unexpected");
    };
    const rpc = new SorobanRpcClient(config.rpcUrl, createMockFetch(handler));

    const result = await indexOnce({ rpc, db, config, logger: silentLogger });

    expect(result.gapDetected).toBeNull();
    expect(db.listGaps()).toHaveLength(0);
    expect(result.startLedger).toBe(996);
  });

  it("recovers cleanly on the cycle after a gap: no repeated gap logging", async () => {
    const config = testConfig({ retentionWindowLedgers: 20 });
    db.setCheckpoint(10);

    const handler1: RpcHandler = (method) => {
      if (method === "getLatestLedger") return { id: "l", protocolVersion: 21, sequence: 1000 };
      if (method === "getEvents") return { latestLedger: 1000, oldestLedger: 981, events: [] };
      throw new Error("unexpected");
    };
    await indexOnce({ rpc: new SorobanRpcClient(config.rpcUrl, createMockFetch(handler1)), db, config, logger: silentLogger });
    expect(db.listGaps()).toHaveLength(1);
    expect(db.getCheckpoint()?.lastLedger).toBe(1000);

    const handler2: RpcHandler = (method, params) => {
      if (method === "getLatestLedger") return { id: "l", protocolVersion: 21, sequence: 1010 };
      if (method === "getEvents") {
        expect(params.startLedger).toBe(1001);
        return { latestLedger: 1010, oldestLedger: 990, events: [] };
      }
      throw new Error("unexpected");
    };
    const result2 = await indexOnce({ rpc: new SorobanRpcClient(config.rpcUrl, createMockFetch(handler2)), db, config, logger: silentLogger });

    expect(result2.gapDetected).toBeNull();
    expect(db.listGaps()).toHaveLength(1); // still just the one gap from before
  });

  it("propagates RPC/network failures without corrupting the checkpoint (safe to retry)", async () => {
    const config = testConfig();
    db.setCheckpoint(10);
    const rpc = new SorobanRpcClient(config.rpcUrl, createFailingFetch("ECONNREFUSED"));

    await expect(indexOnce({ rpc, db, config, logger: silentLogger })).rejects.toThrow(RpcError);
    expect(db.getCheckpoint()?.lastLedger).toBe(10); // untouched
  });

  it("propagates JSON-RPC error responses from getEvents without crashing the caller", async () => {
    const config = testConfig();
    db.setCheckpoint(10);
    const handler: RpcHandler = (method) => {
      if (method === "getLatestLedger") return { id: "l", protocolVersion: 21, sequence: 20 };
      if (method === "getEvents") {
        const err: Error & { code?: number } = new Error("start ledger must be within the ledger range: 5 - 20");
        err.code = -32600;
        throw err;
      }
      throw new Error("unexpected");
    };
    const rpc = new SorobanRpcClient(config.rpcUrl, createMockFetch(handler));

    await expect(indexOnce({ rpc, db, config, logger: silentLogger })).rejects.toThrow(/ledger range/);
    expect(db.getCheckpoint()?.lastLedger).toBe(10); // no partial progress recorded
  });
});
