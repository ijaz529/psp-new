# Phase 45 — Done

**Date:** 2026-11-06 · **Status:** `README.md` is written for visitors, backed
by eight screenshots of the running stack. Plan: `PHASE_45_PLAN.md`.

## What shipped

### `README.md` — rewritten, 259 lines

Structured for someone who gives the page 30–60 seconds: title and pitch,
"What this is, and what it isn't", the dashboard as hero, "Follow one
payment" in nine linked steps, a Mermaid architecture diagram, six
screenshots, a concept→code table, how to run it, the repo tour, how it was
built, Limitations, licence.

Gone: "production-quality code", the Phase-43 staleness, the contributor
framing. Added, plainly and once each: this is a learning simulation with no
licence, membership or PCI certification; it was built with Claude Code.

### `docs/images/` — eight screenshots

Captured at 1440×900, light mode, 1×, all under 300 KB, from a stack seeded
through real HTTP surfaces. `CAPTURED.txt` records when and from which trace.

### Code fixed, because the README could not otherwise be honest

The user chose "fix both now" on the broken hosted-fields demo. Fixing it
properly turned out to need four changes, not two — the plan under-scoped it:

| # | Bug | Fix |
|---|---|---|
| 1 | The iframe's CSP set `default-src 'self'` with no `connect-src`, so its `POST /v1/tokens` was blocked. **Hosted-fields tokenization had never worked in a browser.** | `apps/checkout/src/index.ts` — CSP now names the api origin in `connect-src`. |
| 2 | `POST /v1/payment_methods` threw on the `card.token` it is designed to accept: nothing could read bin/last4/scheme back from the vault. | New `POST /internal/v1/token_metadata` (`apps/vault/src/routes/token-metadata.ts`), sender-restricted to `api`, returning no PAN and no ciphertext; `tokenMetadata()` on the vault client; the real branch in `payment-methods.ts`. |
| 3 | The demo page therefore hardcoded PAN `4111111111111111`, which has declined since Phase 9 BIN routing — so its Pay button always failed. | `demo-html.ts` now posts `{ card: { token } }` from the iframe. Its test-card list was wrong too, and now matches reality. |
| 4 | `next_action` never reached the wire: the engine set it (`orchestrator.ts:305`) but `paymentIntentToWire` dropped it, so no client could find the 3DS redirect. | `nextAction` on `PaymentIntentRecord` + `rowToRecord`, `next_action` in `PaymentIntentWire`, and the hand-rolled mapper in `payment-intents.ts`. |

Consequence: `tests/browser/hosted-fields.spec.ts` passes for the first time.
It had asserted `succeeded` with PAN 4111, which cannot succeed; it now uses
`4242 4242 4242 4242` and actually exercises the flow.

### Other approved changes

- **`LICENSE`** — MIT, copyright "Ijaz Ahamed"; `package.json#license` was
  `UNLICENSED`, now `MIT`.
- **Root CLI scripts** — `merchant:create`, `cardholder:create`, `card:issue`
  and `card:load` all ended in `--`, which reached `parseArgs({strict:true})`
  as a positional and threw `ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL`. Every
  documented invocation of them was broken. Same call fixed in `ci.yml`.
- **`ops/scripts/seed-demo.mjs`** — 3 merchants via the portal sign-up form,
  9 payments across EUR and USD including the 3DS card, a partial refund, a
  `visa_13.1` dispute, and an issued + funded card. No SQL inserts.
- **`ops/scripts/screenshots.mjs`** — Playwright capture. Signs in over HTTP
  so credentials never enter the browser; blanks the key boxes and masks the
  `client_secret` before shooting the checkout page.
- **`.gitignore`** — `apps/worker/data-exports/` (generated clearing files)
  and `test-results/` (Playwright output), both previously untracked and
  committable by accident.
- **Three vault integration tests** for `token_metadata`: happy path with
  `assertNoPan`, sender rejection, cross-merchant non-leak.

## Every feature claim, traced

Checked on 2026-11-06 against this commit. "Live" means a command I ran
against the running stack; "test" means a passing automated test.

