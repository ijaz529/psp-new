# Phase 28 — Real Visa Base II (binary clearing format)

**Goal.** Replace the placeholder `buildVisaBase2Csv` / CSV-parse path
in `@psp-new/clearing-files` with a real, fixed-width Base II-shaped
binary format. Round-trip preserves all the existing
`ClearingTransaction` fields, the existing Phase 14/15/20/21
reconciliation pipeline plugs in unchanged.

**Non-goal (Phase 29).** Mastercard IPM. IPM is ISO 8583-style packed
binary with primary + secondary bitmaps — substantially more code than
Base II's fixed-width records, and worth its own phase. Phase 28 keeps
the `mc_ipm` format on its current CSV implementation.

## Why ship this at all

`@psp-new/clearing-files/src/index.ts:8-17` literally calls itself
"close-enough CSV per ADR-0017." A demo PSP that aspires to show
real-world settlement flows benefits from real-format files; the
current CSV teaches nothing about how Visa actually delivers data.

Real Base II is a 168-byte fixed-width ASCII record format, multiple
TCR (Transaction Component Record) rows per transaction, structured
header/detail/trailer. We'll ship a faithful approximation — the field
layout matches Base II conventions (positional ASCII, TC + TCR
numbering, header/trailer with totals) without claiming bit-for-bit
spec compliance.

## What ships

### Format

200-byte fixed-width ASCII records, padded with spaces. Newline-terminated.

**Record types:**

| TC | TCR | Role | Fields |
|---|---|---|---|
| 90 | 0 | File header | file_id, file_date (YYYYMMDD), scheme |
| 05 | 0 | First presentment detail | account_number, source_currency (ISO 4217 numeric), source_amount (12 digits, minor units), merchant_id, rrn, source_pcd (YYDDD julian) |
| 90 | 1 | File trailer | record_count, total_amount |

Field positions documented inline as a constant table. Layouts cite
"Visa Base II Technical Specifications field semantics, simplified for
demo" — honest about the approximation.

### API changes

```ts
// before
function buildVisaBase2Csv(txs: ClearingTransaction[]): string

// after
function buildVisaBase2(txs: ClearingTransaction[], opts?: {
  fileId?: string;        // optional, defaults to ULID
  fileDate?: Date;        // optional, defaults to txs[0].occurredAt
}): string                 // 200-char rows, \n-separated; still UTF-8 safe (pure ASCII)
```

`parseClearingFile(contents, 'visa_base2')` rewritten as fixed-width
positional parsing. Validates record lengths + TC/TCR codes + trailer
totals match the detail rows. Throws on mismatch.

### Caller updates

- `emitClearingFiles` (same file): visa_base2 path calls
  `buildVisaBase2`, file extension changes `.csv` → `.b2`.
- `mc_ipm` path unchanged (still CSV, Phase 29 territory).

### Tests

Net-new `packages/clearing-files/src/index.test.ts` (or extend if
present) with:

1. Round-trip: build N transactions → parse → assert deep equal.
2. Trailer totals invariant: tamper with one byte of an amount in the
   detail record, expect `parseClearingFile` to throw (trailer
   detection works).
3. Record-length invariant: a truncated row throws with a clear error.
4. Existing reconciliation tests still pass (they consume
   `ClearingTransaction[]`, format-agnostic).

These can be pure unit tests — no DB needed for builder/parser, so no
HAS_DB gate.

## Out of scope

- TCR1-TCR6 secondary records (POS data, acquirer business data,
  cardholder verification method, etc.). All our reconciliation
  needs fit in TCR0; secondary records are placeholders in real life
  too for many merchant types.
- Multi-file batching (Visa splits >250k rows). N/A at demo scale.
- TC 25 (chargeback presentment), TC 33 (reversal). Phase 25 refund
  doesn't fan out to Base II.
- Mastercard IPM. Phase 29.
- Real Base II EBCDIC encoding (we stay ASCII — it's a demo).

## Verify

1. `pnpm typecheck` green across all 60 packages.
2. `pnpm test` green — including new round-trip + tamper tests.
3. Manual `pnpm clearing:ingest` against a freshly generated `.b2` file
   produces the same reconciliation report as the same data in old CSV
   form (not blocking commit; the round-trip test covers the format
   correctness).

## Files touched

- `packages/clearing-files/src/index.ts` (Base II builder + parser
  swap; mc_ipm path unchanged)
- `packages/clearing-files/src/index.test.ts` (extended or new)
- `packages/clearing-files/src/base2.ts` (new — the format encoder /
  decoder, kept separate from orchestration for testability)
- `apps/api/cli/clearing-ingest.ts` (verify it still works against the
  new format — likely no change, just reads the file path and passes
  contents through)
- `PHASE_28_DONE.md`

No migration, no new package deps, no schema delta.
