# Phase 9 — Issuing side (Plan)

**Status:** Proposed for review · **Predecessor:** Phase 8 (`PHASE_8_DONE.md`).
**Brief reference:** PROJECT_BRIEF.md §3 Phase 9 (marked *later, optional*).

> Card program management, BIN range, virtual card issuance, authorization
> controls, spending controls. The same scheme simulator now plays the role
> the issuer plays — receives auths, applies controls, returns approval/decline.
> — PROJECT_BRIEF.md

This phase makes the platform symmetric: Strawberry already acquires (a merchant
charges a Visa). Phase 9 makes it issue (a cardholder spends on a Strawberry-
issued card at some merchant). When the same merchant is on our acquiring side
AND the card is on our issuing side, the entire round-trip stays inside this
codebase — closed-loop demo.

---

## End-to-end goal

```
                   ╔══════════════════════════════════╗
                   ║         scheme-simulator          ║
                   ║   route by BIN:                   ║
                   ║   - external BIN → stub issuer   ║
                   ║   - Strawberry BIN → issuer-host ║
                   ╚════════════════╤══════════════════╝
                  acquirer leg      │      issuer leg
   ┌──────────────────┐  0100  ┌────▼─────┐  0100  ┌──────────────────┐
   │  api / acquirer  │ ─────▶ │  scheme  │ ─────▶ │   issuer-host    │
   │       host       │ ◀───── │   sim    │ ◀───── │ (NEW Phase 9)    │
   └──────────────────┘  0110  └──────────┘  0110  └────────┬─────────┘
                                                            │
                                                  apply controls
                                                  hold funds (ledger)
                                                  approve / decline
```

---

## Pieces

| Piece | What | Where |
|---|---|---|
| **0017 migration** | `paycore.card_products`, `paycore.cardholders`, `paycore.cards`, `paycore.card_auth_holds`, plus issuing chart-of-accounts | `packages/db/migrations/` |
| **`@strawberry/issuing`** | Pure domain — PAN generation (BIN + Luhn), authorization-control engine, balance projection | new package |
| **`apps/issuer-host`** | TCP 8583 receiver. Reverse of acquirer-host: takes 0100 in, applies controls, returns 0110 | new app |
| **scheme-simulator routing** | Existing simulator gains a BIN-router: if PAN ∈ Strawberry BIN range, forward to issuer-host; else respond as today | edit `apps/scheme-simulator/` |
| **Card CLI** | `card:issue`, `card:load`, `card:freeze` — bootstrap demo cards from the command line | `apps/api/cli/` |
| **Portal page** | `/cards` — list cards, balances, recent auths, freeze/unfreeze | `apps/portal/` |
| **Webhooks** | `card.issued`, `card.authorized`, `card.declined`, `card.captured` | extends Phase 3 webhook delivery |

---

## Data model (sketch)

