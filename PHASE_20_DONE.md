# Phase 20 — Done

**Date:** 2026-05-19 · **Status:** Settlement file ingestion landed. Plan: `PHASE_20_PLAN.md`.

The Phase 6 clearing-file emit/Phase 15 trust-the-ledger pair is now
falsifiable. Operators can parse a clearing file and reconcile it
against `paycore.clearing_records` to detect drift before it costs
money. Closes the documented MVP simplification *"No clearing-file
ingestion"* in `PHASE_15_PLAN.md`.

## What shipped

- **`packages/clearing-files/src/index.ts` — `parseClearingFile`** —
  pure function. Takes the CSV contents + format (`visa_base2` |
  `mc_ipm`), returns `ClearingTransaction[]`. Validates the header
  against the expected schema for each format and rejects unknown
  schemes. Round-trip with `buildVisaBase2Csv` / `buildMcIpmCsv` is
  symmetric.
- **`packages/clearing-files/src/index.ts` —
  `reconcileClearingFile`** — async function. One bulk SELECT against
  `paycore.clearing_records` matching the parsed RRNs, then a Map join
  by `(scheme, currency, rrn)`. Returns a structured `ReconciliationReport`
  with `matched`, `missingFromLedger`, `amountMismatches`, and a `clean`
  boolean.
- **`apps/api/cli/clearing-ingest.ts`** (NEW) — `pnpm clearing:ingest
  --path <file> [--format visa_base2|mc_ipm]`. Auto-detects format from
  filename if not supplied (visa default, mc when filename contains
  `mastercard` or `mc_`). Prints a report; exits 0 on clean
  reconciliation, exit 1 on any discrepancy. Registered in
  `apps/api/package.json` scripts; `@psp-new/clearing-files` added as a
  workspace dep.
- **Unit tests (extended `packages/clearing-files/src/index.test.ts`)** —
  9 new test cases:
  - Visa Base II round-trip (emit + parse must produce identical
    records).
  - MC IPM round-trip.
  - Header-mismatch rejection.
  - Unknown-scheme rejection.
  - Empty file → empty array.
  - Reconciler: clean / amount mismatch / missing from ledger / empty
    input. All four use a small in-memory db mock.

Total: 1 prior test → 10 passing.

Zero new ledger accounts. Zero schema changes. No new error codes —
the CLI throws `Error` on malformed files (caught and printed).

## Demo path

```bash
make up && make migrate

# Drive a few merchant captures (creates clearing data via the worker's
# nightly job emit, or run pnpm worker dev with NIGHTLY_INTERVAL_MS=10000).
# After the nightly emit runs, data-exports/clearing/ has CSVs.

ls data-exports/clearing/
#   visa_usd_20260519.csv  mastercard_usd_20260519.csv  visa_eur_20260519.csv

pnpm clearing:ingest --path data-exports/clearing/visa_usd_20260519.csv
# Parsing visa_usd_20260519.csv (visa_base2)…
#   → 12 records parsed
# Reconciling against paycore.clearing_records…
#   matched           : 12
#   missing-from-ledger: 0
#   amount-mismatches  : 0
#   status: clean ✓

# Tamper a record and re-run:
sed -i.bak 's/30000/29999/' data-exports/clearing/visa_usd_20260519.csv
pnpm clearing:ingest --path data-exports/clearing/visa_usd_20260519.csv
# → "status: discrepancies found ✗" (exit code 1)
```

## Tests

| Suite | Coverage |
|---|---|
| `packages/clearing-files/src/index.test.ts` (extended) | +9 cases: round-trips, header/scheme validation, empty input, reconciler clean/mismatch/missing/empty. |
| Existing 60-package suite | Green. |

`pnpm typecheck` + `pnpm test` both green across all 60 packages.

## Why no ledger writes

Phase 15's `settleSchemeReceivables` drains `scheme_receivable` from
the ledger balance, **trusting** it matches what schemes will settle.
Phase 20 makes that assumption falsifiable. Discrepancies are surfaced
to the operator; auto-posting adjustment journals on detected drift is
a future phase. This scoping matches Phase 6's spirit: visibility first,
policy later.

## Simplifications vs. real life

These are documented in `PHASE_20_PLAN.md §Out of scope`:

- **No EBCDIC fixed-width Visa Base II parsing.** Real Base II files
  are EBCDIC fixed-width with hundreds of PDS record types. We parse
  the CSV subset Phase 6 emits.
- **No real Mastercard IPM TLV/binary parsing.** Same — TLV/binary in
  real life.
- **No auto-posting from ingest.** The reconciler reports; the
  operator decides.
- **No `clearing.reconciliation_failed` webhook.** Useful for real ops;
  not Phase 20's problem.
- **No `ingested_at` column on `paycore.clearing_files`.** CLI is
  fire-and-forget. Add when there's a need to query which files have
  been verified.

## What this enables next

Still open: cardholder identity surface, auto-top-up rules, card-load
chargeback flow, per-card `cardholder_stored_value` LIABILITY, auto-posting
of reconciliation discrepancies, real Base II / IPM parsing for actual
scheme integration.
