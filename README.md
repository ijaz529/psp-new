# psp-new

> **Strawberry** *(placeholder product name — see PROJECT_BRIEF.md §4)*
>
> A modular-monolith Payment Service Provider platform — acquiring and issuing.
> Not a live PSP: the card-scheme leg is replaced by a local scheme simulator
> that speaks ISO 8583 the way VisaNet and Banknet do. Everything else (API,
> gateway, vault, ledger, clearing, settlement, reconciliation, dispute
> handling, merchant onboarding, dashboards) is real, production-quality code.

Work lands in numbered phases, each with a plan doc and a done doc at the repo
root. The repo is at **Phase 43**; `PHASE_43_DONE.md` records what shipped last
and carries the open list.

## Quickstart

Requires Node 22+ and pnpm 10 (pinned via `packageManager`; corepack installs
it). Docker Desktop 4.30+ for the local stack.

```bash
pnpm install
cp .env.example .env
make up           # core stack (postgres, redis, app services)
# or
make up-full      # core + observability (otel-collector, jaeger, prometheus, grafana)
make migrate      # REQUIRED — `make up` does not migrate. Runs on the host.

pnpm typecheck    # 60/60
pnpm test         # 60/60 (DB-gated suites skip without DATABASE_URL)
make e2e          # health smoke + the payment canary (below)
```

Open:

- API: http://localhost:8080/v1/healthz
- Merchant + cardholder portal: http://localhost:3000
- Hosted-fields checkout demo: http://localhost:7001/demo.html
- Scheme-simulator 3DS/OTP UI: http://localhost:9002
- Grafana: http://localhost:3001 (admin / admin) · Jaeger: http://localhost:16686 · Prometheus: http://localhost:9090

## Run a payment

`make e2e` runs the Phase 0 health smoke, then the **canary**: a real payment
driven through the running stack — vault tokenization → PaymentIntent over the
real ISO 8583 wire → partial refund → clearing file → payout → scheme
settlement — asserting at the end that every currency's journal lines sum to
zero. It's the fastest proof the whole system works:

```bash
pnpm canary
```

To drive it by hand instead, open http://localhost:7001/demo.html or follow the
curl walkthrough in `PHASE_3_DONE.md`.

Test cards (verified against the running stack, 2026-08-11):

| PAN | Result |
|---|---|
| `4242 4242 4242 4242` | succeeds, no 3DS — use this one |
| `4000 0000 0000 0010` | `requires_action` → 3DS challenge; approve in the tab that opens at :9002 |
| `4111 1111 1111 1111` | **declines** |
| `5555 5555 5555 4444` | **declines** |

The last two sit inside `STRAWBERRY_BIN_RANGES`, so since Phase 9 the simulator
routes them to `apps/issuer-host` rather than its stub issuer — and they
decline unless a Strawberry card with that BIN and last4 has actually been
issued. Docs written before Phase 9 (including `PHASE_3_DONE.md`,
`PHASE_4_DONE.md`, and the card list on `/demo.html` itself) still present them
as working test cards. To spend a Strawberry card for real — issue, load, then
pay with the printed PAN — see `PHASE_9_DONE.md`.

## Operator CLIs

Run from the repo root; they talk to the host `DATABASE_URL`.

| Command | What it does |
|---|---|
| `pnpm merchant:create --name "Acme Inc."` | Merchant + `pk_test_`/`sk_test_` keys (printed once) |
| `pnpm cardholder:create` / `card:issue` / `card:load` | The issuing loop (PAN printed once at issue) |
| `pnpm ledger:balance <acct_…>` | Balance for one ledger account |
| `pnpm canary` | Full-payment canary against the running stack |
| `pnpm --filter @psp-new/worker nightly:once` | One synchronous nightly pass (clearing → payouts → settlement) |
| `pnpm --filter @psp-new/api clearing:ingest --path <file>` | Ingest + reconcile a settlement file |
| `pnpm --filter @psp-new/portal user:create` | Portal admin user |

`apps/api` also has `cardholder:set-password`, `cardholder:api-key`, and
`cardholder:webhook`.

## Repo layout

| Path | What lives here |
|---|---|
| `apps/api` | Public REST API (Fastify) — merchant + cardholder surfaces |
| `apps/vault` | Tokenization vault — only service that ever sees a raw PAN |
| `apps/acquirer-host` | ISO 8583 client to the scheme simulator |
| `apps/scheme-simulator` | ISO 8583 server, stub issuer, BIN routing, 3DS ACS |
| `apps/issuer-host` | Strawberry's own issuer — auth controls + per-card ledger |
| `apps/outbox-relay` | Drains the transactional outbox to subscribers |
| `apps/worker` | Background jobs (clearing, settlement, payouts, sweeps, webhooks) |
| `apps/portal` | Merchant/admin + cardholder portal (server-rendered from Fastify) |
| `apps/checkout` | Hosted-fields iframe origin |
| `packages/*` | 26 shared libraries — see each `package.json#description` |
| `packages/db/migrations` | Numbered SQL migrations (0001…0034) |
| `ops/compose/*` | Postgres init, Grafana/Prom/Jaeger/OTel provisioning |
| `ops/scripts/*` | Helper scripts (health smoke) |
| `tests/browser` | Playwright hosted-fields spec (opt-in; needs `PK_TEST`/`SK_TEST`) |

## Operating principles

See `PROJECT_BRIEF.md` §2. The short version:

1. Think before coding.
2. Simplicity first.
3. Surgical changes.
4. Goal-driven execution.
5. Money is integers (BIGINT minor units).
6. Every state change is an event.
7. Double-entry or it didn't happen.
8. Idempotency everywhere.

## Docs

- `PROJECT_BRIEF.md` — the original spec
- `CLAUDE.md` — working conventions (phase workflow, gates, domain rules)
- `DECISIONS.md` — ADR log (lightweight Architecture Decision Records)
- `GLOSSARY.md` — payment-domain terms used in this codebase
- `PHASE_N_PLAN.md` / `PHASE_N_DONE.md` — one pair per phase; the newest DONE
  carries the current open list

## License

UNLICENSED (private). Intent: open-source after MVP is complete.
