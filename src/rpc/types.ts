/**
 * Minimal typings for the subset of the Soroban RPC JSON-RPC API we use.
 * See: https://developers.stellar.org/docs/data/rpc/api-reference/methods/getEvents
 */

export interface RawEvent {
  type: "contract" | "system" | "diagnostic";
  ledger: number;
  ledgerClosedAt: string;
  contractId: string;
  id: string;
  pagingToken: string;
  inSuccessfulContractCall?: boolean;
  topic: string[]; // base64-encoded XDR ScVal
  value: string; // base64-encoded XDR ScVal
  txHash?: string;
  opIndex?: number;
  txIndex?: number;
}

export interface GetEventsResult {
  latestLedger: number;
  oldestLedger: number;
  latestLedgerCloseTime?: string;
  oldestLedgerCloseTime?: string;
  events: RawEvent[];
  cursor?: string;
}

export interface GetLatestLedgerResult {
  id: string;
  protocolVersion: number;
  sequence: number;
}

export interface EventFilter {
  type?: "contract" | "system" | "diagnostic";
  contractIds: string[];
  topics?: string[][];
}

export class RpcError extends Error {
  constructor(
    message: string,
    public readonly code?: number,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = "RpcError";
  }
}
