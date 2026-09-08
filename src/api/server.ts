import cors from "cors";
import express, { type Express } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "../config.js";
import type { IndexerDb } from "../db/index.js";
import { eventsRouter } from "./routes/events.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD_DIR = path.join(__dirname, "..", "dashboard");

/**
 * Builds the Express app. Kept separate from `listen()` so tests can drive
 * it in-process with supertest instead of binding a real port.
 */
export function createApp(db: IndexerDb, config: Config): Express {
  const app = express();
  app.use(cors());
  app.disable("x-powered-by");

  app.get("/health", (_req, res) => {
    const checkpoint = db.getCheckpoint();
    res.json({
      ok: true,
      contractId: config.contractId,
      lastIndexedLedger: checkpoint?.lastLedger ?? null,
      lastIndexedAt: checkpoint?.updatedAt ?? null,
      eventCount: db.countEvents(),
    });
  });

  app.use(eventsRouter(db, config));

  // Minimal live dashboard (static HTML/JS that polls the API above).
  app.use(express.static(DASHBOARD_DIR));

  return app;
}

export function startServer(db: IndexerDb, config: Config) {
  const app = createApp(db, config);
  return app.listen(config.apiPort, () => {
    // eslint-disable-next-line no-console
    console.log(`API server listening on http://localhost:${config.apiPort}`);
  });
}
