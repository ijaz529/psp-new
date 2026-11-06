# Phase 45 — Plan: README for visitors, with real screenshots

**Date:** 2026-11-06 · **Status:** approved. Q1–Q4 answered below.

## Goal

Rewrite `README.md` for a recruiter or hiring manager who gives the
page 30–60 seconds, and back it with screenshots captured from the
running stack. In that window the page must answer three things:

1. what this is,
2. that it really runs,
3. which payments concepts it covers.

An engineer who scrolls past that should find how it's built and how to
run it.

## In scope beyond the docs (answers to Q3, Q4, Q1)

- **Q3 → fix both.** Serialize `next_action` in
  `apps/api/src/lib/wire.ts`; make the demo page pay with the PAN typed
  in the iframe instead of its hardcoded one. Revives
  `tests/browser/hosted-fields.spec.ts`.
- **Q4 → fix the scripts.** Drop the trailing `--` from the four root
  `package.json` CLI scripts and from the `ci.yml` call.
- **Q1 → MIT.** Add `LICENSE`, and point `package.json#license` at it.

## Non-goals (out of scope)

- No new product features, routes, migrations or dependencies.
- No rewrite of `PROJECT_BRIEF.md`, `DECISIONS.md`, `GLOSSARY.md` or
  any earlier `PHASE_*.md`.
- **Q2 → leave them.** The 86 `PHASE_*.md` files stay at the repo root;
  `CLAUDE.md`'s workflow paths are untouched.
- No push, no `gh repo edit`, no touching the open dependabot PRs.
- No fix for the other known gaps (wire-level refund reversals,
  `payout_schedule`, `risk-rules` wiring, portal detail pages). They
  are Limitations entries, not work.

## Honesty rules this phase holds itself to

- Every feature claim traces to a file, a passing test, or a command I
  ran on 2026-11-06. The trace table goes in `PHASE_45_DONE.md`.
- Said plainly near the top: learning simulation, no real money, no
  scheme membership, no licence, no PCI certification.
- Said plainly, once, not as the headline: built with Claude Code.
- No "production-grade", "enterprise-ready", or the current README's
  "production-quality code".
- Partial features go under Limitations or stay out entirely.
- "Strawberry" stays the in-app name; the README leads with
  "psp-new: Payment Service Provider Simulator".

## What I verified before writing a word

Stack: `make up-full`, then `set -a; source .env; set +a; make migrate`.
All 15 containers healthy.

| Claim | How it was checked | Result |
|---|---|---|
| `pnpm typecheck` | ran | 60/60 |
| `pnpm test` | ran | 60/60 |
| `make e2e` | ran | smoke + canary **11/11** |
| Vault DB isolation is real | `app_user` → `vault.card_tokens`; `vault_user` → `paycore.payment_intents` | both `permission denied for schema` |
| `4242 4242 4242 4242` | live `POST /v1/payment_intents` | `succeeded` |
| `4000 0000 0000 0010` | same | `requires_action` |
| `4111 1111 1111 1111` | same | `failed`, decline code 14 |
| `5555 5555 5555 4444` | same | `failed`, decline code 14 |
| Clearing file carries the real DE 37 RRN | canary step 8 | `RRN 631001000001 in visa_usd_20261106.b2` |
| Clearing files carry no PAN | `grep -oE '[0-9]{13,19}'` over the `.b2` | only amounts/dates/RRN |
| Payout equals the settlement liability | canary step 9 | `7275` |
| Ledger sums to zero per currency | canary step 11 | USD, EUR both 0 |
| Distributed tracing works | Jaeger `/api/services` | api, acquirer-host, vault, portal, issuer-host, outbox-relay |
| One auth spans 3 services | Jaeger trace query | 5 spans across api → vault → acquirer-host |

### Three findings that change what the README may claim

