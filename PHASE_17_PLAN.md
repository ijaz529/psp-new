# Phase 17 — Card-load acquiring-leg sweeper (Plan)

**Status:** Proposed for review · **Predecessor:** Phase 16 (`PHASE_16_DONE.md`).

Closes the Phase 11 acquiring-side deferral. After this lands, every
card load via the acquiring side (`POST /v1/cards/:id/load`) has a
complete, balanced accounting story across all four ledger sweepers.

---

## Scope rethink (read first)

In earlier DONE docs I labeled this as a *"`cardholder_funded` ASSET →
LIABILITY refactor"*. On closer reading that was overscoped. The simpler
approach: add a **new** worker that posts the missing acquiring-side leg
(`scheme_receivable +X / external_load_clearing -X`) for each reconciled
card load. Phase 15's existing scheme-settlement sweeper then drains the
receivable as normal.

After all four sweepers run for a load:

| Account | Movement | Final |
|---|---|---|
| `cardholder_funded[card]` (Phase 11) | +X | +X |
| `issuer_funded_pool[currency]` (Phase 11 −X, Phase 14 +X) | net 0 | 0 |
| `psp_cash_at_bank[currency]` (Phase 14 −X, Phase 15 +X) | net 0 | 0 |
| `scheme_receivable[scheme, currency]` (Phase 17 +X, Phase 15 −X) | net 0 | 0 |
| `external_load_clearing[currency]` (Phase 17 −X) | −X | −X |

Net per load: `cardholder_funded +X` (ASSET balance up) offset by
`external_load_clearing -X` (LIABILITY balance more negative = PSP owes
more via stored value). **Sum = 0.** Books balance. No refactor.

The pre-existing `cardholder_funded` "ASSET label, balance-up convention"
stays as-is — the cardholder display continues to work without changes
to the issuer-host, CLI, portal, or any other consumer.

---

## Pieces

| Piece | What | Where |
|---|---|---|
| **0022 migration** | Seed `external_load_clearing` LIABILITY account per currency (`owner_kind='psp'`); add `acquiring_reconciled_at timestamptz` (nullable) to `paycore.card_loads`; partial index for the sweep | `packages/db/migrations/0022_card_loads_acquiring_leg.sql` |
| **Kysely type** | New column | `packages/db/src/kysely.ts` |
| **`reconcileCardLoadAcquiring`** | Pure function. Scans `card_loads` where `status='succeeded' AND acquiring_reconciled_at IS NULL`, joins `payment_methods` for `scheme`. Per row: post `scheme_receivable[scheme, currency] +X / external_load_clearing[currency] -X` + set `acquiring_reconciled_at`. Idempotent via journal `externalId='card_load_acq:${load.id}'`. | `apps/worker/src/card-load-acquiring-job.ts` (NEW) |
| **`setInterval` wiring** | Schedule alongside the existing sweepers; default 30min cadence | `apps/worker/src/index.ts` |
| **Integration test** | HAS_DB-gated: seed a succeeded card_load, run sweeper, assert balances move; failed/already-reconciled loads ignored; re-run no-op | `apps/worker/src/card-load-acquiring-job.test.ts` (NEW) |

Zero changes to Phase 11 / 14 / 15 logic. Zero changes to issuer-host /
CLI / portal / balance reads.

---

## Schema delta (0022)

```sql
-- Per-currency external-load clearing account (LIABILITY, psp-owned).
-- Carries the running balance of PSP-owes-cardholders-via-acquiring-source
-- until that obligation is offset by the cardholder spending the balance
-- (which happens via the issuer-host hold lifecycle from Phase 10/16).
with currencies(code) as (values ('USD'), ('EUR'), ('GBP'), ('AED'), ('INR'))
insert into ledger.accounts (id, code, type, currency, owner_kind, owner_id)
select
  ledger._acct_id('external_load_clearing:' || code || ':psp:'),
  'external_load_clearing',
  'LIABILITY',
  code,
  'psp',
  null
from currencies;

alter table paycore.card_loads
  add column acquiring_reconciled_at timestamptz;

create index card_loads_acquiring_unreconciled_idx
  on paycore.card_loads (created_at)
  where acquiring_reconciled_at is null and status = 'succeeded';
```

The partial index narrows the scan to exactly the rows that need work,
matching the Phase 14 pattern (`card_loads_unreconciled_idx`).

---

## Function shape

