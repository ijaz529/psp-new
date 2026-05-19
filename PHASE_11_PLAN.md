# Phase 11 — Card-load via the acquiring side (Plan)

**Status:** Proposed for review · **Predecessor:** Phase 10 (`PHASE_10_DONE.md`).
**Closes the closed-loop demo flagged in PHASE_9_DONE §What this enables next.**

> Card-load via the acquiring side (cardholder pays $X with a Visa, that funds
> a Strawberry card).
> — PHASE_9_DONE.md

---

## End-to-end goal

A cardholder uses an external Visa to top up a Strawberry-issued card. The
external auth flows over the real wire (0200 → acquirer-host → scheme-sim →
external stub → 0210 RC 00), and on approve the cardholder's `funded` balance
goes up.

```
   ┌─────────┐  POST /v1/cards/:id/load    ┌─────────┐
   │   API   │ ──────────────────────────▶ │ loadCard │
   │ client  │                             │ engine   │
   └─────────┘                             └────┬─────┘
                                                │ Authorizer (0200)
                                                ▼
                                       ┌─────────────────┐
                                       │ acquirer-host   │
                                       │ → scheme-sim    │
                                       │ → external stub │
                                       └────┬────────────┘
                                            │ RC 00
                                            ▼
                                  post journal:
                                  cardholder_funded +X
                                  issuer_funded_pool -X
                                  insert paycore.card_loads row
```

---

## Decisions locked in §AskUserQuestion

1. **Accounting fidelity:** wire-only. Real 0200 auth on the acquiring side;
   the posted journal is the same shape as the existing `pnpm card:load` CLI
   (`cardholder_funded +X`, `issuer_funded_pool -X`). The acquiring books are
   not touched — the auth is treated as a real-time funds-check, not a
   settlement event. **Documented simplification: the `issuer_funded_pool`
   running deficit grows over time and would be reconciled by an external
   settlement sweep in a production system.**
2. **API surface:** new `POST /v1/cards/:id/load`. Body `{amount, currency,
   payment_method}`. Returns a `card_load` resource. No reuse of the
   PaymentIntent flow — keeps the two concepts cleanly separated.

---

## Pieces

| Piece | What | Where |
|---|---|---|
| **0019 migration** | `paycore.card_loads` audit + idempotency table | `packages/db/migrations/` |
| **Kysely type** | New table in the `Database` interface | `packages/db/src/kysely.ts` |
| **`loadCard` orchestrator** | Validation + 0200 auth via injected `Authorizer` + posted journal in a single txn | `packages/payment-engine/src/orchestrator.ts` (new export) |
| **API route** | `POST /v1/cards/:id/load` | `apps/api/src/routes/v1/cards.ts` (NEW file) — registered in `server.ts` |
| **ID prefix** | `card_load` → `cl_` | `packages/ids/src/index.ts` |

No changes to acquirer-host, scheme-sim, issuer-host, or vault — the existing
acquiring stack already handles an external 0200 to completion.

---

## Data model — `paycore.card_loads`

```sql
create table paycore.card_loads (
  id                 text primary key,                       -- cl_*
  card_id            text not null references paycore.cards(id),
  payment_method_id  text not null references paycore.payment_methods(id),
  amount             bigint not null check (amount > 0),
  currency           char(3) not null references ledger.currencies(code),
  status             text not null check (status in ('succeeded', 'failed')),
  response_code      char(2) not null,                       -- DE 39
  rrn                char(12),                               -- DE 37 (null on early-fail)
  stan               char(6),                                -- DE 11 (null on early-fail)
  failure_code       text,                                   -- e.g. 'card_declined'
  failure_message    text,
  journal_entry_id   text references ledger.journal_entries(id), -- null on failure
  created_at         timestamptz not null default now()
);
create index card_loads_card_idx on paycore.card_loads (card_id, created_at desc);
```

Idempotency on the API side is handled by the existing `Idempotency-Key`
infrastructure (same as the rest of `/v1/*`). The `paycore.card_loads` row is
the authoritative audit record.

---

## Orchestrator shape

```ts
export interface LoadCardInput {
  readonly cardId: string;
  readonly paymentMethodId: string;
  readonly amountMinor: bigint;
  readonly currency: string;
  /** Caller-supplied `Authorizer` — same port as Phase 5+. */
  readonly authorizer: Authorizer;
}

export interface CardLoadRecord {
  readonly id: ResourceId<'card_load'>;
  readonly cardId: string;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly status: 'succeeded' | 'failed';
  readonly responseCode: string;
  readonly rrn: string | null;
  readonly stan: string | null;
  readonly failureCode: string | null;
  readonly failureMessage: string | null;
  readonly created: Date;
}

export async function loadCard(
  db: Kysely<Database>,
  input: LoadCardInput,
): Promise<CardLoadRecord>;
```

