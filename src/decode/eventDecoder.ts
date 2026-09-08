import { scValToNative, xdr } from "@stellar/stellar-sdk";
import type { RawEvent } from "../rpc/types.js";

export class MalformedEventError extends Error {
  constructor(
    message: string,
    public readonly raw: unknown,
  ) {
    super(message);
    this.name = "MalformedEventError";
  }
}

export interface DecodedEvent {
  ledger: number;
  ledgerClosedAt: string | null;
  contractId: string;
  pagingToken: string;
  txHash: string | null;
  /** The decoded first topic, stringified — conventionally the event "name" (e.g. "transfer"). */
  eventType: string | null;
  /** All topics, decoded to native JS values. */
  topics: unknown[];
  /** The decoded event body. */
  value: unknown;
  /** The untouched RPC event, kept for debugging / re-decoding. */
  raw: RawEvent;
}

export interface DecodeOptions {
  /**
   * Which topic slot to treat as the human-readable "event type" used for
   * the `event_type` column and the API's `?type=` filter. Defaults to 0,
   * which matches the SEP-41 token convention (topics = [Symbol("transfer"), ...]).
   * Some contracts prefix topics with a contract/namespace name instead
   * (e.g. Soroswap's pair contract uses topics = ("SoroswapPair", "swap", ...)),
   * in which case set this to 1. See README "Adapting to a different contract".
   */
  eventTypeTopicIndex?: number;
}

/**
 * Decodes a raw Soroban RPC event into native JS values.
 * Throws MalformedEventError (never a raw SDK error) for anything that
 * doesn't look like a well-formed contract event, so callers can catch a
 * single error type and keep indexing the rest of the batch.
 */
export function decodeEvent(raw: unknown, opts: DecodeOptions = {}): DecodedEvent {
  if (!raw || typeof raw !== "object") {
    throw new MalformedEventError("event is not an object", raw);
  }
  const e = raw as Partial<RawEvent>;

  if (typeof e.ledger !== "number" || !Number.isFinite(e.ledger)) {
    throw new MalformedEventError("missing or invalid 'ledger'", raw);
  }
  if (typeof e.contractId !== "string" || e.contractId.length === 0) {
    throw new MalformedEventError("missing or invalid 'contractId'", raw);
  }
  if (typeof e.pagingToken !== "string" || e.pagingToken.length === 0) {
    throw new MalformedEventError("missing or invalid 'pagingToken'", raw);
  }
  if (!Array.isArray(e.topic)) {
    throw new MalformedEventError("missing or invalid 'topic' array", raw);
  }
  if (typeof e.value !== "string") {
    throw new MalformedEventError("missing or invalid 'value'", raw);
  }

  const topics: unknown[] = [];
  for (const [i, t] of e.topic.entries()) {
    if (typeof t !== "string") {
      throw new MalformedEventError(`topic[${i}] is not a base64 XDR string`, raw);
    }
    try {
      topics.push(scValToNative(xdr.ScVal.fromXDR(t, "base64")));
    } catch (err) {
      throw new MalformedEventError(
        `failed to decode topic[${i}]: ${(err as Error).message}`,
        raw,
      );
    }
  }

  let value: unknown;
  try {
    value = scValToNative(xdr.ScVal.fromXDR(e.value, "base64"));
  } catch (err) {
    throw new MalformedEventError(`failed to decode value: ${(err as Error).message}`, raw);
  }

  const typeIndex = opts.eventTypeTopicIndex ?? 0;
  return {
    ledger: e.ledger,
    ledgerClosedAt: e.ledgerClosedAt ?? null,
    contractId: e.contractId,
    pagingToken: e.pagingToken,
    txHash: e.txHash ?? null,
    eventType: typeIndex >= 0 && typeIndex < topics.length ? stringifyEventType(topics[typeIndex]) : null,
    topics,
    value,
    raw: raw as RawEvent,
  };
}

function stringifyEventType(topic0: unknown): string {
  if (typeof topic0 === "string") return topic0;
  if (typeof topic0 === "bigint") return topic0.toString();
  try {
    return JSON.stringify(topic0, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  } catch {
    return String(topic0);
  }
}
