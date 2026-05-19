# Phase 28 — Done

**Date:** 2026-05-19 · **Status:** Visa Base II binary format shipped. Plan: `PHASE_28_PLAN.md`. Mastercard IPM → Phase 29.

The `visa_base2` ClearingFormat now writes a real Base II-shaped
fixed-width 200-byte ASCII layout. `mc_ipm` keeps its placeholder CSV
for now. End-to-end pipeline (emit → parse → reconcile → adjust) works
without any caller changes.

## What shipped

### New file `packages/clearing-files/src/base2.ts`

Pure encoder/decoder, no DB, no IO:

- `buildVisaBase2(txs, opts?) → string` — emits header + N detail + trailer.
- `parseVisaBase2(contents) → { header, transactions }` — validates
  record lengths, TC/TCR codes, AND trailer totals (count + amount sum).
- `RECORD_LENGTH = 200`.
- ISO 4217 numeric ↔ alpha lookup for the supported currencies
  (USD/EUR/GBP/AED/INR).

### Layout

200-byte ASCII, space-padded, newline-separated.

**Header (TC=90 TCR=0):**
- 1-2: TC "90"
- 3:   TCR "0"
- 4-23:  file_id (20)
- 24-31: file_date YYYYMMDD (8)
- 32-41: scheme (10)

**Detail (TC=05 TCR=0):**
- 1-2:  TC "05"
- 3:    TCR "0"
- 4-33:  account_identifier / payment_intent_id (30)
- 34-63: merchant_id (30)
- 64-66: source_currency ISO 4217 numeric (3)
- 67-78: source_amount, zero-padded minor units (12)
- 79-90: rrn (12)
- 91-98: source_pcd YYYYMMDD (8)
- 99-108: scheme (10)

**Trailer (TC=90 TCR=1):**
- 1-2:  TC "90"
- 3:    TCR "1"
- 4-13:  record_count, zero-padded (10)
- 14-31: total_amount, zero-padded minor units (18)

Real Visa Base II is 168-byte EBCDIC with multiple TCRs per
transaction (TCR1-6 for POS, CVM, acquirer biz data, etc.) — we ship
200-byte ASCII with one TCR per tx. The semantic field set on TCR0
matches real Base II's conventions; the rest is honest approximation
documented inline.

### `index.ts` integration

- `emitClearingFiles` writes `.b2` extension for visa_base2 (was `.csv`);
  `mc_ipm` keeps `.csv`.
- `parseClearingFile(contents, 'visa_base2')` dispatches to
  `parseVisaBase2`. `mc_ipm` keeps the existing CSV parser, renamed
  internally to `parseMcIpmCsv` for clarity.
- Exports `buildVisaBase2`, `parseVisaBase2`, and
  `BASE2_RECORD_LENGTH` for callers that want to roundtrip directly.

### Time-of-day truncation

Real Base II carries date only (no time component). Round-tripping
`ClearingTransaction.occurredAt` therefore truncates to midnight UTC.
Documented in `base2.ts` header + asserted in the round-trip test.
The Phase 14/15/20/21 reconciliation pipeline reconciles on (scheme,
currency, rrn) and doesn't compare occurredAt, so nothing downstream
breaks.

### Tests

`packages/clearing-files/src/index.test.ts` extended:

- Existing emit test now asserts `.b2` extension + Base II header
  prefix (`900…`) + ISO 4217 numeric (`840` for USD).
- Round-trip test updated to compare against time-truncated
  `occurredAt`.
- New: trailer-total tamper test (flip a digit in the total_amount
  slot, parser throws).
- New: record-length truncation test.
- mc_ipm tests unchanged.

Result: 18/18 in clearing-files, 60/60 across all packages.

## What did NOT change

- `mc_ipm` format — still CSV, phase 29 territory.
- `paycore.clearing_files.format` enum — both values still valid.
- `paycore.clearing_records` shape — unchanged.
- Reconciliation pipeline (Phase 14/15/20/21).
- Phase 21 `postClearingAdjustments` — operates on parsed
  `ClearingTransaction[]`, format-agnostic.
- CLI `pnpm clearing:ingest` — reads file contents + format, passes
  through to parser unchanged.

## Verify

| Check | Result |
|---|---|
| `pnpm typecheck` | 60/60 green |
| `pnpm test` | 60/60 green (clearing-files: 18 tests) |
| Manual `clearing:ingest` against a `.b2` file | Not run this session |

## Out of scope

- **Mastercard IPM** — Phase 29. Significantly more code than Base II
  (ISO 8583 packed binary with primary + secondary bitmaps), worth
  its own phase.
- **TCR1-6 secondary records** for Base II (POS data, CVM, etc.). All
  our reconciliation needs fit in TCR0.
- **TC 25 (chargeback)** / **TC 33 (reversal)** Base II records.
  Phase 25 card-load refunds don't fan out to scheme files.
- **EBCDIC encoding** — we stay ASCII.
- **Multi-file batching** (Visa splits >250k rows). N/A at demo scale.

## What this enables next

- **Phase 29 — Mastercard IPM** is the natural follow-on now that the
  parser-dispatch shape is in place.
- Open list otherwise unchanged: Cardholder REST API (needs cardholder
  API-key scheme), auto-top-up (needs cardholder-scoped PMs), webhook
  deadletter replay UI.