Flow inside `loadCard`:
1. Load card (lock-free) — must exist, status `active`, product currency must
   match `input.currency`. Reject with `resource_missing` or
   `currency_unsupported`.
2. Load payment_method — must exist, must be external (a Strawberry-issued
   card's PAN is in a Strawberry BIN range; we reject those to prevent a
   self-fund loop). Reject with `resource_missing` /
   `card_funding_not_allowed`.
3. Call `authorizer({ paymentIntentId: cardLoadId, captureMethod: 'automatic',
   ... })` — the `automatic` capture method drives the acquirer-host to emit
   `0200`. The acquirer-host already accepts any reference id; the
   `payment_intent_id` field is just for logging correlation.
4. On approve (RC `00`): in one txn, insert the `card_loads` row with
   `status='succeeded'` AND post the journal (`cardholder_funded +X`,
   `issuer_funded_pool -X`). Store the journal entry id on the row.
5. On decline: insert the `card_loads` row with `status='failed'`, the
   response code, and the failure metadata. No journal.

The orchestrator returns the `CardLoadRecord` either way; the api maps
`status='failed'` to the right HTTP status.

---

## API surface

```
POST /v1/cards/:id/load
Authorization: Bearer sk_test_…
Content-Type: application/json
Idempotency-Key: <optional>

{ "amount": 5000, "currency": "USD", "payment_method": "pm_<external>" }

→ 201 Created
{
  "id": "cl_…",
  "object": "card_load",
  "card": "card_…",
  "amount": 5000,
  "currency": "USD",
  "status": "succeeded",
  "response_code": "00",
  "rrn": "601201000001",
  "stan": "000001",
  "created": 1234567890
}
```

Errors follow the standard PspError → 4xx/5xx mapping. A declined load returns
`HTTP 402` with `error.code = 'card_declined'`.

---

## Out of scope (deferred)

- **Cardholder webhooks** — `card.loaded` / `card.load_failed` events are not
  emitted. Phase 9 declared these but never wired the cardholder webhook
  channel; Phase 11 stays consistent. Add when the cardholder portal exists.
- **Partial reversal** — a successful load can't be reversed via this
  endpoint. The 0420 path is merchant-PI-only for now.
- **Refunds** — `pnpm card:unload` or `POST /v1/card_loads/:id/refund` is not
  built. Reverse via a manual CLI journal in the meantime.
- **Cardholder authentication** — the endpoint requires a merchant secret key
  (same auth as the rest of `/v1/*`) because there is no cardholder identity
  surface yet. In production this would be a cardholder portal token.
- **Pool reconciliation** — `issuer_funded_pool` accumulates a running
  deficit. A periodic sweep from the scheme settlement files into the pool is
  needed for a production deployment.

---

## Tests

| Suite | Coverage |
|---|---|
| `packages/payment-engine/src/orchestrator.load-card.test.ts` (NEW) | Unit tests with mocked Authorizer + in-memory Kysely against pg-lite or full HAS_DB-gated against real pg. Cover: (a) approve writes both row + journal; (b) decline writes row only; (c) inactive card rejected; (d) Strawberry-BIN payment_method rejected; (e) currency mismatch rejected |
| `apps/api/src/routes/v1/cards.test.ts` (NEW, if needed) | Light integration: POST with valid body returns 201; declined returns 402; missing card returns 404 |

Per the repo pattern (`HAS_DB`-gated integration when no good unit-test seam),
the orchestrator test will be `HAS_DB`-gated and follow `issuer-host`'s test
shape from Phase 10.

---

## Verifiable success criteria

1. `pnpm typecheck` + `pnpm test` green across all packages.
2. With compose up: `POST /v1/cards/:id/load` with a known-approve external
   PAN (e.g. via a payment_method created from `4111111111111111`) results in
   `cardholder_funded` balance going up by the amount, `issuer_funded_pool`
   going down by the same, and a `paycore.card_loads` row with
   `status='succeeded'`.
3. Same with a known-decline PAN (e.g. `4000000000000999` → RC 51) results in
   a `paycore.card_loads` row with `status='failed'` AND no journal change.
4. Submitting a `payment_method` whose `bin` falls within a configured
   Strawberry BIN range returns `400 card_funding_not_allowed`.

---

## Open questions

None — both decisions locked above. Ready to build on approval.
