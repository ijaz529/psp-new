# Phase 42 — Done

**Date:** 2026-08-06 · **Status:** `make e2e` runs a real payment end
to end and the books balance. Plan: `PHASE_42_PLAN.md`.

The PROJECT_BRIEF §5 canary exists, 42 phases after it was specified:

```
e2e canary — full payment → ledger → clearing → settlement → payout
  ✓ api healthz
  ✓ merchant fixture
  ✓ vault tokenize            (real vault, KMS envelope)
  ✓ payment_method
  ✓ payment_intent            succeeded, RRN 621808000001 STAN 000001
  ✓ refund                    amount_received 10000 → 7500
  ✓ nightly-once              clearing + payouts + scheme settlement
  ✓ clearing record           real RRN in visa_usd_<date>.b2
  ✓ payout                    paid
  ✓ scheme settlement         scheme_receivable USD drained to 0
  ✓ ledger zero-sum           every currency sums to 0
CANARY PASSED — 11 steps green
```

## The canary earned its name immediately — four latent bugs found

None of these could have been caught without actually booting the
full stack and pushing a payment through the wire:

1. **The Docker image never copied `pnpm-lock.yaml`** — image
   `pnpm install` resolved unpinned versions, so the host's
   bind-mounted per-app `node_modules` symlinks dangled inside the
   image's `.pnpm` store. Nothing could boot once host and image
   drifted. Fixed: lockfile copied, `--frozen-lockfile`.
2. **The committed dev KMS master key was 43 bytes** (base64 of a
   43-char string; LocalKmsProvider requires exactly 32). The vault
   had never successfully booted with it. Fixed in `.env.example` /
   `docker-compose.yml` (no vault data existed to re-encrypt).
3. **acquirer-host and worker crashed at boot on Fastify 5**:
   `addHook` after `listen` → `FST_ERR_INSTANCE_ALREADY_LISTENING`.
   Masked before by the version-drifted image. Fixed: hooks
   registered before listen in both.
4. **No auth had ever crossed the wire: `nextRrn` built 16-digit
   RRNs** (year+day+**hhmmss**+serial) against DE 37's fixed 12
   (year+day+**hh**+serial). Every real ISO 8583 authorize since
   Phase 5 threw at encode and surfaced as `acquirer_timeout` /
   card_declined. All prior "wire" verification used stub
   authorizers or hand-seeded rows, so this was invisible. Fixed in
   `apps/acquirer-host/src/stan.ts`.

Also fixed: the Phase 0 smoke's idempotency-replay checks were stale
(the echo route opts out of idempotency since the Phase 32
principal-based plugin) — trimmed, with merchant replay now covered
by the Phase 41 integration tests.

## What shipped

- **`apps/api/cli/e2e-canary.ts`** — the driver described in the
  plan; `pnpm canary` from the root. Loads `DATABASE_URL` from `.env`
  when unset. Same-day re-runs are green with honest "skipped —
  daily idempotency" notes for the clearing/settlement assertions
  (one clearing file per (scheme, currency, date), one
  `scheme_settle` journal per day — by design).
- **`apps/worker/cli/nightly-once.ts`** — one synchronous nightly
  pass (`asOf = now + 24h` so "yesterday" = today); `nightly:once`.
  Replaces the shorten-the-interval-envs demo dance.
- **`Makefile` `e2e`** — sources `.env`, runs smoke then canary.

## Verify

| Check | Result |
|---|---|
| `make e2e` (fresh day path) | CANARY PASSED — 11/11, full assertions |
| `pnpm canary` re-run same day | PASSED — 11/11 with 2 honest skips |
| `pnpm typecheck` / `pnpm test` | 60/60 each |

## Found, not fixed (open list candidates)

- **Payout double-nets refunds**: `runPayout` computes
  `amount_received − refunds`, but `createRefund` already decrements
  `amount_received` — the canary run paid 5000 where the settlement
  liability held 7275 (10000 − 300 MDR − 2425 refund net). Liability
  is left undrained. Known Phase-6 simplification, now with a live
  repro.
- Same-day nightly re-emission: transactions created after the day's
  clearing file exists never clear (unique file per date). Real
  systems cut over at day end; noted.

## Open list

- Fix payout netting (double-count above).
- Phase 39 portal click-through (portal blocked on host port 3000
  being taken by an unrelated process this session).
- Map Fastify's empty-JSON-body error to 400 (Phase 41 finding).
- Vault-in-harness for tokens/payment-method/3DS test breadth.
- CI job that runs `make e2e` against compose.
- README refresh (still says Phase 0; quickstart lacks `make
  migrate`) — 42 phases of drift.
