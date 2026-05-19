# Phase 10 — Hold lifecycle: capture & reversal (Plan)

**Status:** Proposed for review · **Predecessor:** Phase 9 (`PHASE_9_DONE.md`).
**Drives the explicit "approve = settle" simplification out of Phase 9.**

> A second pass on hold lifecycle: have `apps/api`'s capture endpoint emit a
> 0220 to the scheme-simulator; the simulator routes it to issuer-host;
> issuer-host marks the hold `captured` and posts the settlement journal.
> Today's "approve = settle" simplification disappears.
> — PHASE_9_DONE.md §What this enables next

---

## End-to-end goal

Real two-step issuer-side lifecycle, modelled in ISO 8583:

```
manual-capture PI                          auto-capture PI
─────────────────                          ────────────────
api confirm  →  0100 auth-only             api confirm  →  0200 combined auth+settle
              ←  0110 RC 00                              ←  0210 RC 00
api capture  →  0220 capture
              ←  0230 RC 00
                                           api cancel (post-auth)
                                                        →  0420 reversal
                                                        ←  0430 RC 00
```

On the issuer ledger:

| MTI | Journal effect |
|---|---|
| `0100` approve | `funded -X`, `holds +X`  (reserve; not yet settled) |
| `0200` approve | `funded -X`, `holds +X` **plus** `holds -X`, `settlement +X` in same txn |
| `0220` capture | `holds -X`, `settlement +X` (resolve hold `captured`) |
| `0420` reversal | `holds -X`, `funded +X` (resolve hold `reversed`) |

Sign convention preserved from Phase 9 (`amount > 0` = debit, `amount < 0` = credit; postings sum to zero).

---

## Pieces

| Piece | What | Where |
|---|---|---|
| **0018 migration** | Add `last_auth_rrn`, `last_auth_stan` to `paycore.payment_intents`. No changes to `card_auth_holds` (existing `resolved_reason` enum already covers `captured`/`reversed`/`expired`; existing `unique(stan,rrn)` is the lookup index for 0220/0420). | `packages/db/migrations/0018_pi_auth_refs.sql` |
| **issuer-host** | New branches for MTI `0200` (combined auth+settle), `0220` (capture), `0420` (reversal). Lookup hold by `(stan, rrn)`. Make `0100` write `funded → holds` only (not the settlement leg). Update `readAvailableBalance` formula to just `funded.balance`. | `apps/issuer-host/src/handler.ts` |
| **acquirer-host** | New endpoints `/internal/v1/capture` and `/internal/v1/reverse`. Refactor existing `/internal/v1/authorize` to take a `capture_method` and emit `0100` vs `0200`. New endpoints build `0220` / `0420` with echoed RRN+STAN. | `apps/acquirer-host/src/` (new `capture.ts`, `reverse.ts`; edit `authorize.ts`) |
| **payment-engine** | `AuthorizeResponse` gains `rrn` and `stan`. `confirmPaymentIntent` persists them on the PI. New `Settler` and `Reverser` dependency types injected into `capturePaymentIntent` / `cancelPaymentIntent`. Both call out to acquirer-host before posting the merchant-side journal. | `packages/payment-engine/src/orchestrator.ts` |
| **api wiring** | Build `capture` + `reverse` clients alongside `buildAcquirerAuthorizer`. Plumb into capture + cancel routes. | `apps/api/src/lib/authorizer.ts` (split into `acquirer-clients.ts`), `apps/api/src/lib/context.ts`, `routes/v1/payment-intents.ts` |
| **scheme-simulator** | BIN-router gets a new path for `0220`/`0420` MTIs — same routing rule (Strawberry BIN → issuer-host; external → stub auto-ack with `0230`/`0430` RC 00). | `apps/scheme-simulator/src/issuer.ts` |
| **card-issue CLI** | Change `cardholder_holds` account creation from `LIABILITY` → `ASSET`. (Both legal under our sign convention, but ASSET matches the "funds the cardholder owns, currently encumbered" semantics. New cards only — no migration of in-flight dev cards.) | `apps/api/cli/card-issue.ts` |

---

## Schema delta (0018_pi_auth_refs.sql)

```sql
alter table paycore.payment_intents
  add column last_auth_rrn  char(12),
  add column last_auth_stan char(6);

-- (optional) partial index if we ever scan by RRN. Skipping for MVP — capture
-- always loads the PI by id first, then reads these as plain columns.
```

That's the entire migration. No new tables.

---

## Codec

`Iso8583Message['mti']` union already declares `'0220' | '0221' | '0420' | '0421'`. Field set is identical to `0100`/`0200` for our purposes. No `packages/iso8583` changes expected — `index.test.ts` should already round-trip these MTIs (verify; add a test if not).

