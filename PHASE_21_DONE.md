# Phase 21 — Done

**Date:** 2026-05-19 · **Status:** Auto-adjust on clearing ingest landed. Plan: `PHASE_21_PLAN.md`.

Phase 20's clearing-file CLI was report-only. Phase 21 adds the opt-in
`--auto-adjust` flag that posts a true-up journal so the ledger matches
what the scheme actually settled.

## What shipped

- **Migration `0024_clearing_adjustments.sql`** — seeds a
  `clearing_adjustments` LIABILITY account per currency
  (`owner_kind='psp'`). Holding account for adjustment deltas.
- **`packages/clearing-files/src/index.ts` — `postClearingAdjustments`** —
  takes parsed records + a deterministic `fileHash`, groups by (scheme,
  currency), computes `Σ file_amount − Σ ledger_amount` per group, and
  posts a 2-leg adjustment journal for each non-zero delta:
  - `scheme_receivable[scheme, currency]  +delta`
  - `clearing_adjustments[currency]       -delta`
  - `externalId = 'clearing_adjust:${fileHash}:${scheme}:${currency}'`
  - Per-group txn, unique-violation swallowed → idempotent re-runs.
- **`packages/clearing-files/src/index.ts` — `clearingFileHash`** —
  convenience SHA-256 hex digest helper.
- **`apps/api/cli/clearing-ingest.ts`** — gains `--auto-adjust`. When
  set and the reconciler reports discrepancies, the CLI calls
  `postClearingAdjustments(db, parsed, clearingFileHash(contents))` and
  prints the deltas + journal entry ids. Without the flag, behavior is
  unchanged from Phase 20 (exit 1 on discrepancies).

## Demo path

```bash
# After phase 20 demo with a tampered file:
$ pnpm clearing:ingest --path tampered.csv --auto-adjust

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
  visa / USD : delta=+5500  → je_…
  status: 1 adjustment posted

# (exits 0 — adjustments wipe the discrepancy)

$ pnpm clearing:ingest --path tampered.csv --auto-adjust
# Same file, re-run: idempotent.
Posting adjustments (--auto-adjust)…
  no adjustments needed (already posted for this file)
```

## Tests

| Suite | Coverage |
|---|---|
| `packages/clearing-files/src/index.test.ts` (extended) | +6 cases: clean (no adjustment), positive delta on amount mismatch, missing-from-ledger contributes full file amount, mix across (scheme, currency) combos, empty input, clearingFileHash determinism. Pure unit tests with an in-memory db mock supporting the transaction + postJournal shape. |
| Existing 60-package suite | Green. |

Total `clearing-files` tests: 10 → 16. `pnpm typecheck` + `pnpm test`
both green across all 60 packages.

## Sign convention sanity check

- File says scheme owes us **more** than the ledger thinks (positive
  delta): `scheme_receivable` goes up by delta, `clearing_adjustments`
  goes more negative (LIABILITY balance up — PSP "owes" via the
  holding account). Once the scheme actually settles the larger
  amount, Phase 15's sweeper drains `scheme_receivable` to cash, and a
  manual sweep moves the `clearing_adjustments` balance to wherever it
  belongs (depending on the discrepancy's root cause).
- File says scheme owes us **less** (negative delta): mirror image.
  `scheme_receivable` goes down, `clearing_adjustments` more positive.

## Simplifications vs. real life

These are documented in `PHASE_21_PLAN.md §Out of scope`:

- **Selective adjustment.** All-or-nothing per (scheme, currency).
  A future phase could let the operator approve individual rows.
- **No auto-revert.** A bad adjustment is reversed by a manual journal.
- **No `clearing.adjustment_posted` webhook.** Useful for real ops.
- **No automatic sweep of `clearing_adjustments` to cash.** Operator's
  responsibility for now.
- **No cron promotion.** Still CLI-only — human-in-the-loop is the
  right default for adjustment posting.
- **`@psp-new/ledger`** added to `clearing-files` package deps for
  `postJournal` + `pspAccount` + `schemeAccount`. Small expansion of
  the package's surface area but justified by the new responsibility.

## What this enables next

Still open: cardholder identity surface (unlocks deferred webhooks);
auto-top-up rules; card-load chargeback/refund; per-card
`cardholder_stored_value` LIABILITY; promotion of auto-adjust to a
scheduled worker; real Base II / IPM parsing; sweeping
`clearing_adjustments` to cash automatically.
