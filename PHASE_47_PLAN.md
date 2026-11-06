# Phase 47 — Plan: supplementary clearing files

**Date:** 2026-11-06 · **Status:** in progress.

## Goal

A transaction captured after its day's clearing file has been cut must
still reach a file. Close the gap Phase 46 documented: today one file per
(scheme, currency, day) is cut once, and anything arriving afterwards is
picked up by no later run and stays uncleared forever.

## The shape of the fix

What real acquirers do: several presentment files per (scheme, currency,
day), each with a sequence number, each carrying only what has not been
presented yet. A file, once submitted, stays immutable — Phase 46's rule
is kept. The second run of a day cuts file 002 rather than rewriting 001.

Four parts:

1. **Migration 0035.** `paycore.clearing_files` gains
   `sequence int not null default 1 check (sequence >= 1)`. The unique
   index `(scheme, currency, file_date, format)` is replaced by
   `(scheme, currency, file_date, format, sequence)`. Existing rows take
   sequence 1 from the default, so nothing already emitted moves.
2. **Collectors only return unpresented transactions.** Both
   `collectClearingTransactionsForDate` and
   `collectCardLoadChargebacksForDate` gain a `not exists` against
   `paycore.clearing_records`. This is the part that makes a re-run pick up
   stragglers instead of re-offering what is already in a file.
3. **`emitClearingFiles` assigns the next sequence** for the group —
   `max(sequence) + 1`, or 1 when there is none — in place of the Phase 46
   "skip the group" branch. The transaction and the per-group duplicate-key
   containment stay exactly as they are.
4. **`nightly:once --date YYYY-MM-DD`.** Without it a supplementary file
   can only ever be cut for today, because `asOf` is hardcoded to now+24h.
   An operator whose nightly did not run for two days has no way to sweep
   those days. Ten lines, and the feature is unusable to an operator
   without it.

### Why `not exists` on `payment_intent_id` is safe

`clearing_records.payment_intent_id` holds a `pi_` id for presentments and
a `cl_` id for card-load chargebacks — the two collectors read different
tables and the id spaces never overlap, so one row per id, and a plain
`not exists` cannot suppress a chargeback behind a presentment. Verified
by reading both collectors; there is no `kind` column to key on.

### Filenames

`visa_usd_20261106.b2` becomes `visa_usd_20261106_001.b2`, uniformly — no
special case for the first file of a day. Nothing parses the name
(`detectFormat` reads the extension), but the canary prints it and the
README quotes that line, so both get refreshed.

## Out of scope

- The once-per-file immutability rule itself. A cut file is never rewritten.
- Settlement, payouts, reconciliation: `reconcileClearingFile` matches on
  `(scheme, currency, rrn)` across all records, with no date or file
  scoping, so several files per day need nothing from it.
- `newId('outbox_event').replace('oe_', 'cf_')` — still the ad-hoc id
  pattern `CLAUDE.md` warns against. Pre-existing; untouched again.

## Files touched

| File | Change |
|---|---|
| `PHASE_47_PLAN.md` | this doc (commit 1) |
| `packages/db/migrations/0035_clearing_file_sequence.sql` | new (commit 2) |
| `packages/db/src/kysely.ts` | mirror `sequence` (commit 2) |
| `packages/clearing-files/src/index.ts` | next-sequence emission, `not exists` in both collectors, `sequence` on `EmittedClearingFile` (commit 2) |
| `packages/clearing-files/src/index.test.ts` | sequence cases (commit 2) |
| `packages/clearing-files/src/integration.test.ts` | the real straggler sweep (commit 2) |
| `apps/worker/src/clearing-job.ts` | log the sequences cut; drop `already_cut`, now always 0 (commit 2) |
| `apps/worker/cli/nightly-once.ts` | `--date` (commit 2) |
| `README.md` | Limitations entry + the canary snippet's filename (commit 2) |
| `PHASE_47_DONE.md` | write-up (commit 3) |

## Verify steps

Tests first, then the change.

| # | Step | Pass condition |
|---|---|---|
| 1 | Unit: a second emit for the same group cuts sequence 2, leaving 001 untouched | red before, green after |
| 2 | Unit: `EmittedClearingFile.sequence` and the `_NNN` filename | red before, green after |
| 3 | DB-gated: emit, add a straggler, emit again → 001 and 002 both on disk, each row matching its own trailer, the straggler in 002 only | red before, green after |
| 4 | DB-gated: a transaction already in a record is never offered twice | red before, green after |
| 5 | Migration applies, and applies twice (idempotent) | clean both times |
| 6 | `pnpm exec biome check` on changed files | clean |
| 7 | `pnpm typecheck` | 60/60 |
| 8 | `pnpm test` | 60/60 |
| 9 | **Live**: seed, nightly, add a late capture, nightly again | 002 cut holding only the late capture; no uncleared stragglers left |
| 10 | `make reset-db && make migrate && make e2e` | canary 11/11 on a fresh DB |

Step 9 is the one that matters: it is the exact scenario Phase 46 left
open, and the count of uncleared succeeded payments must go to zero.

## Known consequence to re-check

The canary's step 8 has a branch that reports "skipped — today's file
already emitted before this run (daily idempotency)". With sequences a
same-day re-run now cuts a new file containing its own payment, so that
branch should stop being reachable and the canary gets strictly stronger.
Worth confirming rather than assuming; the branch itself stays as a
harmless fallback.
