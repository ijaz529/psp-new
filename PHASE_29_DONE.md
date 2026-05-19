# Phase 29 — Done

**Date:** 2026-05-19 · **Status:** Mastercard IPM ISO 8583-shaped format shipped. Plan: `PHASE_29_PLAN.md`. Completes option 2 (real Visa Base II + real Mastercard IPM) — Phase 28 shipped Base II.

The `mc_ipm` ClearingFormat now writes ISO 8583-shaped messages
(MTI + bitmap + numbered DEs with proper variable-length prefixes).
End-to-end reconciliation pipeline unchanged. Symmetric with Phase 28.

## What shipped

### New file `packages/clearing-files/src/ipm.ts`

Pure encoder/decoder. ~280 lines, no DB, no IO:

- `buildMastercardIpm(txs, opts?) → string` — emits HDR + N messages + TRL.
- `parseMastercardIpm(contents) → { header, transactions }` — validates
  MTI, bitmap-vs-registry sanity, trailer count + total.

### Format

ASCII (real IPM is packed EBCDIC binary; we keep ASCII for
inspectability — same trade-off Phase 28 made).

```
HDR<file_id:20><file_date:YYYYMMDD>\n
<MTI:4><primary_bitmap:16 hex><secondary_bitmap:16 hex><DE 4><DE 12><DE 31><DE 49><DE 100><DE 105>\n
...
TRL<record_count:10><total_amount:18>\n
```

MTI 1240 (first presentment / financial transaction). DEs:

| DE | Name | Format | Maps to |
|---|---|---|---|
| 4  | transaction_amount | n12 | amount (zero-padded minor units) |
| 12 | local_transaction_datetime | n12 | occurredAt (YYMMDDhhmmss UTC) |
| 31 | acquirer_reference_data | LLVAR-an up to 23 | rrn |
| 49 | transaction_currency_code | n3 | ISO 4217 numeric |
| 100 | receiving_institution_id | LLVAR-an up to 11 | scheme code (540/400/999) |
| 105 | reserved_private | LLLVAR-ans up to 999 | `merchantId\|paymentIntentId` |

DE 105 is the "reserved private" slot — we use it as a composite carrier
for IDs that don't fit any standard DE. Honest documented approximation
in the source.

### Bitmap encoding

- Primary bitmap: 16 hex chars = 8 bytes = 64 bits, big-endian
  bit ordering (bit 1 = MSB of byte 1).
- Bit 1 of the primary signals "secondary bitmap present" — flipped
  automatically when any DE > 64 is in use. Our DE set includes 100
  and 105, so secondary is always present.
- Secondary bitmap: another 16 hex chars covering DEs 65-128.
- Parser cross-checks the bitmap-declared DE set against the registry —
  any mismatch throws.

### Trailer integrity

`record_count` and `total_amount` are both cross-checked against the
detail rows. The tamper test (flip one digit of total_amount) confirms
the parser rejects diverged files.

### Caller updates

- `emitClearingFiles`: `mc_ipm` path calls `buildMastercardIpm`, file
  extension changes `.csv` → `.ipm`.
- `parseClearingFile(_, 'mc_ipm')` dispatches to `parseMastercardIpm`.
- Removed `buildMcIpmCsv` and `parseMcIpmCsv` (placeholders, no longer
  referenced).

### Tests

`packages/clearing-files/src/index.test.ts`:
- Existing emit test asserts `.ipm` extension + HDR prefix + MTI 1240 + DE 100 scheme code 540.
- `mc_ipm round-trip preserves all fields (including time-of-day via DE 12)`.
- `rejects an mc_ipm file with mismatched MTI`.
- `rejects an mc_ipm file whose trailer total does not match detail sum`.
- All Phase 28 Base II tests intact.
- All reconciliation tests intact (format-agnostic).

17/17 in clearing-files, 60/60 across all packages.

## Why time-of-day survives (unlike Base II)

Real Base II only carries date (Source PCD field). Phase 28 round-trip
truncates time. Real IPM carries DE 12 "local transaction
date/time" with YYMMDDhhmmss precision — Phase 29 preserves it.

## Out of scope

- **EBCDIC binary encoding** — we stay ASCII.
- **Real 1644-byte block format** — we use newline-separated records.
- **Other MTIs** — 1442 chargeback, 1240 reversal. The encoder is
  data-driven (DE_SPECS table), so adding more MTIs is a small lift
  for whoever needs them.
- **Secondary-bitmap-only messages** (where primary bit 1 is set but
  no primary bits 2-64). Not relevant to our fixed DE set.
- **PDS sub-elements** inside DE 48 / DE 123 / DE 158. We approximate by
  stuffing composite data into DE 105.

## Verify

| Check | Result |
|---|---|
| `pnpm typecheck` | 60/60 green |
| `pnpm test` | 60/60 green |
| Manual `clearing:ingest` against a `.ipm` file | Not run this session |

## What this enables next

With both Base II and IPM real-shaped, the clearing-files surface is
substantially more educational about real card scheme settlement. The
open list is otherwise unchanged:

- **Cardholder REST API** (`/v1/cardholder/*`) — needs a cardholder
  API-key scheme that doesn't exist yet. Bootstrap question: portal-issued
  vs admin-CLI-issued.
- **Auto-top-up rules** — needs cardholder-scoped payment methods.
- **Webhook deadletter replay UI for cardholders** — symmetric to
  merchant side, smaller scope.
- **Per-card webhook endpoint scoping** — current model is per-cardholder.
- **TC 25 chargeback** Base II records / **MTI 1442** IPM messages —
  Phase 25 card-load refunds could fan out to scheme files; currently
  they don't.
