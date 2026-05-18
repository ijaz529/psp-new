# Phase 1 — Done

**Date:** 2026-05-18 · **Status:** Ledger landed; Phase 2 plan attached as
`PHASE_2_PLAN.md`.

The interesting code starts here. Phase 0 was scaffolding; Phase 1 is the heart
of the system — a working double-entry, append-only, multi-currency ledger.

---

## What was built

### Schema (`packages/db/migrations/0007-0009`)
- **0007_ledger_constraints.sql** — DB-level invariants. App code cannot bypass.
  - Deferred constraint trigger `journal_lines_balanced_entry` — `SUM(amount) = 0`
    per currency per entry, checked at commit.
  - Single-currency-per-entry check (no mixed-currency entries).
  - `journal_lines_currency_match` — line currency must match account currency.
  - Append-only triggers on `journal_lines` and `journal_entries` — UPDATE and
    DELETE both raise.
  - `journal_lines_amount_nonzero` CHECK constraint.
- **0008_ledger_account_balances.sql** — materialized view `ledger.account_balances`
  with `(account_id, currency, debit_total, credit_total, balance, last_journal_at)`.
  Unique index makes it `REFRESH MATERIALIZED VIEW CONCURRENTLY`-ready.
- **0009_chart_of_accounts.sql** — seeded 80 accounts:
  - 7 PSP-owned codes × 5 currencies (USD/EUR/GBP/AED/INR) = 35
  - 3 scheme-scoped codes × 3 schemes (visa/mastercard/amex) × 5 currencies = 45
  - Per-merchant accounts (4 codes) deliberately NOT seeded; created lazily by
    `ensureMerchantAccounts()` (see ADR-0010).

### Library (`packages/ledger`)
| Function | Purpose |
|---|---|
| `postJournal(trx, input)` | The only writer to `ledger.journal_entries` and `ledger.journal_lines`. Validates balance + single-currency + non-zero before DB roundtrip. |
| `validatePostInput(input)` | Pure-function validation surface, exported for unit testing without a DB. |
| `balance(db, accountId, opts?)` | Reads from the materialized view (`view`, fast/stale) or falls back to live `SUM(amount)` (`live`, slow/exact). |
| `reconcile(internal, external)` | Pure two-bag set-difference reconciliation primitive. Match key: `(accountId, amount, currency)`. Multiplicity-aware. |
| `ensureMerchantAccounts(trx, merchantId, currency)` | Idempotent upsert of the 4 per-merchant accounts for a (merchant, currency) pair. |
| `pspAccount`, `schemeAccount`, `merchantAccount` | Deterministic account-ID derivation matching `ledger._acct_id` in SQL. |
| `getAccount(db, id)` | Read a single account row, typed. |

Sign convention everywhere: **debit > 0, credit < 0** (single signed `amount`
column). See ADR-0009.

### Tests
| File | Type | What it covers |
|---|---|---|
| `src/post.test.ts` | unit | Validation (single posting, unbalanced, mixed-currency, zero-amount, large BigInt) |
| `src/reconcile.test.ts` | unit | 8 set-difference cases incl. multiplicity, sign, and currency discrimination |
| `src/accounts.test.ts` | unit | Deterministic ID derivation (stable, mirrors SQL) |
| `src/integration.test.ts` | **integration (DB-gated)** | DB triggers reject unbalanced + currency-mismatched + zero-amount + UPDATE + DELETE. Property test with fast-check posts 30 random balanced entries × 5 fc.runs and asserts global sum = 0 per currency. Demo posts capture+refund and prints the Ledger Tape. |

Integration tests skip when `DATABASE_URL` is unset. CI's Postgres service runs
them; locally `make up` then `pnpm test` is enough.

### CLI
- `pnpm ledger:balance <account_id>` — prints both live and view-cached balance.
- `pnpm --filter @psp-new/ledger balance <account_id>` — same thing direct.

### Docs
- ADR-0009 (debit-positive signed column) — DECISIONS.md.
- ADR-0010 (per-merchant accounts lazy) — DECISIONS.md.

---

## Demo

After Phase 0 is up (`make up`) and Phase 1 migrations are applied (`make migrate`):

```bash
pnpm test    # runs unit tests + integration tests; integration tests print the Ledger Tape
```

The demo test (`src/integration.test.ts > 'demo — capture + refund …'`) outputs:

