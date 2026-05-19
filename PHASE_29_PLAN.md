# Phase 29 — Real Mastercard IPM (ISO 8583-shaped format)

**Goal.** Replace the `mc_ipm` CSV placeholder with a real-shape
Mastercard IPM format: ISO 8583 MTI + bitmap + numbered data elements
with proper variable-length prefixes. Symmetric with Phase 28 Base II —
completes option 2 from the open list.

## Format

ASCII (rather than real EBCDIC packed binary) for inspectability,
otherwise faithful to ISO 8583 conventions:

**File header (record 1):**
```
HDR<file_id:20><file_date:YYYYMMDD>
```

**Message (one per transaction):**
```
<MTI:4><primary_bitmap:16 hex>[<de_data...>]
```

Each DE is encoded according to its ISO 8583 type:
- Fixed-length numeric: zero-padded ASCII
- LLVAR: 2-digit length prefix + data
- LLLVAR: 3-digit length prefix + data

**Trailer (last record):**
```
TRL<record_count:10><total_amount:18>
```

Records separated by `\n` for inspectability (real IPM is fixed
1644-byte blocks).

### DEs we use

For `MTI = 1240` (first presentment):

| DE | Name | Format | Maps to |
|---|---|---|---|
| 4 | Transaction amount | n12 | `amount` (zero-padded minor units) |
| 12 | Local transaction time | n12 | `occurredAt` (YYMMDDhhmmss UTC) |
| 31 | Acquirer reference data | an LLVAR up to 23 | `rrn` |
| 49 | Transaction currency code | n3 | ISO 4217 numeric |
| 100 | Receiving institution ID | n LLVAR up to 11 | scheme code (visa=400, mc=540) |
| 105 | Reserved private data | ans LLLVAR up to 999 | `merchantId\|paymentIntentId` |

Real DE 105 is reserved; we use it as a stand-in for "PDS additional
data" because our merchant + PI IDs don't fit in standard DEs. The
bitmap will have these bits set: 4, 12, 31, 49, 100, 105 → `1100100000000000100000000000010000000000000000010000010000000000` (BE bit positions per ISO 8583).

## API changes

```ts
// new
function buildMastercardIpm(txs, opts?): string
function parseMastercardIpm(contents): { header, transactions }

// changed
emitClearingFiles → mc_ipm path now calls buildMastercardIpm,
                    file extension changes .csv → .ipm
parseClearingFile(_, 'mc_ipm') → calls parseMastercardIpm
```

The placeholder `buildMcIpmCsv` and `parseMcIpmCsv` are removed.

## Tests

Symmetric with Phase 28:
- Round-trip preserves all fields (time-of-day kept — DE 12 carries it)
- Trailer total tampering → parser throws
- MTI mismatch → throws
- Bitmap-vs-presence mismatch → throws
- Existing reconciliation tests still pass (format-agnostic)

## Out of scope

- **Real EBCDIC packed binary** — we stay ASCII.
- **PDS sub-elements** within DE 48/123/158. We approximate by stuffing
  composite data into DE 105.
- **1442 chargeback / 1240 reversal MTIs** — only 1240 first
  presentment in this phase. Chargebacks (`paycore.disputes`) aren't
  wired to clearing files anyway today.
- **Secondary bitmap (DE 65-128 individual bits)** — we encode it as
  part of the single 16-hex primary bitmap; if DE > 64 is set, primary
  bit 1 flips on and we append a secondary bitmap. For our 6 DEs, only
  DEs 100 and 105 are in the secondary range, so we always emit the
  secondary bitmap and set primary bit 1.

## Files touched

- `packages/clearing-files/src/ipm.ts` (new)
- `packages/clearing-files/src/index.ts` (replace mc_ipm CSV path with ipm.ts;
  drop `buildMcIpmCsv` / `parseMcIpmCsv`)
- `packages/clearing-files/src/index.test.ts` (replace mc_ipm CSV
  assertions with IPM round-trip + tamper tests)
- `PHASE_29_DONE.md`

No migration, no new package deps, no schema delta.

## Verify

1. `pnpm typecheck` green across all 60 packages.
2. `pnpm test` green — including new IPM round-trip + tamper tests.
3. Manual demo not blocking; round-trip test covers correctness.
