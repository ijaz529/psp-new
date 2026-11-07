# Phase 48 — Plan: make the issuer-host suite re-runnable

**Date:** 2026-11-07 · **Status:** in progress.

## Goal

`apps/issuer-host`'s integration suite passes on run 1 against a fresh
database and fails on every run after that, against the same database.
Make it pass every time.

## The bug

`handler.test.ts` uses one hardcoded PAN:

```
const PAN = '4111110009999991';   const BIN = '411111';   const LAST4 = '9991';
```

Every run inserts another `paycore.cards` row carrying that same
`bin`/`last4`. The handler finds a card by **bin + last4 alone**
(`handler.ts:288 findCardByPan`), with no ordering:

```sql
select … from paycore.cards
 where bin = $1 and last4 = $2
```

then returns the first row whose PAN falls inside the product's BIN range.
With several such rows the winner is whatever order Postgres happens to
return, which in practice is the earliest run's card — whose accounts hold
nothing. So run 2 authorizes against run 1's empty card and declines
**RC 51**, and the balance assertions that follow compare against the
wrong accounts.

Phase 47 fixed the two *other* reasons this suite was red — the
unrefreshed materialized view and the fixed `(stan, rrn)` pairs — which is
why run 1 is now green. This is what is left.

## The fix

Claim a `last4` that no card is using, in `beforeAll`, and build the PAN
from it:

```
PAN = BIN + '000999' + LAST4
```

The first 9 digits stay `411111000`, inside `prod_strawberry_visa_usd`'s
range (`411111000`–`411111999`, matched on a 9-digit prefix by
`panInRange`), so routing is unaffected whatever the last4 is. Nothing in
the issuer-host path Luhn-checks the PAN — the test builds the ISO message
directly — so only the digits' shape matters.

Claiming rather than randomising: a random 4-digit last4 collides with
probability ~50% after a hundred runs against a long-lived dev database,
which would reintroduce exactly this bug intermittently. Querying for a
free one makes it impossible, and the loop throws a clear error if the
space is genuinely full rather than failing later as RC 51.

The Phase 47 `RUN`/`rrn12` prefix stays: `card_auth_holds` has a unique
`(stan, rrn)` that is global, not per card, so a per-run card does not
make it redundant.

## Out of scope

- **`findCardByPan` matching on bin + last4 at all.** Two live cards can
  legitimately share them, and the real fix is a PAN-token lookup —
  `cards.pan_token` is a dangling ULID with no vault row today, so that is
  a phase of its own, not a test fix.
- **The issuer deciding authorizations from a 5-minute-stale materialized
  view** (`handler.ts:354`). The more serious of the two findings Phase 47
  recorded, and untouched here. Noted again in the DONE.
- Any production code. This phase changes one test file.

## Files touched

| File | Change |
|---|---|
| `PHASE_48_PLAN.md` | this doc (commit 1) |
| `apps/issuer-host/src/handler.test.ts` | per-run card (commit 2) |
| `PHASE_48_DONE.md` | write-up (commit 3) |

## Verify steps

| # | Step | Pass condition |
|---|---|---|
| 1 | Suite, run 1 against a fresh database | 10/10 |
| 2 | Suite, runs 2 and 3 against that **same** database | 10/10 each — the thing that fails today |
| 3 | Several cards now coexist under BIN 411111 with distinct last4 | confirmed by query |
| 4 | `pnpm exec biome check` on the changed file | clean |
| 5 | `pnpm typecheck` | 60/60 |
| 6 | `pnpm test` on a fresh database, `--force` | 60/60 |
| 7 | `make reset-db && make migrate && make e2e` | canary 11/11 |

Step 2 is the phase. Everything else is making sure nothing else moved.

`--force` on step 6 because turbo caches a green `test` task against the
package's input hash, not the database — which is how this suite stayed
red for so long without anyone seeing it (Phase 47).
