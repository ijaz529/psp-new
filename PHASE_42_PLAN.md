# Phase 42 — Plan

**Goal:** the `make e2e` payment canary from PROJECT_BRIEF §5: "spins
up Docker Compose, runs a full payment from API call → ledger entry →
settlement → payout, and asserts the ledger sums to zero per currency
at the end. This is the canary." Open since Phase 0 — `make e2e` is
still the health/idempotency smoke, and `tests/e2e/` has been an
empty directory for 42 phases.

## Design

Two host-side CLIs (the pattern every operator flow here already
uses), chained by a fatter `make e2e`:

### `apps/api/cli/e2e-canary.ts` (new) — the driver

Runs against the compose stack over HTTP + the host `DATABASE_URL`:

1. Health-check the api.
2. Fixture a fresh merchant + `pk_test_`/`sk_test_` keys directly in
   the DB (same key-generation code the portal uses — no brittle CLI
   output parsing).
3. `POST /v1/tokens` (pk) with card `4242 4242 4242 4242` — outside
   both the 3DS demo BINs and the Strawberry issuing BIN ranges, so
   the sim's stub issuer approves. Exercises the real vault.
4. `POST /v1/payment_methods` (sk) from the token.
5. `POST /v1/payment_intents` `amount 10000 USD, confirm: true` →
   expect `succeeded`, and assert `last_auth_rrn`/`last_auth_stan`
   are set in the DB — proof the auth crossed the real ISO 8583 wire
   (api → acquirer-host → scheme-simulator), not a stub.
6. `POST /v1/refunds` for 2500 → expect `succeeded`,
   `amount_received` 7500.
7. Spawn `pnpm --filter @psp-new/worker nightly:once` (below).
8. Assert, via SQL:
   - a `clearing_records` row for the PI whose `rrn` equals
     `last_auth_rrn` (the Phase 34 fix, live);
   - a `clearing_files` row + the emitted file on disk;
   - a `payouts` row for the merchant, status `paid`, amount > 0;
   - `scheme_receivable[visa, USD]` journal-lines sum == 0 after
     settlement;
   - **the canary invariant**: `SELECT currency, SUM(amount) FROM
     ledger.journal_lines GROUP BY currency` — every currency exactly
     0.
9. Print a step-by-step PASS table; any failure exits 1 with the
   step named.

Loads `DATABASE_URL` from the repo-root `.env` when not already
exported (tiny parser — no dotenv dep), matching how a developer
actually runs this.

### `apps/worker/cli/nightly-once.ts` (new) — deterministic job runner

The worker's `setInterval` cadence (24h nightly) is useless to a
canary. This CLI runs one pass synchronously:
refresh balances → `runNightlyJobs` → refresh → `settleSchemeReceivables`
→ refresh. `asOf` defaults to **now + 24h** so the jobs' "yesterday"
window is today — the canary's transactions are minutes old.
Exposed as worker script `nightly:once`; the same primitive fixes the
"shorten the interval env vars to demo" annoyance from Phases 13–17.

### Wiring

- Root script `canary` → `pnpm --filter @psp-new/api canary`.
- `Makefile` `e2e` target becomes: source `.env`, `pnpm smoke`
  (unchanged Phase 0 checks), then `pnpm canary`. Help text updated.

## Out of scope

- 3DS challenge flow in the canary (browser-dependent; the Playwright
  spec covers hosted fields separately).
- Issuing-side loop (cardholder/card/load) — the Phase 9 demo path;
  a future canary extension.
- Webhook delivery assertion (needs outbox-relay + worker + receiver
  endpoint; the drainer/queue path has its own DB-gated tests).
- CI wiring of `make e2e` (compose-in-CI is its own phase).

## Files touched

| File | Change |
|---|---|
| `apps/api/cli/e2e-canary.ts` | new |
| `apps/api/package.json` | + `canary` script |
| `apps/worker/cli/nightly-once.ts` | new |
| `apps/worker/package.json` | + `nightly:once` script |
| `package.json` | + `canary` script |
| `Makefile` | `e2e` chains smoke + canary |

No migrations, no dep changes.

## Verify steps

| Check | Expected |
|---|---|
| `make up` then `make e2e` | smoke PASS + canary PASS table, exit 0 |
| Canary re-run | PASS again (fresh merchant per run; jobs idempotent same-day) |
| `pnpm typecheck` / `pnpm test` | 60/60 each |
