# Phase 15 — Scheme settlement worker (Plan)

**Status:** Proposed for review · **Predecessor:** Phase 14 (`PHASE_14_DONE.md`).

Phase 6 merchant payouts and Phase 14 pool reconciliation both drain
`psp_cash_at_bank` without ever refilling it. In real life, schemes settle
to the PSP daily — cash arrives, offsetting receivables. Phase 15 ships
that worker.

---

## Honest scope (read before reading the rest)

When I sketched this in PHASE_14_DONE I said it "would close the Phase
14-introduced cash drift." That was slightly aspirational — here's the
accurate picture:

| Drift source | Posts to `scheme_receivable`? | Healed by Phase 15? |
|---|---|---|
| Phase 6 merchant payouts | YES — Phase 3 `capturePostings` posts `scheme_receivable +X` on every successful capture | ✅ YES |
| Phase 14 pool reconciliation | NO — Phase 11's `loadCard` deferred the acquiring-side accounting, so `scheme_receivable` is never +X for a card load | ❌ NO |

To heal the Phase 14 drift, we'd need to first close Phase 11's deferral
(re-label `cardholder_funded` as a LIABILITY and rework the load journal),
then a closed-loop scheme settlement would naturally cover it. That's a
separate phase. Phase 15 ships the simpler, accurate version: drain
`scheme_receivable` balances that genuinely accumulated.

---

## End-to-end goal

```
                          worker (every 24h)
                                │
                                ▼
       ledger.account_balances  where
       account.code = 'scheme_receivable' AND balance > 0
                                │
              for each (scheme, currency) row ↓
                                │
              ┌─────────────────────────────────┐
              │ post journal:                   │
              │   scheme_receivable −balance     │
              │   psp_cash_at_bank   +balance    │
              └─────────────────────────────────┘
```

Same 2-leg shape as Phase 6 payouts and Phase 14 reconciliation, just the
mirror direction (cash arrives instead of leaves).

---

## Pieces

| Piece | What | Where |
|---|---|---|
| **`settleSchemeReceivables`** | Pure function: query positive scheme_receivable balances, post per-(scheme,currency) drain journal | `apps/worker/src/scheme-settlement-job.ts` (NEW) |
| **`setInterval` wiring** | Daily cadence alongside the existing sweepers | `apps/worker/src/index.ts` |
| **Integration test** | HAS_DB-gated: seed a positive scheme_receivable, run sweeper, assert balances move, re-run same day is no-op | `apps/worker/src/scheme-settlement-job.test.ts` (NEW) |

Zero schema changes. Zero new accounts — `scheme_receivable` (per
scheme×currency) and `psp_cash_at_bank` (per currency) both seeded by Phase
6's `0009_chart_of_accounts.sql`.

---

## Function shape

```ts
export interface SchemeSettlementDeps {
  readonly db: Kysely<Database>;
  readonly logger: Logger;
}

export interface SchemeSettlementResult {
  readonly scanned: number;     // distinct (scheme, currency) combos with balance > 0
  readonly settled: number;     // distinct combos for which a journal was posted today
  readonly settledAmount: bigint; // total amount moved, summed across combos (single currency assumption broken — informational only)
}

export async function settleSchemeReceivables(
  deps: SchemeSettlementDeps,
  asOf: Date = new Date(),
): Promise<SchemeSettlementResult>;
```

Per-combo transaction (matches Phase 13 / Phase 14 patterns). Idempotency
rides the journal `externalId = 'scheme_settle:${yyyymmdd}:${scheme}:${currency}'` —
re-running on the same UTC day is a unique-violation no-op.

Sign convention follows the rest of the codebase: `scheme_receivable −X`
(ASSET balance goes from +X to 0) and `psp_cash_at_bank +X` (ASSET balance
up by X). Sum = 0 ✓.

---

## Wiring

`apps/worker/src/index.ts` gains a fourth sweeper timer:

```ts
const settleIntervalMs = Number.parseInt(process.env.SCHEME_SETTLE_INTERVAL_MS ?? '86400000', 10); // 24h
const settleTimer = setInterval(() => {
  settleSchemeReceivables({ db, logger })
    .catch((err) => logger.error({ err }, 'scheme-settlement job crashed'));
}, settleIntervalMs);
```

24h cadence matches Visa/MC's T+1 net-settlement model (close enough for
the demo).

---

## Out of scope (deferred)

- **Phase 14 cash drift.** Not healed here — requires Phase 11 deferral
  closeout. Documented above.
- **T+1 / T+2 settlement windows.** Real schemes settle a day or two after
  the capture date; we settle "current balance" without temporal cutoff.
  A future phase can add `cutoff_date` filtering once Phase 6 clearing
  files start carrying the capture date forward.
- **Scheme fees / interchange settlement.** Real settlements net out
  interchange and scheme fees against the PSP's receivable. We assume
  100% gross settlement.
- **Per-scheme settlement schedules.** Amex settles differently from
  Visa/MC. We sweep all schemes on the same cadence.
- **Multi-currency FX.** Each `(scheme, currency)` settles into the same
  `psp_cash_at_bank[currency]` bucket — no conversion to a single
  reporting currency.
- **Real clearing-file ingestion.** Phase 6 emits clearing files but we
  don't parse incoming ones. The sweeper just trusts the ledger balance.

---

## Verifiable success criteria

1. `pnpm typecheck` + `pnpm test` green across all 60 packages.
2. `scheme-settlement-job.test.ts` (HAS_DB-gated):
   - Seed a `scheme_receivable[visa, USD]` balance of +5000 by posting a
     mock capture journal.
   - Run sweeper. Assert `scheme_receivable[visa, USD] = 0` and
     `psp_cash_at_bank[USD]` increased by 5000.
   - Re-run within the same UTC day → no-op (idempotent via daily
     externalId).
3. Zero-balance schemes are NOT processed (no spurious journals).