```ts
export interface CardLoadAcquiringDeps {
  readonly db: Kysely<Database>;
  readonly logger: Logger;
}

export interface CardLoadAcquiringResult {
  readonly scanned: number;
  readonly reconciled: number;
}

export async function reconcileCardLoadAcquiring(
  deps: CardLoadAcquiringDeps,
  asOf: Date = new Date(),
): Promise<CardLoadAcquiringResult>;
```

Per-row transaction. On journal-uniqueness violation, the row is treated
as already-reconciled and the loop continues. Same shape as Phases 13/14/15.

---

## Wiring

`apps/worker/src/index.ts` gains a fifth sweeper timer:

```ts
const acquiringIntervalMs = Number.parseInt(process.env.CARD_LOAD_ACQ_INTERVAL_MS ?? '1800000', 10); // 30min
const acquiringTimer = setInterval(() => {
  reconcileCardLoadAcquiring({ db, logger })
    .catch((err) => logger.error({ err }, 'card-load-acquiring job crashed'));
}, acquiringIntervalMs);
```

30min cadence — between Phase 14 (1h pool reconciliation) and Phase 13
(6h auth expiry). It's fine to run more frequently; the work is small.

---

## End-to-end demo path

```bash
make up && make migrate
docker compose up -d worker

# Load via the acquiring side (Phase 11)
pnpm cardholder:create --email demo@example.com --name "Demo"
pnpm card:issue --cardholder <ch_…> --product prod_strawberry_visa_usd
# Tokenize external visa, attach as pm_…
curl -X POST $API/v1/cards/<card_…>/load -H "Authorization: Bearer sk_test_…" \
  -d '{"amount":5000,"currency":"USD","payment_method":"pm_…"}'

# Speed up all sweepers for the demo
POOL_RECON_INTERVAL_MS=10000 CARD_LOAD_ACQ_INTERVAL_MS=10000 \
  SCHEME_SETTLE_INTERVAL_MS=10000 docker compose restart worker

# Wait ~30s, then inspect
pnpm ledger:balance cardholder_funded:USD:issuer:<card_…>    # → +50.00
pnpm ledger:balance issuer_funded_pool:USD:psp                #  → 0
pnpm ledger:balance psp_cash_at_bank:USD:psp                  # → 0 (net)
pnpm ledger:balance scheme_receivable:USD:scheme:visa         # → 0 (net)
pnpm ledger:balance external_load_clearing:USD:psp            # → -50.00
# cardholder_funded +50, external_load_clearing -50 → books balance
```

---

## Out of scope (deferred)

- **Per-card stored-value account.** A cleaner version would create
  `cardholder_stored_value` per-card (LIABILITY) alongside the per-card
  `cardholder_funded` ASSET, giving exact 1:1 books per cardholder. We use
  a PSP-level `external_load_clearing` instead — simpler, but back-office
  reporting only sees the aggregate. Future phase if granular cardholder
  liability tracking becomes important.
- **Real scheme-fee netting on the acquiring leg.** Phase 11 doesn't
  charge MDR on loads (the `loadCard` orchestrator posts no fee). Real PSPs
  would deduct interchange + scheme fees from the scheme settlement,
  meaning `scheme_receivable +X − fees`. We assume gross.
- **CLI-load reconciliation.** The legacy `pnpm card:load` CLI posts
  `cardholder_funded +X / issuer_funded_pool -X` directly and doesn't
  write a `paycore.card_loads` row. So Phase 17 doesn't touch CLI loads.
  In the demo, CLI loads continue to grow the pool deficit (as before
  Phase 14); only acquiring loads get the full reconciliation chain.
- **Reversal of acquiring reconciliation.** Card loads have no
  void/refund path (Phase 11 §Out of scope still). If a load is later
  charged back, the books wouldn't auto-correct.

---

## Verifiable success criteria

1. `pnpm typecheck` + `pnpm test` green across all 60 packages.
2. `card-load-acquiring-job.test.ts` (HAS_DB-gated):
   - Seed a succeeded card_load with payment_method scheme='visa'.
   - Run sweeper → `scheme_receivable[visa, USD]` and
     `external_load_clearing[USD]` move by the load amount;
     `acquiring_reconciled_at` set on the row.
   - Failed loads (`status='failed'`) ignored.
   - Re-run is no-op.
3. End-to-end (when compose is up): all five sweepers run; net
   ledger balance per load is `cardholder_funded +X` /
   `external_load_clearing -X`, all intermediates zero.