---

## Issuer-host handler shape

Replace the single `handleIssuerAuth` with a `routeMessage(reqBytes)` dispatcher:

```ts
switch (req.mti) {
  case '0100': return handleAuthHoldOnly(req, deps);      // funded -X, holds +X
  case '0200': return handleAuthAndSettle(req, deps);     // funded -X, holds +X; holds -X, settlement +X
  case '0220': return handleCapture(req, deps);           // resolve hold → settlement
  case '0420': return handleReversal(req, deps);          // resolve hold → funded
  default:     return encode(buildMessage('0110', { 39: '96' }));
}
```

Hold resolution:
- Lookup `paycore.card_auth_holds` where `(stan, rrn) = (DE 11, DE 37)` AND `resolved_at IS NULL`.
- Not found → `RC 25` (no original transaction).
- Already resolved → `RC 94` (duplicate transmission) — idempotency aid.
- On success: `UPDATE … SET resolved_at=now(), resolved_reason='captured'|'reversed'` + post the second journal.

`readAvailableBalance` simplifies to a single SELECT on the funded account.

---

## Acquirer-host endpoints

**`POST /internal/v1/capture`** — body:
```ts
{ payment_intent_id, rrn, stan, token, amount_minor, currency_numeric }
```
Builds `0220` with DE 2 (PAN, via vault detokenize), DE 3 `220000` (proc code: completion), DE 4 (amount), DE 11 (echo STAN), DE 37 (echo RRN), DE 49 (currency). Sends via existing `SchemeClient`. Returns `{ approved, response_code, rrn, stan }`.

**`POST /internal/v1/reverse`** — same shape, MTI `0420`, DE 3 `030000` (refund / chargeback-like reversal).

Both reuse `SchemeClient` and `StanAllocator` — the `StanAllocator` allocates a *new* STAN for the 0220 itself (per spec), but the **echoed** original STAN goes in DE 90 (original-data-elements). For MVP we cheat: just send the original STAN as DE 11 — the issuer-host looks up holds by exactly that. Documented in §Simplifications.

---

## Orchestrator shape

```ts
export interface CapturePaymentIntentInput {
  paymentIntentId: string;
  merchantId: string;
  scheme: 'visa' | 'mastercard' | 'amex';
  settler?: Settler;       // new — calls acquirer-host /capture; omit in unit tests
}

export interface CancelPaymentIntentInput {
  paymentIntentId: string;
  merchantId: string;
  reverser?: Reverser;     // new — calls acquirer-host /reverse for post-auth cancel
}

export type Settler = (req: SettleRequest) => Promise<SettleResponse>;
export type Reverser = (req: ReverseRequest) => Promise<ReverseResponse>;
```

- `capturePaymentIntent`: if `settler` present AND `last_auth_rrn` is set on the PI, await `settler(...)`. On non-`00` RC, throw `acquirer_declined`. Then post the existing merchant-side capture journal.
- `cancelPaymentIntent`: if status is `requires_capture` AND `reverser` present AND `last_auth_rrn` is set, await `reverser(...)` before transitioning. Auto-capture cancels (status=`requires_payment_method` etc.) keep current behaviour — nothing to reverse.

`confirmPaymentIntent`/`runAuthorizeAndPost` change: persist `resp.rrn` + `resp.stan` to the PI in the same transaction that writes the auth result.

---

## Scheme-simulator change

`handleAuthRequest` currently filters on `req.mti !== '0100' && req.mti !== '0200'`. Widen to also accept `'0220'`, `'0420'`. Routing logic is identical (BIN → issuer-host vs stub). Stub-issuer paths for `0220`/`0420` auto-respond `RC 00` (`0230`/`0430`) — external cards aren't tracked, just acknowledge.

---

## API surface changes

No breaking changes to the public REST API. `POST /v1/payment_intents/:id/capture` and `POST /v1/payment_intents/:id/cancel` keep their request shape. Response includes the updated state machine as before.

New behaviour observable via:
- Webhook events `payment_intent.amount_capturable_updated` already fires on auth-success for manual-capture (existing Phase 3 behavior). Keep that.
- New event: `payment_intent.canceled` now fires AFTER the reversal RC arrives (was: posted unconditionally). On reversal decline → `payment_intent.cancel_failed` (NEW event type).

---

## Tests

