# Phase 20 — Settlement file ingestion (Plan)

**Status:** Proposed for review · **Predecessor:** Phase 19 (`PHASE_19_DONE.md`).

Phase 6 ships the emit side — nightly CSVs in close-enough Visa Base II /
Mastercard IPM format. Phase 20 ships the ingest side: parse a clearing
file (typically from a scheme) and reconcile its records against what the
PSP expected. Closes the documented MVP simplification in
`PHASE_15_PLAN.md`: *"No clearing-file ingestion. Phase 6 emits files; we
don't parse incoming ones."*

---

## Scope

A parser + reconciler for the Phase 6 CSV format. No journal posting —
Phase 15's scheme-settlement worker already drains `scheme_receivable`
from the ledger balance, trusting that the balance matches what schemes
settle. Phase 20 **validates** that trust: every record in an ingested
file must match a row in `paycore.clearing_records` (the source of truth
written at emit time).

Three pieces:

1. **`parseClearingFile`** — pure function. Takes file path + format
   (`visa_base2 | mc_ipm`), returns `ClearingTransaction[]`. Mirror of
   `buildVisaBase2Csv` / `buildMcIpmCsv`.
2. **`reconcileClearingFile`** — diffs parsed records against the
   matching `paycore.clearing_records` rows (joined on RRN). Returns a
   `ReconciliationReport` with counts of matched / missing / mismatched
   records and any amount discrepancies.
3. **`pnpm clearing:ingest`** CLI — wires both together. Args:
   `--path <file>` (required), `--format` (optional, auto-detected from
   filename). Prints a report. Exit 0 = clean, exit 1 = discrepancies.

For demo realism, the file we ingest can be a Phase-6-emitted file
round-trip (proves parser-emitter symmetry) or a hand-edited file with
injected discrepancies (proves the reconciler detects drift).

No DB schema changes. No new accounts. The existing
`paycore.clearing_files` and `paycore.clearing_records` tables provide
the expected-records source.

---

## Pieces

| Piece | What | Where |
|---|---|---|
| **`parseClearingFile`** | New exported function. Parses both formats. Reverses the field layout from `buildVisaBase2Csv` / `buildMcIpmCsv`. | `packages/clearing-files/src/index.ts` |
| **`reconcileClearingFile`** | New exported function. Joins parsed records vs `paycore.clearing_records` by `(scheme, currency, rrn)`. Returns a structured report. | same |
| **`pnpm clearing:ingest`** | CLI script | `apps/api/cli/clearing-ingest.ts` |
| **CLI script registration** | Add to `apps/api/package.json` scripts | same |
| **Unit tests** | Round-trip: emit + parse must produce identical records | `packages/clearing-files/src/index.test.ts` (extend) |
| **HAS_DB-gated integration** | Seed clearing_records, parse a corresponding file, reconcile, assert clean / discrepancies detected | new test |

---

## Function shapes

```ts
export function parseClearingFile(
  contents: string,
  format: ClearingFormat,
): ClearingTransaction[];

export interface ReconciliationReport {
  readonly fileFormat: ClearingFormat;
  readonly totalParsed: number;
  readonly matched: number;
  readonly missingFromLedger: ReadonlyArray<string>; // rrns in file but not in clearing_records
  readonly amountMismatches: ReadonlyArray<{
    readonly rrn: string;
    readonly fileAmount: bigint;
    readonly ledgerAmount: bigint;
  }>;
  readonly clean: boolean; // true iff missingFromLedger.length === 0 && amountMismatches.length === 0
}

export async function reconcileClearingFile(
  db: Kysely<Database>,
  parsed: ReadonlyArray<ClearingTransaction>,
): Promise<ReconciliationReport>;
```

---

## Why no ledger writes

Phase 15 drains `scheme_receivable[scheme, currency]` based on the
ledger balance. The implicit assumption: ledger balance == amount the
scheme is settling. Phase 20 makes that assumption falsifiable. If a
parsed file's totals diverge from `paycore.clearing_records`, the
reconciler surfaces it. The operator decides what to do (manual
adjustment, investigation, etc.) — automating that is a future phase.

This is the right scoping for the MVP: ingestion gives **visibility**,
not **policy**. Policy comes when real schemes can disagree with our
records (chargebacks-in-flight, post-cutoff captures, etc.).

---

## CLI shape

```
$ pnpm clearing:ingest --path data-exports/clearing/visa_usd_20260519.csv

Parsing visa_usd_20260519.csv (visa_base2)…
  → 12 records parsed
Reconciling against paycore.clearing_records…
  matched          : 12
  missing-from-ledger: 0
  amount-mismatches  : 0
  status: clean ✓
```

With a discrepancy:
```
$ pnpm clearing:ingest --path tampered.csv

Parsing tampered.csv (visa_base2)…
  → 12 records parsed
Reconciling against paycore.clearing_records…
  matched          : 11
  missing-from-ledger: 1
    - 601201000007  (file says $50.00, no matching ledger record)
  amount-mismatches  : 1
    - 601201000003  file=$30.00 ledger=$25.00
  status: discrepancies found ✗

(exits 1)
```

---

## Out of scope (deferred)

- **EBCDIC fixed-width Visa Base II**. Real Base II files are EBCDIC
  fixed-width with hundreds of PDS record types. We parse the CSV
  subset we emit. Future phase if integrating a real scheme requires.
- **Mastercard IPM real format**. Same — TLV/binary in real life.
- **Auto-posting from ingest**. The reconciler reports; the operator
  decides. A future phase could post adjustment journals on detected
  discrepancies.
- **Webhook on reconciliation failure**. `clearing.reconciliation_failed`
  event would be useful for real ops; not Phase 20's problem.
- **Tracking ingested files in DB.** No new column on
  `paycore.clearing_files` — the CLI is fire-and-forget. A future phase
  can add `ingested_at` if needed.

---

## Verifiable success criteria

1. `pnpm typecheck` + `pnpm test` green across all 60 packages.
2. New unit test: round-trip. Build a `ClearingTransaction[]`, emit
   via `buildVisaBase2Csv` (now extracted as a pure helper or reachable
   via test), parse via `parseClearingFile`, assert equality.
3. Same for `mc_ipm`.
4. HAS_DB-gated test: seed `paycore.clearing_files` +
   `paycore.clearing_records` by running `emitClearingFiles`, read the
   file back via `parseClearingFile`, run `reconcileClearingFile`,
   assert `clean: true`.
5. HAS_DB-gated test: tamper one record (mutate amount, drop a row),
   assert the reconciler flags the discrepancy.
6. End-to-end (manual): `pnpm clearing:ingest --path <emitted file>`
   returns exit 0 and prints "clean ✓".
