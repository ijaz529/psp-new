# Phase 49 — Plan: the issuer reads a live balance

**Date:** 2026-11-07 · **Status:** in progress.

## Goal

A cardholder cannot spend money that is demonstrably on their card. Stop
the issuer deciding authorizations from a materialized view that can be
five minutes behind the ledger.

## The bug, demonstrated

Through the real API and the real ISO 8583 wire, on 2026-11-07:

```
loaded 500.00 USD onto card_01M6SPYJ…          -> succeeded
spend 10.00 USD on that same card, immediately -> failed, "insufficient funds"
refresh materialized view ledger.account_balances
the same spend again                           -> succeeded
```

Nothing changed between the decline and the approval except the refresh.
The ledger's own numbers at the moment of the decline:

| | value |
|---|---|
| `sum(journal_lines.amount)` for the card's funded account | **50000** |
| `account_balances.balance` for that account | **no row at all** |

`readAvailableBalance` (`handler.ts:354`) reads the view, gets nothing,
coalesces to `0`, and `evaluateAuthControls` declines **RC 51**. The view
is refreshed by a periodic worker job (`BALANCE_REFRESH_MS`, default 5
minutes), so a freshly funded card is unspendable until that timer fires —
and a newly created account is not in the view at all.

Phase 43 made exactly this call for payouts and wrote it down: summed from
`journal_lines` "rather than the `ledger.account_balances` materialized
view: the view refreshes on a 5-minute timer, and paying out a stale
balance moves the wrong amount of money." The authorization path never
followed, though it is the same class of hazard pointing the other way —
here it refuses money that exists, and after a capture it could approve
money that does not.

## The fix

Follow the Phase 43 pattern: compute the balance from `ledger.journal_lines`,
inside the transaction that writes the hold.

Today the read sits at `handler.ts:71`, outside and before the transaction
that opens at line 88. Moving it inside closes two things at once:

1. **Staleness** — the sum is the ledger, not a snapshot of it.
2. **The check-then-act window** — a balance check only guards spending if
   nothing else can spend between the read and the hold. The decision and
   the hold become one atomic unit, and a `select … for update` on the
   card row serialises concurrent authorizations for that card. Without
   that, two simultaneous auths can both read the same balance and both
   approve; the fix would be half a fix.

Shape:

```
const decision = await deps.db.transaction().execute(async (trx) => {
  await lockCard(trx, card.id);                 // select … for update
  const available = await readAvailableBalance(trx, card.funded_account_id);
  const today     = await todayHoldsSum(trx, card.id);
  const d = evaluateAuthControls(…);
  if (d.outcome === 'decline') return d;        // nothing written
  …existing hold insert + postJournal, unchanged…
  return d;
});
```

Response building stays outside, as now. `readAvailableBalance` and
`todayHoldsSum` widen to accept a transaction.

### Cost

`journal_lines_account_idx` on `(account_id)` already exists, and a
per-card funded account carries a handful of rows — one per load, hold,
capture and reversal. This is an index scan over a few rows per
authorization, which is what `runPayout` already does per merchant
account. The materialized view stays where it is for the portal and the
Phase 24 sweep, which can afford to be a refresh behind.

## A test change that matters

`handler.test.ts` has a `beforeEach` that refreshes the view, added in
Phase 47 precisely to work around this bug. It must go: leaving it would
mask a regression of this very fix. `bal()` keeps its own refresh — it
asserts against the view deliberately, and that now doubles as a check
that the view and the ledger agree.

## Out of scope

- `findCardByPan` still matching on bin + last4 alone, unordered
  (Phase 48's remaining item). Unrelated to balances.
- The capture and reversal paths. They resolve a known hold by
  `(stan, rrn)` and post against it; neither consults a balance.
- Changing or removing the materialized view itself. Other readers want it.

## Files touched

| File | Change |
|---|---|
| `PHASE_49_PLAN.md` | this doc (commit 1) |
| `apps/issuer-host/src/handler.ts` | live balance, inside the transaction, with the card row locked (commit 2) |
| `apps/issuer-host/src/handler.test.ts` | drop the masking `beforeEach`; new tests (commit 2) |
| `PHASE_49_DONE.md` | write-up (commit 3) |

## Verify steps

| # | Step | Pass condition |
|---|---|---|
| 1 | New test: fund the card, do **not** refresh, authorize | approves — red before the fix, green after |
| 2 | New test: authorize for more than the funded balance, unrefreshed | declines RC 51 — proves the live number is used as a limit, not just a presence check |
| 3 | The existing 10 tests, with the `beforeEach` refresh removed | 10/10 |
| 4 | Suite run twice against the same database | 10/10 each (Phase 48 must still hold) |
| 5 | **Live**: load a card through the API, spend it immediately, no refresh | succeeds — the exact sequence that fails today |
| 6 | **Live**: spend more than the balance | declines, insufficient funds |
| 7 | `pnpm exec biome check` on changed files | clean |
| 8 | `pnpm typecheck` | 60/60 |
| 9 | `pnpm test`, fresh database, `--force` | 60/60 |
| 10 | `make reset-db && make migrate && make e2e` | canary 11/11 |

Step 5 is the phase: it is the sequence reproduced above, and it has to
come out the other way.