1. **The hosted-fields demo page cannot complete a payment.**
   `apps/checkout/src/demo-html.ts:139` hardcodes PAN
   `4111111111111111` and ignores whatever is typed in the iframe.
   Since Phase 9 that BIN routes to `issuer-host`, which declines it.
   The iframe mount and tokenization are real; the Pay button ends in
   `card_declined`.
2. **`next_action` never reaches the wire.** The engine sets it
   (`orchestrator.ts:305`) but `paymentIntentToWire`
   (`apps/api/src/lib/wire.ts`) omits the field, so the demo page's
   `pi.next_action.redirect_url` check at `demo-html.ts:161` can never
   fire and the 3DS tab never opens by itself. The challenge page is
   reachable from `paycore.three_ds_sessions.redirect_url`.
   Consequence: `tests/browser/hosted-fields.spec.ts` asserts
   `succeeded` with PAN 4111 and would fail today. It is opt-in
   (`PK_TEST`/`SK_TEST`), so it has likely not run since Phase 9.
3. **`pnpm merchant:create --name "X"` fails.** The root script ends in
   `--`, so `tsx` gets a positional `--` and `parseArgs({strict:true})`
   throws `ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL`. Working form:
   `pnpm --filter @psp-new/api merchant:create --name "X"`. The same
   broken form sits in `.github/workflows/ci.yml` (browser-tests job)
   and in the current README. Same bug class for `cardholder:create`,
   `card:issue`, `card:load`.

## README structure

Target: under 250 lines, links out for depth.

1. **Title + one-sentence pitch.**
2. **What this is and isn't** — 4 lines: simulation, no money/licence/PCI,
   built with Claude Code, what is nonetheless real.
3. **Hero screenshot** — portal dashboard.
4. **Follow one payment** — 7 numbered plain-language steps, each
   linking the app or package that does it: hosted-fields/vault
   tokenization → PaymentIntent + 3DS decision → ISO 8583 auth through
   acquirer-host → scheme simulator BIN routing → issuer decision →
   capture + refund → nightly clearing file (Base II / IPM) → scheme
   settlement → merchant payout → ledger sums to zero.
5. **Architecture** — one Mermaid `flowchart` of the compose services
   and the path a payment takes. GitHub renders it.
6. **Screenshots** — 4–6 images, one-line caption each.
7. **What it covers** — table: concept → where it lives in the code.
   Rows: acquiring, issuing, double-entry ledger, clearing files,
   settlement, reconciliation, payouts, 3DS simulation, webhooks,
   dispute lifecycle, tokenization/PCI isolation, idempotency.
8. **Run it locally** — prerequisites, the commands that actually work
   (including the `set -a; source .env` step `make migrate` needs), the
   re-verified test-card table, the canary output as a fenced code
   block.
9. **Repo tour** + **How it was built** — the phase workflow, 45 phases,
   86 plan/done docs, linked.
10. **Limitations** — the honest list (below).
11. **Licence** — pending Q1.

### Limitations the README will state

- Scheme leg is a local simulator; no Visa/Mastercard connectivity.
- No licence, no scheme membership, no sponsor bank, no PCI
  certification. Not for real money.
- Refunds post to the ledger only — no 0400 reversal over the wire.
  MTI 0400/0410 and 0800/0810 exist as type-union entries only.
- `packages/risk-rules` is written and unit-tested but wired into
  nothing — no risk decision is recorded on an auth today.
- `merchants.payout_schedule` is ignored; payouts run daily. No
  reserves. `listPayoutCandidates` windows on PI `created_at`, so a
  dormant merchant with residual liability is not picked up.
- No portal detail pages for payouts or disputes; no dispute actions in
  the portal.
- CI runs lint, typecheck, tests and the migrations; it does not run
  `make e2e` against compose. Browser tests are opt-in.
- Dev-only security posture: open CORS, `frame-ancestors *`,
  unauthenticated 3DS callback, committed dev KMS key.
- Scheme simulator is not OTel-instrumented, so a payment trace stops
  at `acquirer-host`.

## Screenshots

Seeded through the real API, never SQL inserts:

