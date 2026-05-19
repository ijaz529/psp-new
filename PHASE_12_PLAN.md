# Phase 12 — Cardholder portal /cards page (Plan)

**Status:** Proposed for review · **Predecessor:** Phase 11 (`PHASE_11_DONE.md`).

Closes the last UX gap from Phase 9 — every other Phase 9 deferral has shipped.

> Portal `/cards` page with balance + recent auths + freeze toggle.
> — PHASE_9_DONE.md §What this enables next

---

## Scope

Two new Fastify-rendered pages inside the existing Phase 8 portal app:

- **`GET /cards`** — list of every card across every cardholder. Columns:
  `id`, `cardholder` (email), `BIN…last4`, `product`, `status`, `currency`,
  `available` (funded balance).
- **`GET /cards/:id`** — detail view. Sections:
  - Card info — id, cardholder, BIN/last4, exp, status, product, account ids
  - Balance — `funded`, `holds`, `available = funded`, currency
  - Recent loads (last 20) — id, amount, status, response code, RRN/STAN, when
  - Recent auth holds (last 20) — id, amount, RRN/STAN, MCC, merchant, status (open / captured / reversed / expired), when

No write actions in this phase. Freeze toggle and controls editor are
deferred — listed at the bottom under "What this enables next".

---

## Decisions locked in §AskUserQuestion

1. **Auth model:** admin view. Any logged-in Phase 8 portal user can see all
   cards. The page is framed as an ops/admin console for now. A proper
   cardholder identity surface (email magic-link or similar) would be its own
   phase; the /cards page would just gain a scope filter when that lands.
2. **Page shape:** two pages — `/cards` list, `/cards/:id` detail. Matches
   the existing `/merchants` + `/merchants/:id` pattern from Phase 8.

---

## Pieces

| Piece | What | Where |
|---|---|---|
| **`cards-views.ts`** | New file. `cardsListPage`, `cardDetailPage`. Reuses `layout` + `BASE_CSS` exports from `dashboard-views.ts`. | `apps/portal/src/cards-views.ts` |
| **Routes** | `GET /cards`, `GET /cards/:id`. Read-only Kysely queries. | `apps/portal/src/index.ts` |
| **Nav** | Add `<a href="/cards">Cards</a>` to the signed-in nav in `layout`. | `apps/portal/src/dashboard-views.ts` |
| **Exports** | Export `layout`, `esc`, `BASE_CSS` from `dashboard-views.ts` if not already. | same |

Zero schema changes. Zero new packages. Zero new dependencies.

---

## Queries

**List page** — one query joining cards, cardholders, products, and
account_balances:

```sql
select c.id, c.bin, c.last4, c.status, c.currency,
       ch.email, ch.full_name,
       p.name as product_name,
       coalesce(ab.balance, 0) as funded_balance
  from paycore.cards c
  join paycore.cardholders ch  on ch.id = c.cardholder_id
  join paycore.card_products p on p.id = c.product_id
  left join ledger.account_balances ab on ab.account_id = c.funded_account_id
 order by c.created_at desc
 limit 200
```

**Detail page** — four queries:
1. Card row + cardholder + product (same join, where c.id = $id).
2. Funded + holds balances from `ledger.account_balances`.
3. `paycore.card_loads where card_id = $id order by created_at desc limit 20`.
4. `paycore.card_auth_holds where card_id = $id order by created_at desc limit 20`.

The 200-row limit on the list and 20-row limit on the detail tables is the
"good enough for the demo" cutoff; real pagination is deferred.

---

## Out of scope (deferred)

- **Freeze toggle / cancel card** — would be a `POST /cards/:id/freeze`
  route + `paycore.cards.status` update. Easy to add once auth scoping is
  clearer.
- **Controls editor** — render + edit `paycore.cards.controls` JSON
  (daily_limit, mcc_blocklist). Needs validation against the `mergeControls`
  function in `@psp-new/issuing`.
- **Trigger card-load from the portal** — a "Load via card" form that POSTs
  to the Phase 11 `/v1/cards/:id/load` endpoint with a tokenized PM. Sits
  awkwardly without a cardholder identity surface.
- **Pagination** — every list is capped at the demo size limits above.
- **Per-cardholder scoping** — comes with cardholder auth.
- **Tests** — the existing portal app ships with `--passWithNoTests`. We
  follow suit; verify by the live `pnpm --filter @psp-new/portal dev`
  walkthrough.

---

## Verifiable success criteria

1. `pnpm typecheck` + `pnpm test` green across all 60 packages.
2. `pnpm --filter @psp-new/portal dev` boots; signed-in user navigates to
   `/cards`, sees the list including any cards previously issued via
   `pnpm card:issue`.
3. Clicking a row opens `/cards/:id`; the page renders all four sections
   without error, and the balance matches `pnpm ledger:balance <funded>`.
4. A card with a Phase 11 load shows the load row under "Recent loads"; a
   card with an open Phase 10 hold shows the hold row under "Recent auth
   holds" with status "open".