### `paycore.card_products`
One row per product. MVP ships exactly one (a Strawberry-test debit). Defines BIN
range, currency, scheme (we'll register a test BIN as Mastercard), and default
controls.

```sql
create table paycore.card_products (
  id              text primary key,                -- prod_*
  name            text not null,
  scheme          text not null check (scheme in ('visa', 'mastercard')),
  bin_range_low   char(9) not null,                -- '555555000'
  bin_range_high  char(9) not null,                -- '555555999'
  currency        char(3) not null references ledger.currencies(code),
  default_controls jsonb not null,                 -- {daily_limit, mcc_block, ...}
  created_at      timestamptz not null default now()
);
```

### `paycore.cardholders`
The "natural person" entity. For B2B card programs the cardholder is linked to
a merchant (an employee); for MVP we ship a simple model without that link
(cardholder is standalone).

```sql
create table paycore.cardholders (
  id           text primary key,                   -- ch_*
  email        citext not null unique,
  full_name    text not null,
  phone        text,
  status       text not null check (status in ('active', 'suspended')) default 'active',
  created_at   timestamptz not null default now()
);
```

### `paycore.cards`
The actual issued card. PAN stored as vault token (we reuse `vault.tokens`,
distinguishing issued-vs-collected by `merchant_id` namespace).

```sql
create table paycore.cards (
  id                text primary key,              -- card_*
  product_id        text not null references paycore.card_products(id),
  cardholder_id     text not null references paycore.cardholders(id),
  pan_token         text not null,                 -- vault token id
  last4             char(4) not null,
  exp_month         char(2) not null,
  exp_year          char(4) not null,
  status            text not null check (status in ('active', 'frozen', 'cancelled')) default 'active',
  controls          jsonb not null,                -- overlay over product defaults
  funded_account_id text not null references ledger.accounts(id),
  created_at        timestamptz not null default now()
);
```

### `paycore.card_auth_holds`
Active authorization holds. On 0100-approval we INSERT; on capture/reversal/
expiry we DELETE (or mark resolved) and post journal entries.

```sql
create table paycore.card_auth_holds (
  id                text primary key,              -- hold_*
  card_id           text not null references paycore.cards(id),
  stan              text not null,                 -- DE 11
  rrn               text not null,                 -- DE 37
  amount            bigint not null check (amount > 0),
  currency          char(3) not null references ledger.currencies(code),
  merchant_name     text,                          -- DE 43 acceptor name
  mcc               char(4),                       -- DE 18
  created_at        timestamptz not null default now(),
  resolved_at       timestamptz,
  resolved_reason   text check (resolved_reason in ('captured', 'reversed', 'expired')),
  unique (stan, rrn)
);
```

### Ledger extension — issuing chart of accounts
Per cardholder funded balance, plus an "auth-hold" sub-account. Mirrors the
acquiring CoA we built in Phase 1:

```
cardholder_funded:<cardholder_id>     -- the cardholder's available balance
cardholder_holds:<cardholder_id>      -- amounts currently held by open auths
issuing_settlement                     -- shared, where captures land
```

---

## Authorization-control engine

Pure function `evaluateAuthControls(card, request, balances): Decision`.
For MVP, three checks in order:

1. **Card status** — frozen / cancelled → decline RC 05
2. **Available balance** — (funded − holds) < amount → decline RC 51 (insufficient funds)
3. **Daily limit** — sum of today's holds + amount > daily_limit → decline RC 61 (exceeds withdrawal limit)

Decline RCs follow ISO 8583 DE 39 — same code table the acquirer side already maps.

Stretch (not in MVP): MCC block-list (DE 18), country code (DE 19), velocity over rolling windows.

---

## Issuer-host (the new app)

Mirrors `apps/acquirer-host/` in shape. Keeps a persistent TCP listener on a new
port (e.g. 9101). Receives ISO 8583 from the scheme-simulator; decodes; calls
`evaluateAuthControls`; updates `card_auth_holds` + ledger; encodes 0110 response.

Process boundary so the issuer can be killed/restarted independently — same
philosophy as acquirer-host.

---

## Scheme-simulator change

Existing simulator unconditionally responds. Becomes a thin BIN-router:

```ts
function routeAuth(msg: Iso8583Message): Promise<Iso8583Message> {
  const pan = msg.fields.DE2;
  if (isStrawberryBin(pan)) {
    return forwardToIssuerHost(msg);          // NEW
  }
  return existingStubIssuer(msg);              // existing always-approve / decline-by-bin
}
```

---

## Closed-loop demo flow

After Phase 9:

1. `pnpm cardholder:create --email a@b.com --name "Alice"`
2. `pnpm card:issue --cardholder ch_… --product prod_strawberry_debit`
3. `pnpm card:load --card card_… --amount 100.00`
4. A Strawberry-acquired merchant charges the card via `/v1/payment_intents`.
5. acquirer-host → scheme-sim → issuer-host → balance check → approve.
6. Ledger: merchant credited (acquiring side), cardholder debited (issuing side), zero-sum.
7. Portal shows both: merchant dashboard sees the receipt, issuing page shows the auth + new balance.

---

## What this phase does NOT ship

- Real cardholder portal (cardholders can only be created via CLI; no self-serve)
- Card-controls UI beyond status toggle (MCC/geo etc. defer to a future phase)
- Statements (PDF/CSV month-end) — data is in the ledger; generator is post-MVP
- Card-funding via real card top-up — funded by CLI/admin grant only
- Refunds / reversals on the issuing side beyond a basic 0420 reversal path
- Cardholder KYC (out of scope per brief §6)
- Real Mastercard / Visa BIN allocations — we own a private test BIN range

---

## Tests

- Unit: PAN generator round-trips Luhn for every BIN in the test range.
- Unit: authorization-control engine — table-driven cases for each decline path.
- Integration: load → issue → authorize → capture round-trip with ledger zero-sum assertion.
- Property: any approved auth followed by full capture sums to net zero across acquiring + issuing accounts in the same currency.

---

## Open clarifications

See the AskUserQuestion that accompanies this plan. Five Qs covering: BIN/scheme
choice, cardholder ↔ merchant relationship, funding source, simulator routing
shape, and scope of authorization controls.