- 3 merchants with plain names via `POST /sign-up` on the portal.
- 8–10 payments across EUR and USD, including the 3DS card.
- 1 refund, 1 dispute (`POST /v1/disputes`, `visa_13.1`).
- `pnpm --filter @psp-new/worker nightly:once` for clearing,
  settlement and payouts.

Capture with Playwright (already a dev dependency) in
`ops/scripts/screenshots.ts`, 1440×900, light mode, cropped to content.
PNGs to `docs/images/`, under ~300 KB each.

Candidates: portal dashboard (hero), payouts list, disputes list, card
detail, hosted-fields checkout form, 3DS challenge page, Jaeger trace.
The canary goes in as a code block, not an image.

Before committing: every PNG checked for API keys, passwords, cookies
and session tokens. Portal demo credentials are never printed,
committed or shown.

The portal container needs `docker compose restart portal` after a host
edit — `tsx watch` misses them on macOS.

## Files touched

| File | Change |
|---|---|
| `PHASE_45_PLAN.md` | this doc (commit 1) |
| `README.md` | full rewrite (commit 2) |
| `docs/images/*.png` | new screenshots (commit 2) |
| `ops/scripts/screenshots.ts` | new capture script (commit 2) |
| `apps/portal/src/dashboard-views.ts` | `.card { overflow-x: auto }` — **only if** a 1440×900 capture actually shows a table overflowing its card (commit 2) |
| `apps/api/src/lib/wire.ts` | serialize `next_action` (commit 2) |
| `apps/checkout/src/demo-html.ts` | pay with the PAN typed in the iframe (commit 2) |
| `package.json` | drop the trailing `--` from 4 CLI scripts; `license: MIT` (commit 2) |
| `.github/workflows/ci.yml` | same `merchant:create` fix (commit 2) |
| `LICENSE` | new, MIT (commit 2) |
| `.gitignore` | ignore `apps/worker/data-exports/` (commit 2) |
| `PHASE_45_DONE.md` | claim-to-code trace table (commit 3) |

## Verify steps

| # | Step | Pass condition |
|---|---|---|
| 1 | `pnpm exec biome check` on changed files | clean |
| 2 | `pnpm typecheck` | 60/60 |
| 3 | `pnpm test` | 60/60 |
| 4 | `make reset-db && make migrate && make e2e` | canary 11/11 on a fresh DB |
| 5 | Every relative link and image path in `README.md` resolves | script walks the links, 0 misses |
| 6 | Mermaid block parses | `@mermaid-js/mermaid-cli` via `pnpm dlx`, or manual GitHub preview |
| 7 | Every PNG scanned for secrets | `strings`/visual check, 0 hits |
| 8 | README line count | ≤ 250 |
| 9 | Every feature claim has a trace row | `PHASE_45_DONE.md` table complete |
| 10 | Three commits exist locally, unpushed | `git log --oneline -3` |

## Decisions (questions answered 2026-11-06)

| # | Question | Answer |
|---|---|---|
| Q1 | Licence | **MIT.** `LICENSE` added this phase. Copyright holder taken as "Ijaz Ahamed" — say the word if that should read differently. |
| Q2 | Move `PHASE_*.md` to `docs/phases/` | **No.** They stay at the root; `CLAUDE.md` is untouched. |
| Q3 | Broken hosted-fields demo | **Fix both.** Serialize `next_action`; pay with the PAN typed in the iframe. |
| Q4 | Broken `merchant:create` et al. | **Fix the scripts** and the `ci.yml` call. |
| Q5 | `risk-rules` | Limitations entry: written, unit-tested, wired into nothing. |
| Q6 | `apps/worker/data-exports/` | Add to `.gitignore`. |
| Q7 | Jaeger screenshot | Include, captioned that the trace stops at `acquirer-host` because the simulator is not instrumented. |
| Q8 | Dashboard shows merchant ULIDs | Leave it. A merchants-page screenshot carries the plain names. |
