# Phase 37 — Plan

**Goal:** refunded card loads fan out into the nightly scheme files as
chargeback records — Visa Base II **TC 25**, Mastercard IPM **MTI
1442**. This is the "TC 25 / MTI 1442 chargeback scheme-file fan-out
from Phase 25" open-list item, carried since Phase 28/29 shipped the
formats with presentments only.

Today a Phase 25 refund flips `card_loads.status` to `'refunded'` and
posts the internal journal, but the scheme files never learn about it
— the money the schemes think they owe us diverges from the ledger by
every refunded load, and only the Phase 21/24 adjustment chain mops it
up blindly.

## Design

- **`ClearingTransaction.kind?: 'presentment' | 'chargeback'`** —
  optional; absent means presentment (keeps every existing caller,
  fixture, and round-trip test valid).
- **Base II**: `kind === 'chargeback'` emits TC 25 (TCR 0), same
  field layout. Parser accepts TC 05 and TC 25; chargebacks parse
  with `kind: 'chargeback'`, presentments parse without `kind` (so
  presentment round-trips stay byte-equal to old fixtures).
- **IPM**: MTI 1442 for chargebacks, same DE set. Parser accepts
  1240 and 1442, same kind convention.
- **Trailer totals stay gross** (sum of all record amounts, both
  kinds) — they are a count/integrity check, not a net settlement
  figure. Documented in both builders.
- **Collector** `collectCardLoadChargebacksForDate(db, date)` in
  `packages/clearing-files`: `card_loads ⨝ payment_methods` where
  `status = 'refunded'` and `refunded_at` in the UTC day window.
  Record shape: the `card_loads.id` (`cl_…`) rides the account
  identifier slot, `payment_methods.merchant_id` / `scheme`, the
  load's real `rrn` (deterministic fallback when NULL), positive
  amount, `occurredAt = refunded_at`.
- **Windowing needs a timestamp**: Phase 25's refund is a bare status
  flip. Migration **`0033_card_load_chargeback_clearing.sql`** adds
  nullable `card_loads.refunded_at`, stamped by the refund route in
  the same UPDATE. Pre-Phase-37 refunded loads keep NULL and are
  never fanned out (no backfill — their adjustments already flowed
  through Phase 21/24).
- **Same migration drops the FK**
  `clearing_records.payment_intent_id → payment_intents(id)`:
  chargeback records carry `cl_` ids in that slot. Real clearing
  records reference opaque scheme transactions, not one internal
  table; the column keeps its name and index.
- **Worker** `clearing-job.ts` collects presentments + chargebacks
  and emits them together (same files, grouped by scheme|currency as
  today).

## Out of scope

- Merchant-side PI refunds in clearing files (different flow — PI
  refunds post mirror journals; scheme-file representment for them is
  its own phase).
- Dispute lifecycle / `card_disputes` table (Phase 25 explicitly
  deferred; still deferred).
- Netting trailer totals; 1240 reversal messages.
- Backfill of `refunded_at`.

## Files touched

| File | Change |
|---|---|
| `packages/db/migrations/0033_card_load_chargeback_clearing.sql` | new |
| `packages/db/src/kysely.ts` | + `card_loads.refunded_at` |
| `apps/api/src/routes/v1/cards.ts` | stamp `refunded_at` |
| `packages/clearing-files/src/index.ts` | `kind`, collector |
| `packages/clearing-files/src/base2.ts` | TC 25 build/parse |
| `packages/clearing-files/src/ipm.ts` | MTI 1442 build/parse |
| `packages/clearing-files/src/index.test.ts` | + mixed-file round-trips, collector tests |
| `apps/worker/src/clearing-job.ts` | concat collections |

## Verify steps

| Check | Expected |
|---|---|
| Mixed-file round-trip tests red-first | fail before builder/parser changes |
| `pnpm --filter @psp-new/clearing-files exec vitest --run` | green |
| `pnpm typecheck` / `pnpm test` | 60/60 each |
| Migration + live fan-out | deferred to next stack boot (no local Postgres — same caveat as Phases 33/36) |