| Suite | Coverage |
|---|---|
| `packages/iso8583/src/index.test.ts` | Add round-trip tests for `0220`/`0420` if not already present (verify first) |
| `apps/issuer-host/src/handler.test.ts` | NEW. Unit tests with mocked DB for: (a) 0100 writes funded→holds only; (b) 0200 writes both legs; (c) 0220 resolves an open hold + posts settlement; (d) 0420 resolves an open hold + returns funded; (e) duplicate 0220 returns RC 94; (f) 0220 against unknown (stan,rrn) returns RC 25 |
| `apps/scheme-simulator/src/issuer.test.ts` | Extend: 0220 and 0420 BIN-routing parity tests |
| `apps/acquirer-host/src/capture.test.ts` | NEW. Build a 0220, send through a mock SchemeClient, assert MTI + DE 11/37 echoed correctly |
| `packages/payment-engine/src/orchestrator.test.ts` | Add: capture with `settler` present persists rrn/stan + calls settler; cancel of `requires_capture` PI calls reverser; settler-decline throws `acquirer_declined` |
| `tests/e2e/` (if Docker is up — gated) | One end-to-end script: issue card → load → manual-capture PI → confirm → expect hold open in `card_auth_holds` → capture → expect hold resolved + settlement balance moved |

---

## Demo script

```bash
make up && make migrate

# Issue + load (Phase 9)
pnpm cardholder:create --email demo@example.com --name "Demo"
pnpm card:issue --cardholder <ch_…> --product prod_strawberry_visa_usd
pnpm card:load --card <card_…> --amount 100.00

# Manual-capture PI — separate auth + capture
curl -X POST $API/v1/payment_intents \
  -H "Authorization: Bearer sk_test_…" \
  -d '{"amount":3000,"currency":"USD","capture_method":"manual","payment_method":"pm_<card>","confirm":true}'
# → status: requires_capture
# pnpm ledger:balance <funded>  → 100.00 (unchanged)
# pnpm ledger:balance <holds>   →  30.00
# pnpm ledger:balance <issuer_settlement:USD>  → 0

curl -X POST $API/v1/payment_intents/<pi_…>/capture
# → status: succeeded
# pnpm ledger:balance <funded>  →  70.00
# pnpm ledger:balance <holds>   →   0.00
# pnpm ledger:balance <issuer_settlement:USD>  → 30.00

# Reversal path — auth then cancel before capture
curl -X POST $API/v1/payment_intents -d '{... capture_method:"manual" ...}'
curl -X POST $API/v1/payment_intents/<pi_…>/cancel
# → status: canceled, holds released, funded restored.
```

---

## Out of scope (deferred)

- **DE 90 (Original Data Elements)** — real 0220/0420 carry the original DE 11/37/4 inside DE 90. We send them inline as the top-level DE 11/37 for MVP lookup convenience.
- **Partial capture / partial reversal** — capture is full-amount only. Stripe-style multiple captures against one auth not yet supported.
- **Auth expiry sweep** — `resolved_reason='expired'` is in the enum but no scheduled worker writes it yet. A future cron walks `card_auth_holds` where `created_at < now() - interval '7 days' AND resolved_at IS NULL`.
- **0421 reversal-advice retry semantics** — issuer-host treats every reversal as authoritative; real schemes have store-and-forward retry on 0421.
- **External-card capture realism** — stub-issuer for non-Strawberry BINs just auto-acks 0230/0430. No simulated decline paths on capture.
- **`payment_intent.cancel_failed` event** is added but the portal does not render it yet.

---

## Verifiable success criteria

1. `pnpm test` is green for all new/changed suites.
2. Running the demo script: `card_auth_holds` row exists with `resolved_at = NULL` between confirm and capture; row has `resolved_reason = 'captured'` after capture; ledger balances match the table above at each step.
3. Running the reversal path: same row ends with `resolved_reason = 'reversed'`; funded balance restored to pre-auth value.
4. `pnpm assertNoPan` audit still passes (no PAN logging on the new paths).
5. Existing Phase 1–9 e2e tests still pass — no regressions.

---

## Open questions for review

1. **API surface for cancel-after-auth.** Today `cancelPaymentIntent` exists on PI. Reuse it, or add `POST /v1/payment_intents/:id/reverse_auth` for clarity? Recommendation: **reuse cancel** — Stripe-parity, the state machine already gates on status.
2. **Settler/Reverser as `Authorizer`-style injected ports** vs. inlined HTTP clients in the orchestrator. Recommendation: **injected ports**, matching the Phase 5 Authorizer pattern — keeps the engine unit-testable without acquirer-host.
3. **Cardholder_holds account type change** (LIABILITY → ASSET) — small breaking change for any in-flight dev cards. Recommendation: change it, accept that dev cards issued before Phase 10 need re-issuing.
