# Phase 1 — The Ledger (Plan)

**Status:** Proposed for review · **Predecessor:** Phase 0 (see `PHASE_0_DONE.md`).

> Build this BEFORE the gateway. Everything else depends on it.
> — PROJECT_BRIEF.md §3 Phase 1

This plan turns the brief's Phase 1 bullets into a buildable sequence. Sign off
on it (or push back on specifics) and I'll execute.

---

## Goal

A working, append-only, double-entry, multi-currency ledger that:

1. **Refuses unbalanced entries** at the DB level (constraint trigger, not app code).
2. **Refuses any UPDATE or DELETE** on `journal_lines` and `journal_entries`.
3. **Refuses mixed currencies inside an entry** at the DB level.
4. **Computes balances by SUM()** today; ships a materialized-view path designed in.
5. **Surfaces reconciliation** as a primitive: given two sets of entries, find unmatched lines.
6. **Seeds a reference Chart of Accounts** appropriate for a PSP.
7. **Has property-based tests** asserting "for any random sequence of valid
   postings, total balance across all accounts in a currency sums to 0."

When Phase 1 is done, the gateway in Phase 3 can write `pi.succeeded` and have
a real-money journal entry behind it.

---

## Proposed Chart of Accounts

The brief listed a few example accounts. Here's the full proposal — review for
omissions before I code it in.

| Code | Type | Owner | Purpose |
|---|---|---|---|
| `merchant_settlement_liability` | LIABILITY | merchant | What the PSP owes the merchant at any moment; one row per (merchant, currency) |
| `scheme_receivable` | ASSET | scheme | What the scheme owes the PSP between clearing and settlement; one per (scheme, currency) |
| `acquirer_clearing_account` | ASSET | psp | Transient: captures sit here between authorization and clearing |
| `interchange_expense` | EXPENSE | scheme | Per-transaction interchange fee paid to issuer; one per (scheme, currency) |
| `scheme_fee_expense` | EXPENSE | scheme | Per-transaction scheme fee paid to network; one per (scheme, currency) |
| `mdr_revenue` | REVENUE | psp | Merchant Discount Rate income; one per currency |
| `refund_reserve` | LIABILITY | merchant | Rolling reserve held per merchant; one per (merchant, currency) |
| `chargeback_liability` | LIABILITY | merchant | Disputed-but-not-yet-final chargebacks; one per (merchant, currency) |
| `fx_pnl` | REVENUE | psp | FX gains/losses (Phase 6+); one per currency-pair until FX is implemented, then one per base currency |
| `psp_cash_at_bank` | ASSET | psp | Real-world cash position; one per (bank account, currency) |
| `merchant_payout_clearing` | ASSET | psp | Outbound payouts in flight; one per (merchant, currency) |
| `disputes_in_progress` | ASSET | psp | Counter-asset to `chargeback_liability` during representment |
| `refund_clearing` | LIABILITY | psp | Refunds initiated but not yet settled to issuer |
| `unallocated_settlements` | LIABILITY | psp | Bin for scheme settlement amounts we haven't matched to internal records yet |

A canonical successful capture flow posts the following journal entry:

| Line | Account | Debit | Credit |
|---|---|---|---|
| 1 | `scheme_receivable` | 1000 | — |
| 2 | `merchant_settlement_liability` | — | 970 |
| 3 | `mdr_revenue` | — | 30 |
| 4 | `interchange_expense` | 20 | — |
| 5 | `scheme_fee_expense` | 5 | — |
| 6 | `mdr_revenue` (offset for fee accounts) | — | 25 |

Sum per currency = 0 ✓. (Lines 4+5+6 net to zero on the expense side; this is the
"PSP earns MDR gross, then expenses interchange and scheme fee out of it"
pattern.)

**Open Phase 1 questions for the founder:**

1. Should `merchant_settlement_liability` be **one account per merchant per
   currency**, or **one account per merchant with currency on each line**? The
   brief says "Per-currency sub-ledgers — never mix currencies in one entry."
   That implies one account per (merchant, currency). My recommendation: yes,
   one per (merchant, currency).
2. Should `interchange_expense` and `scheme_fee_expense` be **per (scheme, currency)** or
   **per merchant**? Industry standard is per scheme. My recommendation: per scheme.
