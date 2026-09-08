# Contributing

Thanks for taking a look at this project. It's a small, first-version
indexer (see the README's [Limitations](README.md#limitations) section for
what's deliberately out of scope), so contributions that keep it simple and
well-tested are especially welcome.

## Getting set up

```bash
git clone https://github.com/giftben1763-ui/Soroban-Event-Indexer-API
cd Soroban-Event-Indexer-API
npm install
cp .env.example .env   # set CONTRACT_ID if you want to run it against real RPC
```

Requires Node.js ≥ 18.17. `npm install` compiles `better-sqlite3`'s native
binding for your platform — if that fails, you're missing a C++ toolchain /
Python; see [their docs](https://github.com/WiseLibs/better-sqlite3).

## Before opening a PR

```bash
npm run lint    # tsc --noEmit — the project is strict-mode TypeScript
npm test        # vitest — all tests run against a mocked RPC, no network needed
npm run build   # confirms the production build (dist/) actually compiles
```

All three should pass. There's no separate formatter/linter config right
now — match the style of the surrounding code (naming, comment density,
import layout) rather than introducing a new convention in one file.

## Project layout

See the README's [Project layout](README.md#project-layout) section for the
full directory map. The short version:

- `src/indexer/worker.ts` — the core indexing logic (`indexOnce`, `startWorker`).
  This is the most important file to understand; almost everything else
  supports it.
- `src/rpc/`, `src/decode/`, `src/db/` — dependency-injectable building
  blocks the worker composes. Each is designed to be unit-testable in
  isolation (see how `SorobanRpcClient` takes a `fetch` implementation).
- `src/api/` — the read-only HTTP layer. Never let it write to the DB.
- `test/helpers/mockRpc.ts` and `test/helpers/fixtures.ts` — the mocked
  JSON-RPC `fetch` and event-fixture builders every indexer test is built on.
  New indexer tests should reuse these rather than hand-rolling new mocks.

## Adding a feature

- **Keep the worker/API separation.** The worker writes, the API only
  reads. If a feature needs both, add the write path to `IndexerDb` and the
  read path to a new/existing route — don't have the API server call the
  RPC client directly.
- **New config knobs** go in `src/config.ts` (with an `envInt`/plain
  `process.env` read, a sensible default, and a line in `.env.example`
  explaining what it does and why you'd change it).
- **Schema changes** go in `src/db/schema.ts`. Existing migrations use
  `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`, so they're
  safe to re-run against an existing database; keep new ones additive
  (no destructive `ALTER`/`DROP` without a migration story — there isn't
  one yet, so a breaking schema change needs one first).
- **New decoded event shapes**: `decodeEvent` should keep throwing
  `MalformedEventError` (never let a raw SDK/parse error escape it) so the
  worker's per-event isolation keeps working.

## Tests

Every behavior change should come with a test. Follow the existing pattern:

1. Build a mock RPC handler with `createMockFetch` (`test/helpers/mockRpc.ts`)
   that responds to `getLatestLedger`/`getEvents` for your scenario.
2. Build raw events with `makeRawEvent` (`test/helpers/fixtures.ts`) —
   it produces real base64 XDR via `@stellar/stellar-sdk`, not fake strings,
   so decoder tests exercise the real decode path.
3. Call `indexOnce({ rpc, db, config, logger: silentLogger })` directly
   rather than `startWorker` — it's the pure, one-cycle function the whole
   test suite is built around, and keeps tests deterministic (no timers).

If you're fixing a bug, add a regression test that fails without your fix
first — that's the fastest way to confirm the fix is real.

## Commit / PR conventions

- Keep commits focused; a commit message should explain *why*, not just
  restate the diff.
- Branch off `main` rather than committing straight to it.
- Reference the relevant README section in your PR description if you're
  changing documented behavior (config, API shape, limitations) — and
  update the README in the same PR. Docs drifting from behavior is worse
  than no docs.

## Reporting issues

Open a GitHub issue with: the contract/network you were indexing against
(if relevant), your config (redact `CONTRACT_ID`/RPC URL if it matters),
and — if it's a decoding issue — the raw event's `topic`/`value` base64
strings from `GET /malformed-events`, which is exactly what that endpoint
exists for.
