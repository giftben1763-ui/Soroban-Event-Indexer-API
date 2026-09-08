# Soroban Event Indexer API

An off-chain indexer that watches a Soroban smart contract's events, decodes
them from XDR into plain JSON, persists them to SQLite, and serves them over
a small REST API — plus a live-updating HTML dashboard.

```
┌──────────────┐   getLatestLedger / getEvents   ┌───────────────────┐
│ Soroban RPC  │ ◄───────────────────────────── │  indexing worker   │
│ (testnet /   │                                 │  (src/worker.main) │
│  mainnet /   │                                 └─────────┬─────────┘
│  local node) │                                           │ writes
└──────────────┘                                           ▼
                                                    ┌─────────────────┐
                                                    │  SQLite (WAL)   │
                                                    │  events, gaps,  │
                                                    │  checkpoint     │
                                                    └────────┬────────┘
                                                             │ reads
                                                             ▼
                                                    ┌─────────────────┐
   browser ── HTTP ──►                              │   API server    │
   (dashboard, curl,                                │ (src/server.main)│
    other services)  ◄───────────── JSON ────────── └─────────────────┘
```

The worker and the API server are **separate processes** that only share the
SQLite file. Either can be restarted, redeployed, or scaled (read replicas
for the API) independently, as long as they agree on `DB_PATH`.

## Contents

