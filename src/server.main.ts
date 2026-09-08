import { startServer } from "./api/server.js";
import { loadConfig } from "./config.js";
import { IndexerDb } from "./db/index.js";
import { defaultLogger } from "./logger.js";

const config = loadConfig();
const db = new IndexerDb(config.dbPath);

const server = startServer(db, config);

function shutdown() {
  defaultLogger.info("Shutting down API server...");
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
