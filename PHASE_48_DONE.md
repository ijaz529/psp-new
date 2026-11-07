# Phase 48 — Done

**Date:** 2026-11-07 · **Status:** the issuer-host integration suite passes
every run, not just the first. Plan: `PHASE_48_PLAN.md`.

## What shipped

One test file, `apps/issuer-host/src/handler.test.ts`. No production code.

### A per-run card

`beforeAll` now claims a `last4` that no `paycore.cards` row is using and
builds the PAN from it:

```
LAST4 = await claimFreeLast4(db);
PAN   = `${BIN}000999${LAST4}`;
```

Only the last4 varies. The first 9 digits stay `411111000`, inside
`prod_strawberry_visa_usd`'s `411111000`–`411111999`, which is the prefix
`panInRange` checks — so routing is untouched whatever the last4 is.
Nothing in the issuer-host path Luhn-checks the PAN; the test builds the
ISO message directly.

Claiming rather than randomising: a random 4-digit last4 is about 50% to
collide after a hundred runs against a long-lived dev database, which
would bring this bug back intermittently — the worst kind. The loop throws
a clear error if the space is genuinely full instead of failing later as a
baffling RC 51.

### A wider RRN prefix

Phase 47's `RUN` was `Date.now() % 10_000`, which wraps every 10 seconds,
so two runs started a multiple of 10s apart still collided on
`card_auth_holds`' unique `(stan, rrn)`. Now 8 digits, with the per-test
discriminator taking the literal's last 4 — the eight in use (`0100`,
`0200`, `0220`, `0420`, `0094`, `6001`, `6010`, `6020`) are all distinct.

## The bug, for the record

The suite hardcoded one PAN, so every run inserted another card with the
same `bin`/`last4`. `findCardByPan` (`handler.ts:288`) matches on those
alone:

```sql
select … from paycore.cards where bin = $1 and last4 = $2
```

with no ordering, then returns the first row whose PAN falls in the
product's BIN range. With several such rows the winner is whatever order
Postgres returns — in practice the earliest run's card, whose accounts hold
nothing. Run 2 therefore authorized against run 1's empty card, declined
**RC 51**, and every balance assertion after it compared the wrong
accounts.

Phase 47 had fixed the two other reasons this suite was red — the
unrefreshed materialized view and the fixed `(stan, rrn)` pairs — which is
why run 1 was green and run 2 was not.

## Verify

| Check | Result |
|---|---|
| Suite, run 1 on a fresh database | 10/10 |
| Suite, runs 2–7 on that **same** database | 10/10 each |
| Distinct cards coexisting under BIN 411111 afterwards | 7, each with its own last4; 56 holds |
| `pnpm exec biome check` on the changed file | clean |
| `pnpm typecheck` | 60/60 |
| `pnpm test`, fresh database, `--force` | 60/60 |
| `pnpm test` again, **same** database, `--force` | 60/60 |
| `make reset-db && make migrate && make e2e` | canary **11/11** |

Seven consecutive runs is the phase. Before it, run 2 failed 8 of 10.

`--force` throughout, because turbo caches a green `test` task against the
package's input hash and not the database — which is how this suite stayed
red unnoticed until Phase 47 happened to invalidate its cache key.

## What did NOT change

- No production code, no migration, no dependency.
- **`findCardByPan` still matches on bin + last4 alone**, unordered. Two
  live cards can legitimately share them, and the handler would pick
  arbitrarily between them. The real fix is a PAN-token lookup, which
  `cards.pan_token` cannot support today — it is a dangling ULID with no
  vault row. A phase of its own.
- **The issuer still decides authorizations from a materialized view that
  can be five minutes stale** (`handler.ts:354 readAvailableBalance`). This
  is the more serious of the two findings Phase 47 recorded and it is still
  open: an issuer can approve spending the ledger says is not there. Phase
  43 deliberately moved payouts off that view for exactly this reason
  ("staleness is unacceptable in a money-moving path"); the auth path never
  followed.

## Still open

- The two issuer-host items above — the second one is production
  correctness, not test hygiene, and is the natural next phase.
- Nothing is pushed. Twelve commits now sit on `main` locally.
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
