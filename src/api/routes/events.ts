import { Router } from "express";
import type { IndexerDb } from "../../db/index.js";
import type { Config } from "../../config.js";

function parseIntParam(value: unknown): number | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : undefined;
}

export function eventsRouter(db: IndexerDb, config: Config): Router {
  const router = Router();

  // GET /events?type=X&from=Y&to=Z&contractId=C&limit=N&cursor=N&order=asc|desc
  router.get("/events", (req, res) => {
    const from = parseIntParam(req.query.from);
    const to = parseIntParam(req.query.to);
    const cursor = parseIntParam(req.query.cursor);
    const limitRaw = parseIntParam(req.query.limit);
    const order = req.query.order === "asc" ? "asc" : "desc";

    if (req.query.from !== undefined && from === undefined) {
      return res.status(400).json({ error: "'from' must be an integer ledger sequence" });
    }
    if (req.query.to !== undefined && to === undefined) {
      return res.status(400).json({ error: "'to' must be an integer ledger sequence" });
    }
    if (req.query.cursor !== undefined && cursor === undefined) {
      return res.status(400).json({ error: "'cursor' must be an integer" });
    }

    const limit = Math.min(limitRaw ?? config.apiMaxPageSize, config.apiMaxPageSize);

    const page = db.queryEvents({
      type: typeof req.query.type === "string" ? req.query.type : undefined,
      contractId: typeof req.query.contractId === "string" ? req.query.contractId : undefined,
      fromLedger: from,
      toLedger: to,
      cursor,
      order,
      limit,
    });

    res.json({
      events: page.rows,
      pagination: { limit, nextCursor: page.nextCursor, order },
    });
  });

  // GET /events/latest?type=X&contractId=C
  router.get("/events/latest", (req, res) => {
    const event = db.getLatestEvent({
      type: typeof req.query.type === "string" ? req.query.type : undefined,
      contractId: typeof req.query.contractId === "string" ? req.query.contractId : undefined,
    });
    if (!event) {
      return res.status(404).json({ error: "no events indexed yet" });
    }
    res.json({ event });
  });

  // GET /gaps - detected ledger ranges that could not be indexed.
  router.get("/gaps", (_req, res) => {
    res.json({ gaps: db.listGaps() });
  });

  // GET /malformed-events - events that failed to decode, for debugging.
  router.get("/malformed-events", (_req, res) => {
    res.json({ malformedEvents: db.listMalformedEvents() });
  });

  return router;
}
