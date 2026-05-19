# Phase 21 — Auto-adjust on clearing ingest (Plan)

**Status:** Proposed for review · **Predecessor:** Phase 20 (`PHASE_20_DONE.md`).

Phase 20 ships the parser + reconciler + CLI as **report-only**: the
operator sees the discrepancy, decides what to do. This phase adds an
opt-in `--auto-adjust` flag that posts a single adjustment journal
per (scheme, currency) to true up `scheme_receivable` against the file.

---

## Scope

Opt-in only. Default behaviour unchanged from Phase 20 (report, no
journals). With `--auto-adjust`:

- For each (scheme, currency) combo represented in the parsed file, sum
  the net delta = `Σ file_amount − Σ ledger_amount` (positive: file is
  higher, ledger needs adjusting up; negative: lower, adjust down).
- If delta != 0, post one journal:
  - `scheme_receivable[scheme, currency]  +delta`
  - `clearing_adjustments[currency]       -delta`
  - Sum = 0 ✓

The `clearing_adjustments` LIABILITY (new account, per currency)
absorbs the cumulative adjustment. Operators can later sweep it
manually or extend a future worker to net it against `psp_cash_at_bank`
once the discrepancy resolves.

Adjustments cover **both** missing-from-ledger records and
amount-mismatches in one journal per (scheme, currency).

---

## Pieces

| Piece | What | Where |
|---|---|---|
| **0024 migration** | Seed `clearing_adjustments` LIABILITY per currency | `packages/db/migrations/0024_clearing_adjustments.sql` |
| **`postClearingAdjustments`** | New exported function. Takes parsed records + a report (or recomputes), groups by (scheme, currency), posts adjustment journals. Returns the journal entries. Idempotent via deterministic `externalId` per (file-hash, scheme, currency). | `packages/clearing-files/src/index.ts` |
| **CLI `--auto-adjust`** | New flag. When set + report.clean=false, calls postClearingAdjustments. Prints the adjustment summary. | `apps/api/cli/clearing-ingest.ts` |
| **Unit tests** | Cover postClearingAdjustments: clean report → no journals; mismatch → adjustment posted with correct sign; missing-from-ledger → adjustment treated as missing amount delta | `packages/clearing-files/src/index.test.ts` (extend) |

---

## Schema delta (0024)

```sql
with currencies(code) as (values ('USD'), ('EUR'), ('GBP'), ('AED'), ('INR'))
insert into ledger.accounts (id, code, type, currency, owner_kind, owner_id)
select
  ledger._acct_id('clearing_adjustments:' || c.code || ':psp:'),
  'clearing_adjustments',
  'LIABILITY',
  c.code,
  'psp',
  null
from currencies c;
```

No new tables. The journal-uniqueness on
`externalId = 'clearing_adjust:${fileHash}:${scheme}:${currency}'` is
how we prevent double-posting if the operator re-runs the CLI on the
same file.

---

## Function shape

```ts
export interface AdjustmentJournal {
  readonly scheme: 'visa' | 'mastercard' | 'amex';
  readonly currency: string;
  readonly delta: bigint; // signed; +X = ledger went up to match file
  readonly journalEntryId: string;
}

export async function postClearingAdjustments(
  db: Kysely<Database>,
  parsed: ReadonlyArray<ClearingTransaction>,
  report: ReconciliationReport,
  fileHash: string, // deterministic key per file (e.g. SHA-256 of contents)
): Promise<AdjustmentJournal[]>;
```

Implementation notes:
- Group `parsed` by (scheme, currency). For each group, compute
  `Σ file_amount` from `parsed` and `Σ ledger_amount` from
  `paycore.clearing_records` for the RRNs in the group.
- Single bulk SELECT (same shape as `reconcileClearingFile`).
- Per-(scheme, currency) per-txn so one bad group doesn't poison the
  whole run.
- `delta = 0` → skip (no journal).
- Catch `pg.unique_violation` for the `externalId` and treat as
  already-adjusted.

---

## CLI flow

```
pnpm clearing:ingest --path tampered.csv --auto-adjust

Parsing tampered.csv (visa_base2)…
  → 12 records parsed
Reconciling against paycore.clearing_records…
  matched           : 11
  missing-from-ledger: 1
    - 601201000007
  amount-mismatches  : 1
    - 601201000003  file=$30.00 ledger=$25.00
  status: discrepancies found ✗

Posting adjustments (--auto-adjust)…
  visa / USD : delta=+$55.00  → je_…
  status: 1 adjustment posted

(exits 0 — clean after adjustment)
```

Without `--auto-adjust`, the bottom block is skipped and the CLI exits
1 as in Phase 20.

---

## Out of scope (deferred)

- **Selective adjustment.** All-or-nothing per (scheme, currency). A
  future phase could let the operator approve individual rows.
- **Reversing an adjustment.** If a posted adjustment was wrong (e.g.,
  the file was tampered), the operator manually posts the reverse.
- **`clearing.adjustment_posted` webhook.** Useful for real ops; not
  Phase 21's scope.
- **Sweeping `clearing_adjustments` to `psp_cash_at_bank`.** Once an
  adjustment is "real" (scheme really did settle the file's amount),
  the clearing_adjustments balance should drain to cash. That's a
  manual journal for now.
- **Auto-adjust on the cron worker.** This phase only adds the flag to
  the manual CLI. Promoting it to a scheduled worker would need a
  default policy (always adjust? above some threshold?) — best left as
  human-in-the-loop.

---

## Verifiable success criteria

1. `pnpm typecheck` + `pnpm test` green across all 60 packages.
2. New unit test cases on `postClearingAdjustments`:
   - Clean report → returns `[]`, no journal-side effects.
   - Single amount-mismatch (file higher than ledger) → single journal
     posted, `delta = +5n`, scheme_receivable += 5, clearing_adjustments
     -= 5.
   - Missing-from-ledger → treated as the file's full amount delta.
   - Mix across two (scheme, currency) combos → 2 journals.
   - Re-run with same fileHash → no new journals (idempotent).
3. End-to-end (manual, when compose is up): Phase 20 demo with
   `--auto-adjust` produces an adjustment row visible via
   `select * from ledger.journal_entries where external_id like 'clearing_adjust:%' order by created_at desc limit 5;`.
