import { nativeToScVal } from "@stellar/stellar-sdk";
import type { RawEvent } from "../../src/rpc/types.js";

export const TEST_CONTRACT_ID = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

let counter = 0;

/** Builds a well-formed raw Soroban RPC event, with real base64 XDR topics/value. */
export function makeRawEvent(opts: {
  ledger: number;
  contractId?: string;
  topics?: unknown[];
  value?: unknown;
  txHash?: string;
  index?: number;
}): RawEvent {
  const index = opts.index ?? counter++;
  const topics = opts.topics ?? ["transfer"];
  const value = opts.value ?? { amount: 100n, from: "alice", to: "bob" };
  return {
    type: "contract",
    ledger: opts.ledger,
    ledgerClosedAt: new Date(opts.ledger * 5000).toISOString(),
    contractId: opts.contractId ?? TEST_CONTRACT_ID,
    id: `${opts.ledger}-${index}`,
    pagingToken: `${opts.ledger}-${index}`,
    inSuccessfulContractCall: true,
    topic: topics.map(encodeScVal),
    value: encodeScVal(value),
    txHash: opts.txHash ?? String(opts.ledger).padStart(8, "0").repeat(8).slice(0, 64),
  };
}

function encodeScVal(v: unknown): string {
  return nativeToScVal(v as never).toXDR("base64");
}

export function resetFixtureCounter(): void {
  counter = 0;
}
