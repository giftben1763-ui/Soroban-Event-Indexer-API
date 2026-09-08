import { loadConfig } from "./config.js";
import { IndexerDb } from "./db/index.js";
import { startWorker } from "./indexer/worker.js";
import { defaultLogger } from "./logger.js";
import { SorobanRpcClient } from "./rpc/sorobanRpcClient.js";

const config = loadConfig();

if (!config.contractId) {
  defaultLogger.error(
    "CONTRACT_ID is not set. Set it in your environment or .env file — see README.",
  );
  process.exit(1);
}

const db = new IndexerDb(config.dbPath);
const rpc = new SorobanRpcClient(config.rpcUrl);

defaultLogger.info(
  `Starting indexer worker: contract=${config.contractId} rpc=${config.rpcUrl} db=${config.dbPath} pollIntervalMs=${config.pollIntervalMs}`,
);

const handle = startWorker({ rpc, db, config, logger: defaultLogger });

function shutdown() {
  defaultLogger.info("Shutting down worker...");
  handle.stop();
  db.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
