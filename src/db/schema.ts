export const SCHEMA = `
CREATE TABLE IF NOT EXISTS checkpoint (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_ledger INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  paging_token TEXT NOT NULL UNIQUE,
  ledger INTEGER NOT NULL,
  ledger_closed_at TEXT,
  contract_id TEXT NOT NULL,
  event_type TEXT,
  topics TEXT NOT NULL,
  value TEXT NOT NULL,
  tx_hash TEXT,
  raw TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_ledger ON events(ledger);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
CREATE INDEX IF NOT EXISTS idx_events_contract ON events(contract_id);

CREATE TABLE IF NOT EXISTS gaps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_ledger INTEGER NOT NULL,
  to_ledger INTEGER NOT NULL,
  reason TEXT NOT NULL,
  detected_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS malformed_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  paging_token TEXT,
  ledger INTEGER,
  reason TEXT NOT NULL,
  raw TEXT,
  detected_at TEXT NOT NULL
);
`;
