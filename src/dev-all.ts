/**
 * Convenience entrypoint that runs the worker and the API server in one
 * process, sharing one IndexerDb instance. Handy for local development and
 * demos. In production, prefer running `npm run worker` and `npm run
 * server` as separate processes/containers (see README "Limitations") —
 * they only need to agree on DB_PATH.
 */
import { startServer } from "./api/server.js";
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
  `Starting worker+server: contract=${config.contractId} rpc=${config.rpcUrl} db=${config.dbPath}`,
);

const worker = startWorker({ rpc, db, config, logger: defaultLogger });
const server = startServer(db, config);

function shutdown() {
  defaultLogger.info("Shutting down...");
  worker.stop();
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
