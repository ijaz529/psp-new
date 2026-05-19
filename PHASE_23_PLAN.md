# Phase 23 — Per-card cardholder_stored_value LIABILITY (Plan)

**Status:** Proposed for review · **Predecessor:** Phase 22 (`PHASE_22_DONE.md`).

Refines the Phase 17 accounting model. Phase 17 used a PSP-level
`external_load_clearing` LIABILITY to absorb every cardholder's stored
value into a single aggregate balance. Phase 23 gives each card its own
LIABILITY account so the books balance per-card, not just in aggregate.

---

## Scope

- One nullable column on `paycore.cards`: `stored_value_account_id`
- Card-issue CLI creates a 3rd ledger account at card creation time
  (`cardholder_stored_value` LIABILITY, `owner_kind='issuer'`,
  `owner_id=cardId`) alongside the existing `cardholder_funded` ASSET
  and `cardholder_holds` ASSET
- Phase 17 sweeper (`card-load-acquiring-job.ts`) routes the `-X` leg
  to the per-card account when `cards.stored_value_account_id` is set,
  falls back to the existing PSP-level `external_load_clearing` for
  legacy cards (NULL)
- Cards issued before this phase keep using the PSP-level clearing
  forever. New cards get per-card accounts. No backfill — historical
  data stays where it is.

---

## Pieces

| Piece | What | Where |
|---|---|---|
| **0026 migration** | `ALTER paycore.cards ADD COLUMN stored_value_account_id text references ledger.accounts(id)` (nullable) | `packages/db/migrations/0026_cards_stored_value_account.sql` |
| **Kysely type** | New column | `packages/db/src/kysely.ts` |
| **`card-issue` CLI** | Create the 3rd account; insert `stored_value_account_id` on the cards row | `apps/api/cli/card-issue.ts` |
| **Phase 17 sweeper** | Conditional routing in the journal: `card.stored_value_account_id ?? psp clearing` | `apps/worker/src/card-load-acquiring-job.ts` |
| **Test** | Cover the per-card routing branch | `apps/worker/src/card-load-acquiring-job.test.ts` |

Zero changes to Phase 11 / Phase 14 / Phase 15 / Phase 18. Zero new
accounts at the PSP level — `external_load_clearing` stays as the
legacy-card fallback.

---

## Schema delta (0026)

```sql
alter table paycore.cards
  add column stored_value_account_id text references ledger.accounts(id);
```

Nullable: existing cards (Phase 9-22) stay NULL and continue to use
the PSP-level `external_load_clearing` via the Phase 17 sweeper. Cards
issued after this migration get their own LIABILITY account.

No CHECK constraint linking owner_kind/owner_id — the application enforces
the invariant (created in card-issue CLI alongside funded + holds).

---

## Sweeper routing change

Before:
```ts
postings: [
  { accountId: schemeAccount('scheme_receivable', ccy, scheme), amount: load.amount, currency: ccy },
  { accountId: pspAccount('external_load_clearing', ccy),       amount: -load.amount, currency: ccy },
]
```

After:
```ts
const clearingAccountId = load.stored_value_account_id ?? pspAccount('external_load_clearing', ccy);
postings: [
  { accountId: schemeAccount('scheme_receivable', ccy, scheme), amount: load.amount, currency: ccy },
  { accountId: clearingAccountId,                                amount: -load.amount, currency: ccy },
]
```

The sweeper's query already joins `paycore.cards`'s scheme route via
`payment_methods`; one more SELECT field (`paycore.cards.stored_value_account_id`)
gets it the routing hint.

---

## Out of scope (deferred)

- **Backfill of historical loads.** Existing cards keep their share of
  the PSP-level `external_load_clearing` balance. A future migration
  could walk reconciled `card_loads` per card and re-post the deltas,
  but the demo doesn't need it.
- **Cardholder portal balance display from the stored_value account.**
  The portal already shows `cardholder_funded` as the available balance
  (correct for cardholder UX). The per-card stored_value LIABILITY is a
  back-office accounting view; surfacing it in the portal would just
  confuse cardholders.
- **Cancellation/refund flow that drains stored_value back.** Card-load
  chargeback (still open) would touch this. Phase 23 only handles the
  forward path.

---

## Verifiable success criteria

1. `pnpm typecheck` + `pnpm test` green across all 60 packages.
2. New unit/integration test asserts:
   - Legacy load (card with `stored_value_account_id` NULL) posts to
     PSP-level `external_load_clearing`.
   - Modern load (card with `stored_value_account_id` set) posts to
     that per-card account.
   - `scheme_receivable` leg is identical in both cases.
3. End-to-end (manual): `pnpm card:issue` creates 3 accounts (funded +
   holds + stored_value); subsequent acquiring load posts to the
   per-card stored_value, not the PSP-level clearing; per-card books
   net to 0 (`cardholder_funded +X` / `cardholder_stored_value -X`).
