import type { EventFilter, GetEventsResult, GetLatestLedgerResult } from "./types.js";
import { RpcError } from "./types.js";

export interface GetEventsOptions {
  /** Ledger to start from. Mutually exclusive with `cursor` (cursor wins). */
  startLedger?: number;
  /** Pagination cursor (a previous event's pagingToken). */
  cursor?: string;
  filters: EventFilter[];
  limit?: number;
}

type FetchFn = typeof fetch;

/**
 * Thin, dependency-injectable wrapper around the Soroban RPC JSON-RPC API.
 * Only implements the two methods the indexer needs. Tests inject a fake
 * `fetchImpl` so no network access (or real RPC node) is needed.
 */
export class SorobanRpcClient {
  private readonly fetchImpl: FetchFn;
  private nextId = 1;

  constructor(
    private readonly rpcUrl: string,
    fetchImpl: FetchFn = fetch,
  ) {
    this.fetchImpl = fetchImpl;
  }

  private async call<T>(method: string, params: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, params }),
      });
    } catch (err) {
      throw new RpcError(
        `Network error calling ${method} on ${this.rpcUrl}: ${(err as Error).message}`,
      );
    }

    if (!res.ok) {
      throw new RpcError(`HTTP ${res.status} ${res.statusText} calling ${method}`);
    }

    let body: any;
    try {
      body = await res.json();
    } catch (err) {
      throw new RpcError(`Invalid JSON response from ${method}: ${(err as Error).message}`);
    }

    if (body?.error) {
      throw new RpcError(
        body.error.message ?? `RPC error calling ${method}`,
        body.error.code,
        body.error.data,
      );
    }
    return body.result as T;
  }

  getLatestLedger(): Promise<GetLatestLedgerResult> {
    return this.call<GetLatestLedgerResult>("getLatestLedger", {});
  }

  getEvents(opts: GetEventsOptions): Promise<GetEventsResult> {
    const pagination: Record<string, unknown> = {};
    if (opts.cursor) pagination.cursor = opts.cursor;
    if (opts.limit) pagination.limit = opts.limit;

    const params: Record<string, unknown> = { filters: opts.filters };
    if (opts.cursor) {
      params.pagination = pagination;
    } else {
      params.startLedger = opts.startLedger;
      if (Object.keys(pagination).length > 0) params.pagination = pagination;
    }

    return this.call<GetEventsResult>("getEvents", params);
  }
}