| README claim | Traced to | How |
|---|---|---|
| Runs on a laptop; canary 11/11 | `make e2e` | live, on a fresh DB |
| Ledger balances to zero per currency | canary step 11, `packages/ledger` | live + test |
| Vault is the only service that sees a PAN | `migration 0011` | live: `app_user` → `vault.card_tokens` = `permission denied for schema vault`; `vault_user` → `paycore.payment_intents` likewise |
| Hosted fields: merchant page never holds the PAN | `apps/checkout`, `tests/browser/hosted-fields.spec.ts` | test, now passing |
| 3DS challenge, BIN 400000 | `packages/payment-engine/src/three-ds.ts:36`, `apps/scheme-simulator/src/three-ds.ts` | live: `requires_action` + `next_action.redirect_url`, approved via the ACS page → `succeeded` |
| ISO 8583 codec written from scratch, 4-byte ASCII framing | `packages/iso8583`, `apps/scheme-simulator/src/framing.ts` | test |
| Auth `0100`/`0200` over TCP | `apps/acquirer-host/src/authorize.ts:70` | live: canary asserts non-NULL `last_auth_rrn`/`last_auth_stan` |
| Capture `0220`, reversal `0420` | `apps/acquirer-host/src/advice.ts:43,47` | code: `/internal/v1/capture`, `/internal/v1/reverse`; `cancelPaymentIntent` sends `0420` |
| BIN routing to our own issuer | `apps/scheme-simulator/src/issuer.ts`, `STRAWBERRY_BIN_RANGES` | live: 4111/5555 decline with DE 39 code 14 |
| Spending controls against a per-card ledger | `packages/issuing/src/controls.ts` | test + live: card detail shows 250.00 USD and a load with RC 00 |
| Clearing files per scheme and currency | `packages/clearing-files`, `clearing-job.ts` | live: one clean nightly run emitted `visa_eur_…b2` (5 records) and `visa_usd_…b2` (4), DB rows matching disk |
| Base II and IPM shapes | `base2.ts`, `ipm.ts` | test: round-trip specs for both |
| Clearing carries the real RRN | canary step 8 | live: `RRN 631002000047 in visa_usd_20261106.b2` |
| Clearing files carry no PAN | — | live: `grep -oE '[0-9]{13,19}'` over a `.b2` returns only amounts, dates and the RRN |
| Settlement drains the scheme receivable | `scheme-settlement-job.ts` | live: canary step 10 |
| Payout equals what the books owe | `packages/payouts` | live: canary asserts exactly 7275 |
| Webhooks signed, retried, dead-lettered | `packages/webhook-delivery` (`RETRY_DELAYS_MS`), `apps/outbox-relay` | test |
| Dispute lifecycle + Visa reason codes | `packages/disputes` | test + live: `visa_13.1` → `first_chargeback` |
| Idempotency on money-moving endpoints | `packages/idempotency` | code: only `/v1/tokens`, the 3DS callback and one webhook-endpoint route opt out |
| Tracing across services | `packages/otel` | live: a single trace spans api, vault, acquirer-host and scheme-simulator (7 spans) |
| Test-card table | — | live: all four re-run, results as documented |
| 26 libraries, 34 migrations, 35 workspace packages, 60 tasks | — | live: counted |
| 46 phases, 88 documents | — | live: counted after this doc |

## Verify

| Check | Result |
|---|---|
| `pnpm exec biome check` on changed files | clean (15 files) |
| `pnpm typecheck` | 60/60 |
| `pnpm test` | 60/60 |
| `make reset-db && make migrate && make e2e` | canary **11/11** on a fresh DB |
| `pnpm test:browser` | 1 passed — green for the first time |
| Relative links + image paths in `README.md` | 63 checked, 0 missing |
| Mermaid block | parsed and rendered with mermaid 11.4.1 — valid, 29 nodes |
| Screenshots scanned for secrets | 8 images, byte-scan clean, each one also read visually |
| README length | 259 lines |

## Things found but deliberately not fixed

- **Nightly clearing is not safe to run twice in one day.** One `try/catch`
  wraps the whole batch in `clearing-job.ts`, so the first duplicate-key
  abort kills every remaining file. Observed: a second same-day run rewrote
  `visa_usd_…b2` on disk with 5 records while its `clearing_files` row still
  said 1, inserted no new `clearing_records`, and never emitted the EUR file
  at all. Disk and DB disagree afterwards. In Limitations; worth its own
  phase.
- **`CLAUDE.md` names the admin cookie `strawberry_session`.** It is
  `strawberry_portal_session` (`packages/portal-auth/src/index.ts:44`).
  `CLAUDE.md` also says 35 source-only packages and 10 apps; it is 26 and 9.
  Left alone — the plan said `CLAUDE.md` is untouched this phase.
- **`card:load` CLI writes no `card_loads` row**, unlike
  `POST /v1/cards/:id/load`, so the portal's "Recent loads" stays empty after
  using it. The seed script uses the API route instead.
- **`.card { overflow-x: auto }` was not needed.** At 1440×900 the container
  caps at 1120px and no table overflowed. Left unchanged.
- `packages/risk-rules`, `ledger.reconcile()` and the `AwsKmsProvider` stub
  are still unused.

## Still open

- Clearing-job same-day re-run (above) — the one real bug this phase found
  and did not fix.
- Nothing is pushed. Three commits sit on `main` locally.
- `PORTAL_DEMO_PASSWORD` was echoed into this session's terminal by pnpm's
  command echo when recreating the portal user. Rotate it: pick a new value
  in `.env`, then re-run `pnpm --filter @psp-new/portal user:create`.

## Open list (carried)

- Map Fastify's empty-JSON-body error to 400 (Phase 41 finding).
- Vault-in-harness for tokens/payment-method/3DS test breadth.
- CI job that runs `make e2e` against compose.
- Payouts: `listPayoutCandidates` windows on PI `created_at`; reserves;
  `merchants.payout_schedule` ignored (Phase 43).
- Portal detail pages for payouts and disputes; dispute actions.
