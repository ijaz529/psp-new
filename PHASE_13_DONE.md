# Phase 13 — Done

**Date:** 2026-05-19 · **Status:** Auth-expiry sweeper landed. Plan: `PHASE_13_PLAN.md`.

A periodic worker job now reclaims funds from stale open holds. Without this,
a Strawberry-issued card whose 0100 hold is never followed by a 0220 capture
or 0420 reversal would leak cardholder funds into `cardholder_holds` forever.

## What shipped

- **`apps/worker/src/auth-expiry-job.ts` (NEW)** — `expireStaleAuthHolds`
  function. Selects `paycore.card_auth_holds` rows with `resolved_at IS NULL
  AND created_at < asOf - windowMs`, joining on `paycore.cards` for the
  ledger account ids. For each, posts a Phase-10-reversal-shaped journal
  (`holds_account_id −X`, `funded_account_id +X`) and updates the row to
  `resolved_at = asOf`, `resolved_reason = 'expired'` — in a per-hold
  transaction so a single bad row never poisons the whole run. Idempotency
  rides the journal's `externalId = 'auth_expire:${hold.id}'` unique index.
- **`apps/worker/src/index.ts`** — `setInterval` wiring next to the existing
  `runNightlyJobs` + `refreshAccountBalances` timers. Defaults: **6h
  cadence, 7d expiry window**. Env-overridable via `AUTH_EXPIRY_INTERVAL_MS`
  and `AUTH_EXPIRY_WINDOW_MS`. Cleanup goes through the same `onClose` hook
  that already exists.
- **`apps/worker/package.json`** — added `@psp-new/ledger` as a workspace
  dep so the job can call `postJournal`.
- **`apps/worker/src/auth-expiry-job.test.ts` (NEW)** — HAS_DB-gated
  integration test, two cases:
  - Stale open hold (8 days old) is expired; ledger balances reflect the
    reversal. Fresh hold (created now) is untouched.
  - Second sweep against an already-cleared state is a clean no-op
    (`scanned: 0`, `expired: 0`).

Zero schema changes — the `resolved_reason = 'expired'` enum value and the
`card_auth_holds_open_idx` partial index both came from Phase 9 (`0017`).
The migration is genuinely a no-op for Phase 13.

## Demo path

```bash
make up && make migrate
docker compose up -d worker

# Issue + load a card (Phase 9 / 11)
pnpm cardholder:create --email demo@example.com --name "Demo"
pnpm card:issue --cardholder <ch_…> --product prod_strawberry_visa_usd
pnpm card:load --card <card_…> --amount 100.00

# Trigger a manual-capture auth so a hold row exists
curl -X POST $API/v1/payment_intents -H "Authorization: Bearer sk_test_…" \
  -d '{"amount":3000,"currency":"USD","capture_method":"manual",
       "payment_method":"pm_<external>","confirm":true}'

# Force the expiry window down so the demo doesn't take a week
AUTH_EXPIRY_WINDOW_MS=1000 AUTH_EXPIRY_INTERVAL_MS=10000 \
  docker compose restart worker

# Wait ~10s, then check
psql -c "select id, resolved_reason, resolved_at from paycore.card_auth_holds order by created_at desc limit 5"
# → newest hold: resolved_reason='expired', resolved_at non-null

pnpm ledger:balance <funded>   # back to 100.00
pnpm ledger:balance <holds>    # back to 0
```

## Tests

| Suite | Coverage |
|---|---|
| `apps/worker/src/auth-expiry-job.test.ts` (NEW) | 2 HAS_DB-gated cases: (a) stale row expired + funds returned, fresh row untouched; (b) re-run is idempotent no-op |
| Existing 60-package suite | Green. No behavioural changes to any existing path. |

`pnpm typecheck` + `pnpm test` both green across all 60 packages. The two
new tests are `describe.skipIf(!HAS_DB)` and execute when the compose stack
is up — matches the issuer-host and ledger integration suites.

## Simplifications vs. real life

These are documented in `PHASE_13_PLAN.md §Out of scope`:

- **No `0421` reversal-advice retransmit.** Real schemes notify the
  acquirer when an issuer expires a hold so the acquirer's books can
  reconcile. Our acquirer-side hold accounting was already deferred (Phase
  11), so nothing to reconcile.
- **No `card.auth_expired` webhook.** The cardholder webhook channel still
  doesn't exist (Phase 9 declared it, Phase 11+12 carried the deferral
  forward). Add when the cardholder portal does.
- **No per-product expiry windows.** `paycore.card_products` could carry an
  `auth_expiry_hours` column; for now one env-driven default is enough.
- **No distributed leader election.** A single worker `setInterval` is fine
  for the dev stack. Production would use a BullMQ repeatable job + Postgres
  advisory lock (same shape Phase 6 deferred for clearing).

## What this enables next

- **Pool reconciliation worker** (still open from Phase 11) — analogous
  shape to this sweeper; would post `scheme_receivable +Σ` /
  `issuer_funded_pool +Σ` against a contra account on a scan over recent
  `paycore.card_loads`.
- **Partial captures** (still open from Phase 10) — orthogonal to expiry,
  but a 0220 against a fully-captured hold should be RC 94 / 25; partial
  captures would mean the hold isn't fully resolved on the first 0220.
- **Cardholder identity surface** — once cardholders can sign in, the
  `/cards/:id` detail page can surface `expired` holds explicitly in the
  recent-activity table (it already renders them via Phase 12's pill — the
  page just needs the cardholder scoping).
- **Freeze toggle on `/cards/:id`** — write surface on the portal; this
  sweeper makes "card frozen + open holds expire safely" a coherent story.
