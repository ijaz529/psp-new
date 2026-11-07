# Phase 49 — Done

**Date:** 2026-11-07 · **Status:** the issuer decides on the live ledger,
inside the transaction that spends the money. Plan: `PHASE_49_PLAN.md`.

## The bug, reproduced and then fixed

Through the real API and the real ISO 8583 wire:

| | before | after |
|---|---|---|
| load 500.00 USD onto a fresh card | succeeded | succeeded |
| spend 10.00 on it immediately, no refresh | **failed — "insufficient funds"** | **succeeded** |
| spend 90,000.00 (over the balance) | — | failed — "insufficient funds" |

At the moment of the old decline:

| | value |
|---|---|
| `sum(journal_lines.amount)` for the card's funded account | **50000** |
| `account_balances.balance` for that account | **no row at all** |

`readAvailableBalance` read the materialized view, found nothing,
coalesced to `0`, and `evaluateAuthControls` declined RC 51. The view is
rebuilt by a worker every `BALANCE_REFRESH_MS` (5 minutes by default), and
an account created after the last rebuild is not in it — so a just-funded
card was unspendable, and `refresh materialized view` alone turned the
decline into an approval with nothing else changed.

## What shipped

### `apps/issuer-host/src/handler.ts`

- **`readAvailableBalance` sums `ledger.journal_lines`** instead of reading
  `ledger.account_balances`. `journal_lines_account_idx` already exists and
  a single card's funded account carries a handful of rows — one per load,
  hold, capture and reversal — so this is an index scan per authorization,
  the same shape `runPayout` has done per merchant account since Phase 43.
- **The decision moved inside the transaction that writes the hold**, with
  `select … for update` on the card row first. The balance read, the
  controls evaluation and the hold are now one atomic, serialised unit. A
  check taken outside the transaction that spends the money guards
  nothing: two concurrent authorizations could both read the same figure
  and both approve. Fixing staleness without this would have been half a
  fix.
- The decline path returns out of the transaction having written nothing;
  response building stays where it was.

The materialized view is untouched and still serves the portal and the
Phase 24 sweep, which can afford to be a refresh behind. Phase 43 drew
this line for payouts and wrote down why; the authorization path simply
never followed.

### `apps/issuer-host/src/handler.test.ts`

- **Dropped the `beforeEach` matview refresh.** Phase 47 added it to work
  around this exact bug; leaving it would have masked any regression of
  the fix. `bal()` keeps its own refresh — it asserts against the view
  deliberately, which now doubles as a check that view and ledger agree.
- Two new tests, last in the file because the first authorizes the whole
  live balance and would otherwise starve every test after it:
  - *approves against funds the view has not caught up with yet* —
    refreshes the view, moves money without telling it, then asks for the
    whole live balance. **Red without the handler change.**
  - *still declines RC 51 over the live balance* — the number has to work
    as a limit, not merely as a presence check.

## Verify

| Check | Result |
|---|---|
| New test red without the handler change | 1 failed, 11 passed |
| Suite with the change | **12/12** |
| Suite run three times against the same database | 12/12 each — Phase 48 still holds |
| Live: load then spend immediately, no refresh | succeeded |
| Live: spend over the balance | declined, insufficient funds |
| `pnpm exec biome check` on changed files | clean |
| `pnpm typecheck` | 60/60 |
| `pnpm test`, fresh database, `--force` | 60/60 |
| `make reset-db && make migrate && make e2e` | canary **11/11** |

## One thing I could not pin down

Two full-suite runs early in this phase failed — once in
`@psp-new/outbox-relay`, once in `@psp-new/worker`, neither of which this
change touches. Both packages passed immediately when run alone, and six
subsequent full runs were green, including two with the `worker` and
`outbox-relay` containers stopped. The failures came right after the live
load-and-spend work, which had just written events the running
`outbox-relay` container would drain, against the same tables those tests
assert on.

So: most likely the compose stack's background writers racing the suite,
which is a standing hazard of testing against the shared dev database and
not something this phase introduced — but I could not reproduce it on
demand, so it is recorded rather than claimed closed.

## What did NOT change

- No migration, no dependency, no API change.
- The capture and reversal paths. They resolve a known hold by
  `(stan, rrn)` and post against it; neither consults a balance.
- `findCardByPan` still matching on bin + last4 alone, unordered
  (Phase 48's remaining item). Unrelated to balances; the real fix is a
  PAN-token lookup, which `cards.pan_token` cannot support today.
- The materialized view itself, and its other readers.

## Still open

- `findCardByPan`'s bin + last4 matching.
- The intermittent full-suite failures described above.
- Nothing is pushed. Fifteen commits now sit on `main` locally.
- `PORTAL_DEMO_PASSWORD` was echoed into a terminal during Phase 45 and
  should still be rotated.

## Open list (carried)

- Map Fastify's empty-JSON-body error to 400 (Phase 41 finding).
- Vault-in-harness for tokens/payment-method/3DS test breadth.
- CI job that runs `make e2e` against compose.
- Payouts: `listPayoutCandidates` windows on PI `created_at`; reserves;
  `merchants.payout_schedule` ignored (Phase 43).
- Portal detail pages for payouts and disputes; dispute actions.
- `packages/risk-rules` written but wired into nothing.
