# Phase 24 — Auto-sweep `clearing_adjustments` to revenue (Plan)

**Status:** Proposed for review · **Predecessor:** Phase 23 (`PHASE_23_DONE.md`).

Completes the Phase 21 chain. After Phase 21 posts an adjustment and
Phase 15 settles the matching scheme_receivable to cash, the
`clearing_adjustments` LIABILITY is left dangling at the delta. Phase 24
sweeps it to a new `adjustment_revenue` REVENUE account, recognizing
the adjustment as final income (or expense, if the delta was negative).

---

## Accounting trace

Scenario: clearing file says scheme will settle $5500 more than ledger
expected.

| Step | Journal | After: scheme_receivable | clearing_adjustments | psp_cash_at_bank | adjustment_revenue |
|---|---|---|---|---|---|
| Phase 21 auto-adjust | scheme_receivable +5500 / clearing_adjustments −5500 | +5500 | −5500 | 0 | 0 |
| Phase 15 scheme settle | scheme_receivable −5500 / psp_cash_at_bank +5500 | 0 | −5500 | +5500 | 0 |
| **Phase 24 sweep** | **clearing_adjustments +5500 / adjustment_revenue −5500** | 0 | 0 | +5500 | −5500 |

Final state: $5500 cash gained, $5500 revenue recognized. Books
balance (asset = revenue). Clearing absorbed and released cleanly.

The mirror works for negative deltas (file said scheme will settle
less than ledger expected): adjustment_revenue ends positive, meaning
expense.

---

## Pieces

| Piece | What | Where |
|---|---|---|
| **0027 migration** | Seed `adjustment_revenue` REVENUE per currency (psp-owned) | `packages/db/migrations/0027_adjustment_revenue.sql` |
| **`sweepClearingAdjustments`** | Worker function: scan non-zero `clearing_adjustments` balances per currency, post `clearing_adjustments −balance / adjustment_revenue +balance` per combo (flipping the sign so delta moves clearing to 0 and recognizes revenue) | `apps/worker/src/clearing-adjustments-sweep-job.ts` (NEW) |
| **`setInterval` wiring** | Daily cadence (`CLEARING_SWEEP_INTERVAL_MS`, default 86400000) | `apps/worker/src/index.ts` |
| **Test** | HAS_DB-gated: seed a clearing_adjustments balance, run sweeper, assert it zeros out and adjustment_revenue moved | `apps/worker/src/clearing-adjustments-sweep-job.test.ts` (NEW) |

Zero changes to Phase 21 logic. The clearing_adjustments account stays
as the in-flight holding; Phase 24 just drains it on schedule.

---

## Function shape

```ts
export interface SweepDeps {
  readonly db: Kysely<Database>;
  readonly logger: Logger;
}

export interface SweepResult {
  readonly scanned: number;     // currencies with non-zero balance
  readonly swept: number;       // currencies for which a journal was posted today
}

export async function sweepClearingAdjustments(
  deps: SweepDeps,
  asOf: Date = new Date(),
): Promise<SweepResult>;
```

Per-currency txn. Idempotency rides daily `externalId =
'clearing_sweep:${yyyymmdd}:${currency}'`. Re-running same UTC day is a
unique-violation no-op (matches Phase 15 pattern).

For each currency with non-zero `clearing_adjustments` balance:
- `balance < 0` (typical case — clearing reflects a "we owe" entry):
  post `clearing_adjustments +|balance| / adjustment_revenue −|balance|`.
  Drains clearing to 0; revenue balance goes more negative (in the
  codebase's "REVENUE balance < 0 = earned" convention, this means
  recognizing revenue).
- `balance > 0` (rare — clearing reflects expense): mirror.

Actually simplest formulation: post the EXACT NEGATION of the current
balance. `delta = -balance`. clearing_adjustments +delta, adjustment_revenue −delta.
Sum = 0 ✓. clearing_adjustments ends at 0 regardless of sign.

---

## Out of scope (deferred)

- **Cardholder webhooks**, `card.frozen` / `card.loaded` / etc. delivery
  — still open from Phase 22's unblock.
- **Detailed per-discrepancy tracking.** The sweep aggregates by
  currency. A future phase could link individual adjustments to
  individual settlements via a join table.
- **Configurable time window.** Phase 24 sweeps immediately on the
  daily cadence; a future version could wait N days for the matching
  scheme settlement to clear before sweeping.

---

## Verifiable success criteria

1. `pnpm typecheck` + `pnpm test` green across all 60 packages.
2. New HAS_DB-gated test: seed a clearing_adjustments balance via a
   raw journal, run sweep, assert clearing_adjustments = 0 and
   adjustment_revenue moved by the offsetting amount. Re-run same UTC
   day is a no-op.
