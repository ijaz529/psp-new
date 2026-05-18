# psp-new

> **Strawberry** *(placeholder product name — see PROJECT_BRIEF.md §4)*
>
> A modular-monolith Payment Service Provider platform — acquiring side first,
> issuing side later. Not a live PSP: the card-scheme leg is replaced by a local
> scheme simulator that speaks ISO 8583 the way VisaNet and Banknet do.
> Everything else (API, gateway, vault, ledger, clearing, settlement, reconciliation,
> dispute handling, merchant onboarding, dashboards) is real, production-quality code.

This repo is currently at **Phase 0 — Foundations**. See `PHASE_0_DONE.md` for what
landed and `PHASE_1_PLAN.md` for what's next.

## Quickstart

Requires Node 22+ and pnpm 9+. Docker Desktop 4.30+ for the local stack.

```bash
pnpm install
cp .env.example .env
make up           # core stack only (postgres, redis, app services)
# or
make up-full      # core + observability (otel-collector, jaeger, prometheus, grafana)

pnpm typecheck
pnpm test
make e2e          # full-stack smoke
```

Open:

- API: http://localhost:8080/v1/healthz
- Grafana: http://localhost:3001 (admin / admin)
- Jaeger: http://localhost:16686
- Prometheus: http://localhost:9090
- Scheme-simulator OTP UI: http://localhost:9002

## Repo layout

| Path | What lives here |
|---|---|
| `apps/api` | Public REST API (Fastify) |
| `apps/vault` | Tokenization vault — only service that ever sees a raw PAN |
| `apps/acquirer-host` | ISO 8583 client to the scheme simulator |
| `apps/scheme-simulator` | ISO 8583 server + simulated issuer + clearing/settlement files |
| `apps/outbox-relay` | Drains the transactional outbox to subscribers |
| `apps/worker` | BullMQ background jobs (clearing/settlement/payouts/webhooks) |
| `apps/portal` | Merchant portal (Next.js) |
| `apps/checkout` | Hosted-fields iframe origin |
| `packages/*` | Shared libraries — see each `package.json#description` |
| `ops/compose/*` | Postgres init, Grafana/Prom/Jaeger/OTel provisioning |
| `ops/scripts/*` | Helper scripts |

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
- `DECISIONS.md` — ADR log (lightweight Architecture Decision Records)
- `GLOSSARY.md` — payment-domain terms used in this codebase
- `PHASE_0_DONE.md` — what landed in Phase 0
- `PHASE_1_PLAN.md` — what we're building next

## License

UNLICENSED (private). Intent: open-source after MVP is complete.