- [How it works](#how-it-works)
- [Setup](#setup)
- [Running it](#running-it)
- [Configuration reference](#configuration-reference)
- [REST API](#rest-api)
- [Dashboard](#dashboard)
- [Pointing this at a different contract](#pointing-this-at-a-different-contract)
- [Worked example: a real AMM (Soroswap)](#worked-example-a-real-amm-soroswap)
- [Gap detection & recovery](#gap-detection--recovery)
- [Testing](#testing)
- [Limitations](#limitations)
- [Project layout](#project-layout)

## How it works

1. **Worker** (`src/worker.main.ts` → `src/indexer/worker.ts`) polls
   `getLatestLedger` and `getEvents` on a Soroban RPC endpoint every
   `POLL_INTERVAL_MS`. Each cycle:
   - Reads the last processed ledger from a `checkpoint` table.
   - Requests events for `[checkpoint+1, min(latestLedger, checkpoint+MAX_LEDGERS_PER_REQUEST)]`,
     filtered server-side to the configured `CONTRACT_ID`.
   - Pages through results using the last event's `pagingToken` as the
     cursor for the next page.
   - Decodes each event's topics/value from base64 XDR to native JSON
     (`src/decode/eventDecoder.ts`, via `@stellar/stellar-sdk`).
   - Inserts decoded events (`INSERT OR IGNORE` on a unique `paging_token`,
     so re-processing the same range is always safe).
   - Advances the checkpoint to the ledger it actually finished at.
2. **API server** (`src/server.main.ts` → `src/api/`) is a stateless Express
   app that only reads from the same SQLite file, and also serves the
   dashboard's static HTML/JS.
3. **Dashboard** (`src/dashboard/index.html`) is plain HTML/CSS/JS with no
   build step; it polls `/health`, `/gaps`, and `/events` every few seconds.

## Setup

Requires Node.js ≥ 18.17 (uses the built-in `fetch`).

```bash
npm install
cp .env.example .env
# edit .env: set CONTRACT_ID to the contract you want to index
```

`npm install` builds `better-sqlite3`'s native binding for your platform;
if that fails, see [their prebuilt-binary docs](https://github.com/WiseLibs/better-sqlite3)
for platform-specific requirements (a C++ toolchain / Python).

## Running it

```bash
# Two processes, sharing DB_PATH (recommended, mirrors production):
npm run worker    # starts the indexing loop
npm run server    # starts the API + dashboard on http://localhost:3000

# Or, for quick local demos, both in one process:
npm run dev
```

Open `http://localhost:3000` for the dashboard, or query the API directly:

```bash
curl "http://localhost:3000/health"
curl "http://localhost:3000/events?limit=5"
curl "http://localhost:3000/events/latest"
```

Run the test suite (no network or real RPC node required — everything is
mocked):

```bash
npm test
```

## Configuration reference

All configuration is environment variables (see `.env.example`), loaded via
`src/config.ts`.

| Variable                   | Default                                 | Meaning |
|-----------------------------|-----------------------------------------|---------|
| `SOROBAN_RPC_URL`           | `https://soroban-testnet.stellar.org`   | Soroban RPC JSON-RPC endpoint |
| `NETWORK_PASSPHRASE`        | Testnet passphrase                      | Informational; not currently used to sign anything (indexer is read-only) |
| `CONTRACT_ID`               | *(required)*                            | The contract (`C...`) whose events to index |
| `DB_PATH`                   | `./data/indexer.sqlite`                 | SQLite file. Worker and API **must** point at the same path |
| `POLL_INTERVAL_MS`          | `5000`                                  | Delay between indexing cycles |
| `MAX_LEDGERS_PER_REQUEST`   | `2000`                                  | Max ledgers advanced per cycle (bounds RPC call size after downtime) |
| `PAGE_LIMIT`                | `200`                                   | `getEvents` page size |
| `RETENTION_WINDOW_LEDGERS`  | `17280` (~24h at 5s/ledger)              | If the checkpoint is older than this relative to chain tip, treat the gap as unrecoverable and jump forward (see [Gap detection](#gap-detection--recovery)) |
| `START_LEDGER`              | `0` (= "recent tip")                    | Ledger to start from on a cold start, if you want to backfill from a specific point instead of "recent" |
| `EVENT_TYPE_TOPIC_INDEX`    | `0`                                     | Which topic slot holds the event's name — see [Pointing this at a different contract](#pointing-this-at-a-different-contract) |
| `API_PORT`                  | `3000`                                  | API/dashboard HTTP port |
| `API_MAX_PAGE_SIZE`         | `200`                                   | Hard cap on `?limit=` regardless of what a client requests |

## REST API

| Endpoint | Description |
|---|---|
| `GET /health` | `{ ok, contractId, lastIndexedLedger, lastIndexedAt, eventCount }` |
| `GET /events` | Query events. See below. |
| `GET /events/latest` | The single most recent event (optionally filtered). |
| `GET /gaps` | Ledger ranges the worker detected it could not index. |
| `GET /malformed-events` | Events that failed to decode, kept for debugging (not silently dropped). |

`GET /events` query parameters:

| Param | Meaning |
|---|---|
| `type` | Filter by decoded event type (see `EVENT_TYPE_TOPIC_INDEX`) |
| `contractId` | Filter by contract (useful if you ever index more than one) |
| `from`, `to` | Ledger sequence range (inclusive) |
| `limit` | Page size (capped at `API_MAX_PAGE_SIZE`) |
| `cursor` | Opaque keyset cursor from a previous response's `pagination.nextCursor` |
| `order` | `desc` (default, newest first) or `asc` |

Example response:

```json
{
  "events": [
    {
      "id": 42,
      "pagingToken": "12345678-3",
      "ledger": 1234567,
      "ledgerClosedAt": "2026-09-08T12:00:00Z",
      "contractId": "CDLZ...GCYSC",
      "eventType": "transfer",
      "topics": ["transfer", "GABC...", "GDEF..."],
      "value": { "amount": "500000000" },
      "txHash": "a1b2c3...",
      "createdAt": "2026-09-08T12:00:05Z"
    }
  ],
  "pagination": { "limit": 50, "nextCursor": 17, "order": "desc" }
}
```

Fetch the next page with `?cursor=17&limit=50`. Large integers (i64/i128/u256,
etc.) are serialized as **decimal strings**, since JSON has no native 64+ bit
integer type — parse with `BigInt(str)` client-side if you need exact math.

## Dashboard

`src/dashboard/index.html` is served by the API process at `/`. It polls
`/health`, `/gaps`, and `/events` every 4 seconds, flashes newly-seen rows,
and lets you filter by event type / ledger range or pause auto-refresh. No
build step, no framework — open the browser dev tools if you want to see how
little JS it takes.

## Pointing this at a different contract

1. Set `CONTRACT_ID` in `.env` to the new contract's `C...` address.
2. Set `SOROBAN_RPC_URL` / `NETWORK_PASSPHRASE` if it's on a different
   network (testnet vs. mainnet vs. a local `stellar-cli` sandbox).
3. Delete or point `DB_PATH` at a new file — the schema is contract-agnostic,
   but mixing events from two unrelated contracts into one dashboard view is
   rarely what you want (the API does support a `contractId` filter if you
   ever do want to index more than one contract into the same DB by running
   multiple worker instances with different `CONTRACT_ID`s and the same `DB_PATH`
   — SQLite handles the concurrent single-writer-at-a-time inserts fine at low
   volume, see [Limitations](#limitations)).
4. Check `EVENT_TYPE_TOPIC_INDEX`. Most token-like contracts follow the
   SEP-41 convention where `topics[0]` **is** the event name (e.g.
   `["transfer", from, to]`), which is the default. Some contracts instead
   prefix topics with a contract/namespace name — e.g. Soroswap's pair
   contract publishes `("SoroswapPair", "swap", ...)` — in which case set
   `EVENT_TYPE_TOPIC_INDEX=1` so `?type=swap` filters usefully. When in
   doubt, index with the default, look at a few rows' raw `topics` arrays via
   `GET /events`, and adjust.
5. Restart both processes. A fresh `DB_PATH` has no checkpoint, so the
   worker starts from `START_LEDGER` (or a recent ledger if left at `0`) —
   see [Limitations](#limitations) re: backfilling old history.

## Worked example: a real AMM (Soroswap)

[Soroswap](https://soroswap.finance) is a live constant-product AMM on
Stellar. Its `SoroswapPair` contract (verified from
[`soroswap/core`](https://github.com/soroswap/core/blob/main/contracts/pair/src/event.rs))
publishes exactly the kind of domain events this indexer is built for:

| Event | Topics | Data |
|---|---|---|
| `deposit` | `("SoroswapPair", "deposit")` | `to, amount_0, amount_1, liquidity, new_reserve_0, new_reserve_1` |
| `withdraw` | `("SoroswapPair", "withdraw")` | `to, liquidity, amount_0, amount_1, new_reserve_0, new_reserve_1` |
| `swap` | `("SoroswapPair", "swap")` | `to, amount_0_in, amount_1_in, amount_0_out, amount_1_out` |
| `sync` | `("SoroswapPair", "sync")` | `new_reserve_0, new_reserve_1` |
| `skim` | `("SoroswapPair", "skim")` | `skimmed_0, skimmed_1` |

Since every topic tuple is prefixed with the literal `"SoroswapPair"`, this
is exactly the case `EVENT_TYPE_TOPIC_INDEX` exists for.

The Soroswap **factory** (one per network, creates a pair contract per
token pair — its mainnet address is `CA4HEQTL2WPEUYKYKCDOHCDNIV4QHNJ7EL4J4NQ6VADP7SYHVRYZ7AW2`,
confirmed live via `getEvents` against `https://mainnet.sorobanrpc.com` while
building this) itself only emits events when a new pair is created, which is
rare — so to see a steady stream of `swap`/`deposit`/`sync` events you want
the address of a specific **pair** contract, not the factory. Get one by:

- calling the factory's `get_pair(token_a, token_b)` for a pair you know is
  active (e.g. XLM/USDC) with `stellar-cli` or `@stellar/stellar-sdk`, or
- looking up the factory's contract on [stellar.expert](https://stellar.expert)
  and following a `new_pair`/`create` invocation to the pair address it
  returned.

Once you have a pair address:

```bash
# .env
SOROBAN_RPC_URL=https://mainnet.sorobanrpc.com
NETWORK_PASSPHRASE=Public Global Stellar Network ; September 2015
CONTRACT_ID=<the SoroswapPair contract address you found>
EVENT_TYPE_TOPIC_INDEX=1
```

```bash
npm run dev
curl "http://localhost:3000/events?type=swap&limit=5"
```

That's the whole adaptation: three config lines, no code changes — which is
the point of keeping decoding generic and only the "what counts as the event
type" heuristic configurable.

*(We didn't deploy our own AMM contract for this walkthrough — Soroban
requires a Rust/wasm toolchain and a funded testnet account, out of scope for
this sandbox — but the event shapes above are taken directly from Soroswap's
published, audited source, and the factory address and RPC shape were
verified live against mainnet while writing this indexer. The official
[`stellar/soroban-examples` liquidity pool contract](https://github.com/stellar/soroban-examples/tree/main/liquidity_pool),
by contrast, does **not** publish any events at all — it's a good read for
the AMM math, but not usable as an indexing target as-is.)*

## Gap detection & recovery

Stellar/Soroban has fast, single-slot finality — closed ledgers don't get
reorganized the way Bitcoin/Ethereum blocks do, so there's no "chain reorg"
in the traditional sense to detect. The real-world failure modes this
indexer guards against are:

- **The indexer was down** (deploy, crash, maintenance) and the RPC node has
  since **pruned** the ledgers it missed (public RPC nodes typically retain
  ~24h of ledger/event history). On restart, the worker resumes from its
  persisted `checkpoint`; if `checkpoint+1` is older than the node's
  retention window relative to the current chain tip, it:
  1. logs and inserts a row into the `gaps` table recording the exact
     `[fromLedger, toLedger]` range that was almost certainly missed, and
  2. jumps forward to the oldest ledger the node can still likely serve,
     rather than retrying an unrecoverable range forever.
  Inspect what was missed anytime via `GET /gaps`.
- **RPC/network errors** (timeout, 5xx, malformed JSON) during a cycle: the
  error is logged and the cycle aborts *before* the checkpoint is advanced,
  so nothing is lost — the next poll retries the same range from scratch.
- **Malformed events** (unexpected shape, bad XDR): decoding is isolated
  per-event; a bad event is logged to `malformed_events` and skipped, the
  rest of the batch is still indexed, and the checkpoint still advances so
  one bad event can't wedge the whole indexer.
- **Duplicate events** (re-processing a range, e.g. after a crash mid-cycle):
  `paging_token` is `UNIQUE`, and inserts use `INSERT OR IGNORE`, so
  re-indexing the same range is a no-op rather than duplicate rows.

There is deliberately no attempt to detect a *true* ledger reorg (comparing
ledger hashes across cycles) — Soroban RPC doesn't expose the kind of
ancestor-chain data you'd need for that, and it isn't a failure mode that
occurs in practice on Stellar's consensus model.

## Testing

`npm test` runs entirely against a mocked RPC (`test/helpers/mockRpc.ts`,
a fake `fetch` that speaks JSON-RPC) and real `better-sqlite3` databases
(mostly in-memory), so tests are fast and need no network access or live
Soroban node. Coverage includes the three scenarios called out in the brief,
plus the DB and API layers:

- **`test/indexer.normal.test.ts`** — cold start, idempotent re-polling,
  checkpoint advancing across cycles, multi-page pagination via
  `pagingToken` cursors, and resuming from a persisted checkpoint across a
  simulated restart.
- **`test/indexer.gap.test.ts`** — a checkpoint that has fallen behind the
  configured retention window is detected, logged to `gaps`, and the worker
  jumps forward instead of retrying forever; no false positives when the
  checkpoint is within the window; RPC/network failures propagate without
  corrupting the checkpoint.
- **`test/indexer.malformed.test.ts`** — a batch mixing well-formed and
  malformed events (missing fields, invalid XDR, wrong types, `null`) is
  indexed without throwing: good events land in `events`, bad ones land in
  `malformed_events` with a reason, and the checkpoint still advances.
- **`test/eventDecoder.test.ts`** — decoder unit tests, including the
  `EVENT_TYPE_TOPIC_INDEX` behavior used by the Soroswap example above.
- **`test/db.test.ts`**, **`test/api.test.ts`** — persistence and pagination
  semantics, and the HTTP layer end-to-end via `supertest`.

## Limitations

Being upfront about what this is (a first version / take-home-sized project)
and isn't:

- **Not horizontally scalable.** One worker process should ever write to a
  given `DB_PATH` at a time — there's no distributed locking or leader
  election. You *can* run multiple read-only API server instances against
  the same SQLite file (WAL mode allows concurrent readers), but there is
  exactly one writer.
- **Single-writer, single-file database.** SQLite is intentionally the
  choice for a first version, per the brief. It's fine for one contract at
  moderate event volume; it is not what you'd reach for to index many
  contracts at high throughput — migrate `src/db/index.ts` to
  Postgres/MySQL behind the same `IndexerDb` interface if you outgrow it.
- **Polling, not a push subscription.** Soroban RPC doesn't currently offer
  a streaming/WebSocket events subscription, so this polls on an interval
  (default 5s). That's an RPC round-trip of latency, not sub-second.
- **No backfill-all-history mode.** `START_LEDGER=0` starts near the current
  tip, not genesis, to avoid an unbounded first run. Set `START_LEDGER`
  explicitly if you need a specific historical starting point — but note
  public RPC nodes only retain a rolling recent-history window anyway (see
  `RETENTION_WINDOW_LEDGERS`); true deep backfills need an RPC node with
  extended history retention, or Stellar's Hubble/BigQuery data set.
- **No true chain-reorg detection.** As covered above — not applicable to
  Stellar's consensus model, but noting it since the brief asked for it: RPC
  *gaps* (pruning, downtime) are handled; ledger reorgs are not, because
  they don't happen here.
- **No auth on the API.** It's read-only by design, but there's no rate
  limiting, API keys, or CORS restriction — add a reverse proxy / gateway if
  exposing this beyond a trusted network.
- **`event_type` is a heuristic, not a protocol guarantee.** Soroban events
  don't have a mandated "this topic is the name" convention; see
  `EVENT_TYPE_TOPIC_INDEX` above.
- **Decoding covers everything `scValToNative` supports** (all standard
  `ScVal` types the Stellar SDK knows about), but a contract emitting a
  custom, non-standard payload shape is stored as whatever
  `scValToNative` produces — there's no per-contract schema/typing layer.

## Project layout

```
src/
  config.ts                 # env-driven configuration
  logger.ts                 # tiny logger interface (+ silent variant for tests)
  worker.main.ts            # indexing worker entrypoint (process 1)
  server.main.ts            # API server entrypoint (process 2)
  dev-all.ts                # both, one process — local dev convenience only
  rpc/
    types.ts                # Soroban RPC request/response shapes
    sorobanRpcClient.ts      # thin JSON-RPC client (dependency-injectable fetch)
  decode/
    eventDecoder.ts          # raw RPC event -> decoded native JS, or MalformedEventError
  db/
    schema.ts, index.ts      # SQLite schema + IndexerDb access layer
  indexer/
    worker.ts                # indexOnce() core logic + startWorker() poll loop
  api/
    server.ts                 # createApp() (Express) + startServer()
    routes/events.ts          # /events, /events/latest, /gaps, /malformed-events
  dashboard/
    index.html                # static, no-build-step live feed UI
  util/json.ts                 # BigInt-safe JSON (de)serialization
test/
  helpers/                    # mock RPC (fake fetch) + event fixtures
  indexer.normal.test.ts
  indexer.gap.test.ts
  indexer.malformed.test.ts
  eventDecoder.test.ts
  db.test.ts
  api.test.ts
```
