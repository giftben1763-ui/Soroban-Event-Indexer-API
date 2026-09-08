import type { Config } from "../config.js";
import { decodeEvent, MalformedEventError } from "../decode/eventDecoder.js";
import type { IndexerDb } from "../db/index.js";
import { defaultLogger, type Logger } from "../logger.js";
import type { SorobanRpcClient } from "../rpc/sorobanRpcClient.js";
import type { RawEvent } from "../rpc/types.js";
import { safeStringify } from "../util/json.js";

/** Safety valve: never page forever within a single poll cycle. */
const MAX_PAGES_PER_CYCLE = 100;

export interface WorkerDeps {
  rpc: SorobanRpcClient;
  db: IndexerDb;
  config: Config;
  logger?: Logger;
}

export interface IndexOnceResult {
  /** True if there was nothing new to do (already caught up to the chain tip). */
  upToDate: boolean;
  startLedger: number | null;
  endLedger: number | null;
  eventsInserted: number;
  eventsDuplicate: number;
  malformed: number;
  pagesFetched: number;
  gapDetected: { fromLedger: number; toLedger: number; reason: string } | null;
}

/**
 * Runs exactly one indexing cycle: figure out where we left off, fetch new
 * events up to the current chain tip (bounded by maxLedgersPerRequest so a
 * long-idle indexer doesn't try to swallow the whole gap in one RPC call),
 * decode + persist them, and advance the checkpoint.
 *
 * Pure(ish) function of its dependencies so it can be unit tested against a
 * mocked SorobanRpcClient without any real network or timers.
 */
export async function indexOnce(deps: WorkerDeps): Promise<IndexOnceResult> {
  const { rpc, db, config, logger = defaultLogger } = deps;

  const latest = await rpc.getLatestLedger();
  const checkpoint = db.getCheckpoint();

  let startLedger: number;
  let gapDetected: IndexOnceResult["gapDetected"] = null;

  if (checkpoint === null) {
    // First ever run: either start at a configured ledger, or a bounded
    // window before the chain tip so we don't try to replay all of history.
    startLedger =
      config.startLedger > 0
        ? config.startLedger
        : Math.max(1, latest.sequence - config.maxLedgersPerRequest + 1);
    logger.info(`No checkpoint found. Starting from ledger ${startLedger}.`);
  } else {
    startLedger = checkpoint.lastLedger + 1;

    // If we've been down long enough that the RPC node may have pruned the
    // ledgers we need, don't retry forever — log it as a gap and jump ahead
    // to the oldest ledger the node is still likely to have.
    const oldestSafe = latest.sequence - config.retentionWindowLedgers + 1;
    if (startLedger < oldestSafe) {
      const gap = {
        fromLedger: startLedger,
        toLedger: oldestSafe - 1,
        reason: `checkpoint (ledger ${checkpoint.lastLedger}) is older than the RPC's retention window (~${config.retentionWindowLedgers} ledgers); these ledgers were very likely pruned`,
      };
      db.insertGap(gap);
      gapDetected = gap;
      logger.warn(
        `Gap detected: ledgers ${gap.fromLedger}-${gap.toLedger} are likely unavailable (${gap.reason}). Resuming from ledger ${oldestSafe}.`,
      );
      startLedger = oldestSafe;
    }
  }

  if (startLedger > latest.sequence) {
    return {
      upToDate: true,
      startLedger: null,
      endLedger: null,
      eventsInserted: 0,
      eventsDuplicate: 0,
      malformed: 0,
      pagesFetched: 0,
      gapDetected,
    };
  }

  const endLedger = Math.min(latest.sequence, startLedger + config.maxLedgersPerRequest - 1);

  let cursor: string | undefined;
  let pagesFetched = 0;
  let eventsInserted = 0;
  let eventsDuplicate = 0;
  let malformed = 0;

  for (;;) {
    let page;
    try {
      page = await rpc.getEvents({
        startLedger: cursor ? undefined : startLedger,
        cursor,
        filters: [{ type: "contract", contractIds: [config.contractId] }],
        limit: config.pageLimit,
      });
    } catch (err) {
      // Surface the failure to the caller (the poll loop) so it can back
      // off and retry later; the checkpoint is untouched, so nothing is lost.
      logger.error(`getEvents failed while indexing ${startLedger}-${endLedger}: ${(err as Error).message}`);
      throw err;
    }
    pagesFetched++;

    for (const rawEvent of page.events as RawEvent[]) {
      if (rawEvent && typeof rawEvent.ledger === "number" && rawEvent.ledger > endLedger) {
        // Defensive: some RPC implementations may return slightly past what
        // we asked for. Leave it for the next cycle rather than skip it.
        continue;
      }
      try {
        const decoded = decodeEvent(rawEvent, { eventTypeTopicIndex: config.eventTypeTopicIndex });
        const inserted = db.insertEvent(decoded);
        if (inserted) eventsInserted++;
        else eventsDuplicate++;
      } catch (err) {
        malformed++;
        const reason =
          err instanceof MalformedEventError
            ? err.message
            : `unexpected decode error: ${(err as Error).message}`;
        const ledger = typeof (rawEvent as RawEvent)?.ledger === "number" ? (rawEvent as RawEvent).ledger : null;
        const pagingToken = typeof (rawEvent as RawEvent)?.pagingToken === "string" ? (rawEvent as RawEvent).pagingToken : null;
        logger.warn(`Skipping malformed event (ledger=${ledger}, pagingToken=${pagingToken}): ${reason}`);
        db.insertMalformedEvent({ pagingToken, ledger, reason, raw: safeStringify(rawEvent) });
      }
    }

    const gotFullPage = page.events.length > 0 && page.events.length === config.pageLimit;
    if (!gotFullPage || pagesFetched >= MAX_PAGES_PER_CYCLE) {
      break;
    }
    cursor = page.events[page.events.length - 1]?.pagingToken;
    if (!cursor) break;
  }

  db.setCheckpoint(endLedger);

  return {
    upToDate: false,
    startLedger,
    endLedger,
    eventsInserted,
    eventsDuplicate,
    malformed,
    pagesFetched,
    gapDetected,
  };
}

export interface WorkerHandle {
  stop(): void;
}

/**
 * Starts the polling loop. Runs indexOnce() every pollIntervalMs, catching
 * and logging any error (RPC outage, transient network blip, etc.) so a
 * single bad cycle never crashes the process — it just retries next tick.
 */
export function startWorker(deps: WorkerDeps): WorkerHandle {
  const { config, logger = defaultLogger } = deps;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const tick = async () => {
    if (stopped) return;
    try {
      const result = await indexOnce(deps);
      if (!result.upToDate) {
        logger.info(
          `Indexed ledgers ${result.startLedger}-${result.endLedger}: ` +
            `${result.eventsInserted} new, ${result.eventsDuplicate} duplicate, ${result.malformed} malformed ` +
            `(${result.pagesFetched} page(s)).`,
        );
      }
    } catch (err) {
      logger.error(`Indexing cycle failed, will retry in ${config.pollIntervalMs}ms: ${(err as Error).message}`);
    } finally {
      if (!stopped) {
        timer = setTimeout(tick, config.pollIntervalMs);
      }
    }
  };

  void tick();

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