3. Sign convention: **debit positive, credit negative**, or **debit/credit columns**
   on each line? My recommendation: **signed `amount` column**, with a convention
   table in `DECISIONS.md` (debit = positive). Less SQL, easier to assert sum = 0.

---

## Phase 1 deliverables (in build order)

### A. Schema upgrade
- Migration `0007_ledger_constraints.sql`
  - Constraint trigger `enforce_balanced_entry` on `ledger.journal_lines`:
    `SUM(amount) GROUP BY currency` per `entry_id` must be 0.
  - Rule/trigger blocking UPDATE + DELETE on `ledger.journal_lines` and
    `ledger.journal_entries`.
  - Add `currency` consistency check: every `journal_line.currency` must match
    the `journal_line.account.currency`.
- Migration `0008_ledger_account_balances.sql`
  - Materialized view `ledger.account_balances` with columns
    `(account_id, currency, debit_total, credit_total, balance, last_journal_at)`.
  - `REFRESH MATERIALIZED VIEW CONCURRENTLY` job stub (drives the Phase 6 worker).

### B. Library (`packages/ledger`)
A new package. **Has the only writes to the ledger tables in the system.**

```ts
// packages/ledger/src/index.ts
export interface Posting {
  accountId: string;        // acct_<ulid>
  amount: bigint;           // signed minor units (debit > 0, credit < 0)
  currency: string;         // ISO 4217 — must match account.currency
}

export interface PostJournalInput {
  externalId: string;       // idempotency anchor; unique-indexed
  description: string;
  occurredAt: Date;
  postings: readonly Posting[];
}

export async function postJournal(
  trx: KyselyTrx,
  input: PostJournalInput,
): Promise<JournalEntryRecord> { ... }

export async function balance(
  db: Kysely,
  accountId: string,
): Promise<Money> { ... }

export async function reconcile(
  internal: readonly Posting[],
  external: readonly Posting[],
): Promise<{ unmatchedInternal: Posting[]; unmatchedExternal: Posting[] }> { ... }
```

### C. Tests
- Unit: `postJournal` rejects unbalanced postings, rejects currency-mismatch,
  rejects nonexistent accounts.
- **Property-based** (using `fast-check`): for any random sequence of N valid
  balanced postings against random accounts, total balance per currency sums
  to 0 across all accounts.
- Integration (Testcontainers or compose service): the balanced-entry trigger
  rejects an unbalanced INSERT at the DB level — the library can't bypass it.
- Append-only: UPDATE and DELETE on `journal_lines` raise an error.

### D. Reference Chart of Accounts seed
- Migration `0009_chart_of_accounts.sql` seeds the 14-account list above for
  every supported currency that is "active" (start with USD, EUR, GBP, AED, INR).

### E. CLI: `pnpm ledger:balance <account_id>`
- Useful for the demo + dev.

### F. Phase 1 demo
- A test that simulates a capture → posts a balanced 6-line entry → asserts
  `mdr_revenue` ↑ 5 net, `merchant_settlement_liability` ↑ 970, `scheme_receivable` ↑ 1000.
- Then simulates a refund → posts the reverse — assert balances net out.
- Output to stdout as a small "Ledger Tape" so the founder can sanity-check.

---

## Estimated scope

| Item | Lines of code | Time |
|---|---|---|
| Schema migrations (3 files) | ~300 lines SQL | 1 day |
| `packages/ledger` library | ~600 lines TS | 1.5 days |
| Tests (unit + property + integration) | ~500 lines TS | 1 day |
| CoA seed migration | ~150 lines SQL | 0.5 day |
| Demo script + glossary updates | ~100 lines TS + ~30 in MD | 0.5 day |

**Total:** ~4.5 days of focused work for a solo dev.

---

## What's explicitly NOT in Phase 1

- Anything that *writes to* the ledger from a real endpoint (Phase 3+ adds the
  gateway that uses `postJournal`).
- Multi-currency settlement / FX entries (Phase 6).
- Background materialized-view refresh job (Phase 6).
- Per-merchant CoA customization (Phase 8).
- Ledger snapshot exports (Phase 6).
- Anti-tamper hash chains across journal entries (Phase 7+ if needed).

---

Awaiting sign-off on (1) the proposed CoA, (2) the three open questions above,
(3) the sign convention (debit-positive signed column). Then I execute Phase 1
following the same pattern as Phase 0.
