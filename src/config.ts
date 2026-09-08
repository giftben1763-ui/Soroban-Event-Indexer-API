import "dotenv/config";
import path from "node:path";

/**
 * Central configuration, read from environment variables (see .env.example).
 * Keeping this in one place makes "point the indexer at a different contract"
 * a one-line change (CONTRACT_ID) rather than a code change.
 */
export interface Config {
  /** Soroban RPC HTTP endpoint, e.g. https://soroban-testnet.stellar.org */
  rpcUrl: string;
  /** Network passphrase, used only for informational/validation purposes */
  networkPassphrase: string;
  /** Contract id (StrKey "C...") whose events we track. */
  contractId: string;
  /** Path to the SQLite database file. */
  dbPath: string;
  /** How often the worker polls the RPC for new events, in ms. */
  pollIntervalMs: number;
  /** Max ledgers requested from getEvents in a single RPC call. */
  maxLedgersPerRequest: number;
  /** Max events requested per getEvents page. */
  pageLimit: number;
  /**
   * If the persisted checkpoint is older than the RPC's oldest retained
   * ledger by more than this many ledgers, we treat it as a hard gap
   * (data almost certainly cannot be backfilled) and jump forward instead
   * of retrying forever.
   */
  retentionWindowLedgers: number;
  /** Ledger to start from when there is no checkpoint yet (0 = "latest"). */
  startLedger: number;
  /**
   * Which topic index holds the human-readable event name. 0 works for the
   * common SEP-41 token convention (topics = [Symbol("transfer"), ...]).
   * Some contracts (e.g. Soroswap's pair contract) prefix topics with a
   * contract name instead — set to 1 for those. See README.
   */
  eventTypeTopicIndex: number;
  /** HTTP port for the API server. */
  apiPort: number;
  /** Max page size the API will return regardless of what the client asks for. */
  apiMaxPageSize: number;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) {
    throw new Error(`Environment variable ${name} must be an integer, got "${raw}"`);
  }
  return n;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const base: Config = {
    rpcUrl: process.env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org",
    networkPassphrase:
      process.env.NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015",
    contractId: process.env.CONTRACT_ID ?? "",
    dbPath: process.env.DB_PATH ?? path.join(process.cwd(), "data", "indexer.sqlite"),
    pollIntervalMs: envInt("POLL_INTERVAL_MS", 5000),
    maxLedgersPerRequest: envInt("MAX_LEDGERS_PER_REQUEST", 2000),
    pageLimit: envInt("PAGE_LIMIT", 200),
    retentionWindowLedgers: envInt("RETENTION_WINDOW_LEDGERS", 17280), // ~24h at 5s/ledger
    startLedger: envInt("START_LEDGER", 0),
    eventTypeTopicIndex: envInt("EVENT_TYPE_TOPIC_INDEX", 0),
    apiPort: envInt("API_PORT", 3000),
    apiMaxPageSize: envInt("API_MAX_PAGE_SIZE", 200),
  };
  return { ...base, ...overrides };
}
