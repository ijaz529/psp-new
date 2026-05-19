# psp-new — Claude project guide

Educational PSP (payment service provider) monorepo. TypeScript strict,
Postgres + Kysely + Drizzle, Fastify, BullMQ, scrypt password hashing,
ISO 8583 over TCP. 60 packages.

## Phase workflow (mandatory)

Each shipping unit is a **Phase N**. The pattern is rigid:

1. Write `PHASE_N_PLAN.md` at the repo root. Commit as `docs: phase N <title>`.
2. Implement. Commit as `feat(phase-N): <imperative summary>`.
3. Write `PHASE_N_DONE.md`. Commit as `docs: phase N done`.

Plans state goal, scope, out-of-scope, files touched, verify steps.
DONEs state what shipped, simplifications vs real life, what's
unblocked next.

Phases land in order. Never skip the docs commits.

## Gates (must pass before each commit)

- `pnpm typecheck` → `Tasks: 60 successful, 60 total`
- `pnpm test` → `Tasks: 60 successful, 60 total`

Lefthook runs `biome-check`, `commitlint`, `typecheck-changed` on
every commit. If biome fails: `pnpm exec biome check --write <files>`
then retry the commit. Don't bypass hooks.

Commit subjects must be lowercase (commitlint enforces). `feat(phase-N):
…` not `feat(Phase-N): …`.

## Repo shape

- `packages/` — 35 source-only packages (db, ledger, payment-engine,
  ids, errors, money, events, outbox, webhook-delivery, etc.)
- `apps/` — 10 apps (api, portal, worker, acquirer-host, vault,
  outbox-relay, scheme-simulator, checkout, issuer-host)
- `packages/db/migrations/` — numbered SQL (0001…). Phase N typically
  adds 0028 / 0029 / 0030 etc.
- `packages/db/src/kysely.ts` — hand-written Database interface;
  mirror Drizzle schema changes here in the same PR.

## ID + accounting conventions

- ULID-based ids with Stripe-style prefixes (`pi_`, `card_`, `cl_`,
  `ch_`, `csk_`, `chak_`, …). Defined in `packages/ids/src/index.ts`
  — add new kinds there rather than ad-hoc `replace('oe_', 'foo_')`.
- Double-entry ledger sign convention: **positive posting = balance
  goes up, regardless of account TYPE label**. Don't get fancy with
  debit/credit flips.
- `postJournal(trx, {externalId, …, postings})` is idempotent on
  externalId — unique-violation = "already posted today", swallow it.
- `pspAccount(code, currency)` and `schemeAccount(code, currency, scheme)`
  are deterministic; use these instead of inline lookups.

## Auth surfaces

- Merchant: `sk_test_…` / `pk_test_…` via `apiKeyAuthPlugin`. Routes
  set `config.requireApiKeyKind: 'secret'|'publishable'`.
- Cardholder REST: `csk_test_…` via `cardholderAuthPlugin`. Routes
  set `config: { skipApiKey: true, requireCardholderKey: true }`.
  Cardholder routes MUST filter on `cardholder_id = req.cardholderId`.
- Portal (admin): cookie `strawberry_session`, helpers in
  `@psp-new/portal-auth`.
- Cardholder portal: cookie `strawberry_cardholder_session` (distinct,
  30-day TTL), helpers also in `@psp-new/portal-auth`. preHandler
  branches on URL prefix `/cardholder/*`.

## Eventing

- `paycore.events` and `paycore.webhook_endpoints` are polymorphic —
  each row carries exactly one of `merchant_id` / `cardholder_id`
  (XOR check constraint). Phase 26 made this so.
- Merchant emission: `emitAndPublishEvent` in
  `packages/payment-engine/src/orchestrator.ts` (private).
- Cardholder emission: `publishCardholderEvent(trx, …)` in
  `@psp-new/outbox`.
- Outbox drainer (`apps/outbox-relay/src/drainer.ts`) reads
  `headers.merchant_id` or `headers.cardholder_id`, fans out to
  matching enabled endpoints.

## Testing

- Most package tests are pure unit. Integration tests gate on
  `HAS_DB = !!process.env.DATABASE_URL` and `describe.skipIf(!HAS_DB)`.
- API integration tests use `createApiTestHarness()` in
  `apps/api/src/__tests__/helpers.ts` — boots real Fastify via
  `buildApi()` with stub authorizer/settler/reverser. Use
  `app.inject({ method, url, headers, payload })` to fire requests.
- Worker job tests boot a real DB via `migrateUp` and assert ledger
  balances move as expected. Pattern: see
  `apps/worker/src/clearing-adjustments-sweep-job.test.ts`.

## Surgical-change discipline

The parent CLAUDE.md applies (Karpathy-inspired). Reinforced here:

- Don't extend merchant code to handle cardholders by adding nullable
  `merchant_id`. Add a parallel cardholder table.
- When you find an unused export biome flags, delete it — don't
  prefix-with-underscore to silence.
- Don't add tests, OpenAPI specs, or comments for code that doesn't
  exist yet. Phase scope is sacred.
- Time-of-day in scheme files: Base II truncates to date, IPM
  preserves via DE 12. Real Base II doesn't carry time. Don't
  pretend otherwise.

## Things that have bitten past sessions

- Biome auto-rewrites multi-line `if/throw` constructs — fix with
  `pnpm exec biome check --write <file>`, retry commit. Don't fight
  it.
- Adding a workspace dep requires `pnpm install` from the repo root
  (or from the dep'd package), then re-typecheck.
- Kysely `InsertExpression` strict typing means adding a NOT NULL
  column with a default still requires explicit `column: 0n` in test
  fixtures.
- `paycore.events.merchant_id` was NOT NULL before Phase 26 — that
  constraint blocked cardholder events for many phases. If you find
  yourself wanting nullable FK on a single "either-or" column, look
  for the XOR check pattern Phase 26 used.
- `apps/api` had no test scaffolding before Phase 31. The harness
  exists now — use it.

## Phase log (most recent → oldest, abbreviated)

- 31 — apps/api test scaffolding + cardholder REST tests
- 30 — cardholder REST API (`/v1/cardholder/*` + `csk_` keys)
- 29 — Mastercard IPM ISO 8583-shaped format
- 28 — Visa Base II fixed-width binary format
- 27 — cardholder portal `/webhooks` UI
- 26 — cardholder webhook delivery (polymorphic events/endpoints)
- 25 — card-load chargeback / refund
- 24 — auto-sweep clearing_adjustments to revenue
- 23 — per-card stored_value liability accounts
- 22 — cardholder identity (signin + sessions)
- 21 — opt-in clearing adjustments
- 20 — settlement file ingestion
- 19 — camelCase card_products defaults
- 18 — card freeze + controls editor
- 17 — per-card acquiring leg sweeper
- 16 — partial captures (captured_amount)
- 15 — scheme settlement worker
- 14 — pool reconciliation worker
- 13 — auth-hold expiry sweeper
- 12 — admin cards page
- 11 — POST /v1/cards/:id/load
- 10 — 0220 capture + 0420 reversal clients
- (1–9) earlier infra: vault, ledger, PI state machine, webhooks v1,
  acquirer-host, KYB, portal sign-in, issuing primitives.

When picking the next phase, the open list lives at the bottom of the
most recent `PHASE_*_DONE.md`. Don't invent — use what's there.