```
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃                       LEDGER TAPE  (phase-1 demo)              ┃
┣━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┫
┃ merchant:                 mrch_demo_…                          ┃
┃ capture entry:            je_…                                 ┃
┃   Dr scheme_receivable (visa, USD)               10.00 USD     ┃
┃   Cr merchant_settlement_liability               -9.70 USD     ┃
┃   Cr mdr_revenue (psp, USD)                      -0.30 USD     ┃
┃                                                                ┃
┃ refund entry:             je_…                                 ┃
┃   Cr scheme_receivable (visa, USD)               -2.00 USD     ┃
┃   Dr merchant_settlement_liability                1.94 USD     ┃
┃   Dr mdr_revenue (psp, USD)                       0.06 USD     ┃
┃                                                                ┃
┃ net settlement liability:                        -7.76 USD     ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
```

(Amounts shown are USD minor units / 100 — the test uses 1000n / 970n etc.
which render as 10.00 / 9.70 USD respectively.)

---

## What's deliberately deferred

- **Periodic materialized-view refresh job** — view exists, has the unique
  index for `REFRESH MATERIALIZED VIEW CONCURRENTLY`, but no scheduler. Phase 6
  worker registers a cron job.
- **Per-merchant account balance reports / accountant exports** — the columns
  (`debit_total`, `credit_total` in the view) are ready; the export pipeline
  is Phase 6.
- **Hash chain across journal entries** for tamper-evidence — out of scope.
  PROJECT_BRIEF.md §3 doesn't require it; ADR proposal could land in Phase 7+
  if the threat model evolves.
- **FX entries** for multi-currency settlement — same-currency MVP per Q29.
  `fx_pnl` account exists per currency; the FX-aware posting helper lands in
  Phase 6.
- **Ledger snapshots** for restore / point-in-time queries — Postgres PITR is
  the deployment-level solution; in-app snapshots not needed.

---

## Discovered during the build

1. **Deferred constraint triggers were the right tool.** Postgres lets us defer
   a CONSTRAINT TRIGGER to commit time, which lets us insert journal lines
   one-by-one inside a transaction and have the balance check fire only once.
   Without DEFERRABLE INITIALLY DEFERRED, multi-line inserts would have to be
   batched into a single statement.

2. **`exactOptionalPropertyTypes` keeps surfacing.** When building optional
   request inputs (`PostJournalInput`, future `RefundInput`), every optional
   field needs the `if (value !== undefined) obj.field = value` dance. Once you
   feel the pattern it's mechanical, but worth noting in DECISIONS for the
   future maintainer.

3. **Deterministic account IDs via md5 of canonical key works well.** The
   `ledger._acct_id` SQL function and the TS `deterministicAccountId` produce
   the same hash for the same input — so seed migrations and app code agree on
   IDs by construction. The CoA seed never had to "look up" what it just
   inserted.

4. **Materialized views need a unique index for CONCURRENT refresh.** Easy to
   forget; the view + index ship together in 0008.

5. **fast-check's `asyncProperty` plays well with vitest** but the property
   test does ~30 transactions per run × 5 runs = 150 DB roundtrips. Acceptable
   in CI; in dev with compose-up it runs in ~6s. If we ever want it faster, we
   can batch postings into one transaction per run.

6. **Kysely returns `bigint` for `int8` columns** thanks to `configurePgTypes()`
   set once in `@psp-new/db/runtime.ts`. The integration test that reads back
   `amount` doesn't need any casting.

---

## Phase 1 deliverables checklist (from PHASE_1_PLAN.md)

| # | Goal | Status |
|---|---|---|
| A.1 | Constraint trigger enforcing `SUM(amount) = 0` per currency per entry | ✅ |
| A.1 | Single-currency-per-entry rule at DB level | ✅ |
| A.1 | Append-only enforcement on `journal_lines` and `journal_entries` | ✅ |
| A.1 | Currency consistency: line.currency = account.currency | ✅ |
| A.2 | Materialized view `ledger.account_balances` + concurrent-refresh index | ✅ |
| B | `postJournal`, `balance`, `reconcile`, `ensureMerchantAccounts` library | ✅ |
| C | Unit + integration tests + property-based fast-check test | ✅ |
| D | Reference Chart of Accounts seeded (80 rows) | ✅ |
| E | `pnpm ledger:balance <account_id>` CLI | ✅ |
| F | Capture + refund demo posting a balanced 6-line scenario | ✅ |

---

Phase 2 plan: `PHASE_2_PLAN.md`. Vaultless HMAC tokenization, vault service
wired up to the existing `apps/vault` scaffold.
