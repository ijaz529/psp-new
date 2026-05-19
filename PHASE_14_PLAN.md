# Phase 14 — Pool reconciliation worker (Plan)

**Status:** Proposed for review · **Predecessor:** Phase 13 (`PHASE_13_DONE.md`).

Phase 11 documented a known accounting deferral: card-loads via the acquiring
side post `cardholder_funded +X / issuer_funded_pool -X`. The pool's running
deficit grows on every load and never recovers. Phase 14 fills that gap.

---

## End-to-end goal

```
                          worker (every 1h)
                                │
                                ▼
       paycore.card_loads  where status='succeeded'
       AND reconciled_at IS NULL
                                │
              for each unreconciled load ↓
                                │
              ┌─────────────────────────────────┐
              │ post journal:                   │
              │   issuer_funded_pool +X         │  (deficit recovers)
              │   psp_cash_at_bank   -X         │  (PSP cash funds the pool)
              │ update card_loads:              │
              │   reconciled_at = now()         │
              └─────────────────────────────────┘
```

Same 2-leg pattern Phase 6 payouts use (`merchant_settlement_liability +X`,
`psp_cash_at_bank -X`). No new accounts. The economic story: PSP advanced
funds to the cardholder via the pool at load time, and now PSP uses its bank
cash to refill the pool. In real life PSP's cash would be replenished by
scheme settlement files arriving days later — that part stays deferred
(see §Out of scope).

---

## Pieces

| Piece | What | Where |
|---|---|---|
| **0020 migration** | Add `reconciled_at timestamptz` (nullable) to `paycore.card_loads`, plus a partial index `(reconciled_at) where reconciled_at IS NULL` for the sweep | `packages/db/migrations/0020_card_loads_reconciliation.sql` |
| **Kysely type** | Add the new column | `packages/db/src/kysely.ts` |
| **`reconcileCardLoads`** | Pure function. Per-row txn: post 2-leg journal + set `reconciled_at`. Idempotency rides journal `externalId='card_load_recon:${load.id}'` | `apps/worker/src/pool-reconciliation-job.ts` (NEW) |
| **`setInterval` wiring** | Schedule the job alongside the existing nightly + balance + auth-expiry timers | `apps/worker/src/index.ts` |
| **Integration test** | HAS_DB-gated: seed a succeeded card_load with `reconciled_at IS NULL`, run sweeper, assert pool refilled + cash drained + row marked | `apps/worker/src/pool-reconciliation-job.test.ts` (NEW) |

Zero new accounts. Zero new packages. The `psp_cash_at_bank` and
`issuer_funded_pool` accounts both already exist (chart-of-accounts seeded
in 0009 and 0017).

---

## Schema delta (0020)

```sql
alter table paycore.card_loads
  add column reconciled_at timestamptz;

create index card_loads_unreconciled_idx
  on paycore.card_loads (created_at)
  where reconciled_at is null and status = 'succeeded';
```

Failed loads never need reconciliation (no journal was posted to begin
with), so the partial index narrows on `status='succeeded'` too.

---

## Function shape

```ts
export interface ReconcileDeps {
  readonly db: Kysely<Database>;
  readonly logger: Logger;
}

export interface ReconcileResult {
  readonly scanned: number;
  readonly reconciled: number;
}

export async function reconcileCardLoads(
  deps: ReconcileDeps,
  asOf: Date = new Date(),
): Promise<ReconcileResult>;
```

Per-row transaction (matches the Phase 13 auth-expiry pattern). On
unique-constraint violation from the externalId, the row is treated as
already-reconciled and the loop continues.

---

## Wiring

`apps/worker/src/index.ts` gains a third sweeper timer:

```ts
const reconIntervalMs = Number.parseInt(process.env.POOL_RECON_INTERVAL_MS ?? '3600000', 10); // 1h
const reconTimer = setInterval(() => {
  reconcileCardLoads({ db, logger })
    .catch((err) => logger.error({ err }, 'pool-reconciliation job crashed'));
}, reconIntervalMs);
```

Default cadence is 1h (faster than the 6h auth-expiry sweep — pool drift
should heal quickly so the running balance reports stay accurate).

---

## Out of scope (deferred)

- **Scheme settlement → `psp_cash_at_bank` inflow.** In real life the cash
  PSP uses to refill the pool would itself come from scheme settlement
  files for the original card-load 0200 messages. Phase 11 deferred the
  acquiring-side accounting; Phase 14 refills the pool but does not model
  the scheme settlement cash inflow. `psp_cash_at_bank` continues to drift
  negative the same way it does for merchant payouts (Phase 6 has the same
  property).
- **Batched journal per sweep cycle.** Per-row journals are fine for the
  demo volume. A real volume would batch into one per `(currency, day)`.
- **Reversal of reconciliation if the card_load is later voided.** Card
  loads have no void/refund path yet (Phase 11 §Out of scope), so this is
  moot.
- **`card_load.reconciled` webhook.** Same answer as every other cardholder
  webhook: deferred until cardholder identity surface exists.
- **Distributed leader election.** Same answer as the Phase 13 sweeper —
  single-worker `setInterval` is fine for dev; BullMQ repeatable + advisory
  lock for prod is a future concern.

---

## Verifiable success criteria

1. `pnpm typecheck` + `pnpm test` green across all 60 packages.
2. `pool-reconciliation-job.test.ts` (HAS_DB-gated):
   - Seed a `paycore.card_loads` row (status='succeeded', reconciled_at
     null) by performing the Phase 11 load journal manually.
   - Run sweeper.
   - Assert `card_loads.reconciled_at` is non-null, `issuer_funded_pool`
     balance returned to its pre-load value, `psp_cash_at_bank` decreased
     by the load amount.
   - Re-run is a clean no-op.
3. Failed loads (status='failed') are NOT processed.

---

## Open questions

None — design is locked. Ready to build on approval.
