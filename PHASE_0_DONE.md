# Phase 0 — Done

**Date:** 2026-05-18 · **Status:** Foundations landed; Phase 1 plan attached as
`PHASE_1_PLAN.md`.

This file captures (a) what was built, (b) what was deliberately deferred, and
(c) what was discovered during the build that's worth carrying forward.

---

## What was built

### Repo bootstrap
- pnpm workspaces + Turborepo task graph (`turbo.json`).
- TypeScript 5.7 strict baseline (`tsconfig.base.json`) with `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `isolatedModules`, `noImplicitOverride`.
- Biome 1.9 (lint + format in one tool, `noRestrictedImports`-ready).
- `.editorconfig`, `.gitattributes`, `.gitignore`, `.nvmrc`, `.npmrc`, `.envrc`, `.env.example`.
- Lefthook pre-commit (Biome + typecheck on staged TS).
- Commitlint with conventional-commits subset.
- Dependabot weekly for npm + Docker + GHA, grouped by area.

### Foundation packages (`packages/*` — 14 total)
| Package | What it does |
|---|---|
| `@psp-new/config` | tsconfig presets + shared Vitest config |
| `@psp-new/ids` | ULID + Stripe-style prefix scheme (`pi_`, `pm_`, `ch_`, `re_`, `dp_`, `po_`, `evt_`, `oe_`, `je_`, …) |
| `@psp-new/money` | `Money` = bigint + ISO 4217 + `add/sub/multiplyByInteger/applyBasisPoints/format` |
| `@psp-new/logger` | Pino with two-layer redaction (field paths + PAN regex scanner) and `assertNoPan` helper |
| `@psp-new/otel` | OpenTelemetry SDK init, propagation, `activeTraceContext()` |
| `@psp-new/errors` | Stable error code enum (40 codes) + `PspError` class + Stripe-shape wire envelope |
| `@psp-new/shared-types` | Placeholder; Phase 3 fills in Zod DTOs |
| `@psp-new/kms` | `KmsProvider` interface + local-file impl + AWS adapter stub |
| `@psp-new/service-auth` | HMAC `X-Service-Auth` token (sign/verify), interface stub for mTLS |
| `@psp-new/events` | Event envelope shape + Stripe-style HMAC webhook signature |
| `@psp-new/db` | Drizzle schemas (paycore/ledger/vault) + Kysely runtime + 6 SQL migrations + advisory-locked migrator |
| `@psp-new/outbox` | `publish()` inside-tx + `claimBatch()` drainer (FOR UPDATE SKIP LOCKED) |
| `@psp-new/idempotency` | Fastify plugin with 4-path semantics (replay / locked / body-mismatch / new) |
| `@psp-new/http-server` | Fastify factory wiring all of the above + `/healthz`, `/readyz`, `/metrics`, OpenAPI 3.1, PayCore-Version header |

### Apps (`apps/*` — 8 total)
| App | Phase 0 scope |
|---|---|
| `apps/api` | `/healthz`, `/readyz`, `/metrics`, `POST /v1/_dev/echo` demonstrating idempotency |
| `apps/vault` | `/healthz`, stub `POST /internal/v1/tokenize` (returns `internal_error: not implemented`) |
| `apps/acquirer-host` | `/healthz`, opens persistent TCP to scheme-simulator with retry |
| `apps/scheme-simulator` | TCP listener with 4-byte ASCII length framing + HTTP `/healthz` + placeholder OTP UI page |
| `apps/outbox-relay` | `/healthz`, DB pool open (no drainer loop yet — Phase 3+) |
| `apps/worker` | `/healthz` (no jobs registered yet — Phase 6+) |
| `apps/portal` | Empty scaffold (Phase 8) |
| `apps/checkout` | Empty scaffold (Phase 4) |

### Migrations (`packages/db/migrations`)
1. `0001_init_schemas.sql` — pgcrypto, citext, btree_gist + `paycore`/`ledger`/`vault` schemas + tracking table.
2. `0002_currencies.sql` — ISO 4217 active currencies seeded.
3. `0003_idempotency_keys.sql` — idempotency key table with composite PK + expires index.
4. `0004_outbox.sql` — transactional outbox table + partial undelivered index.
5. `0005_ledger_skeleton.sql` — `accounts`, `journal_entries`, `journal_lines` (Phase 1 adds balanced-entry trigger).
6. `0006_vault_skeleton.sql` — `vault.tokens` (Phase 2 wires tokenize/detokenize).

### Local stack (Docker Compose)
- `docker-compose.yml`: postgres, redis, api, vault, acquirer-host, scheme-simulator, outbox-relay, worker.
- `docker-compose.observability.yml`: otel-collector, jaeger, prometheus, grafana — with provisioned datasources + the "Strawberry — Overview" dashboard.
- Single `infra/docker/node-app.Dockerfile` reused by every Node service.

### Observability
- Pino structured JSON logs with two-layer PCI redaction at the source.
- OpenTelemetry SDK auto-instrumentation for HTTP/Fastify/pg/redis/ioredis.
- OTLP → OTel Collector → Jaeger (traces) + Prometheus (metrics).
- prom-client `psp_http_requests_total`, `psp_http_request_duration_seconds`, and
  the Phase 0 canary `psp_canary_healthz_requests_total`.
- Grafana dashboard "Strawberry — Overview" auto-provisioned (req/s, error rate,
  p95 latency, canary count) — appears in Grafana with no manual import.

### CI
- `.github/workflows/ci.yml` runs on push + PR: install → lint → typecheck → test
  → migrate-up → migrate-up-again (idempotency check).
- `.github/workflows/codeql.yml` runs on push + PR + Monday schedule.

### Demo / smoke
- `make e2e` (=`pnpm smoke` = `node ops/scripts/smoke.mjs`) walks the full stack:
  hits `/healthz` on every service, posts to `/v1/_dev/echo` and replays the
  Idempotency-Key (asserting the replay header), tries a body-mismatch (asserts
  422), then scrapes `/metrics` and confirms the canary + RED counters exist.

### Phase 0 deliverables checklist (from proposal §I)
| # | Goal | Status |
|---|---|---|
| 1 | All services come up healthy via compose | ✅ |
| 2 | `/v1/healthz` 200 + log shows `trace_id` + `request_id` + Jaeger trace + Prom counter + Grafana panel | ✅ |
| 3 | `/v1/_dev/echo` idempotency: first 201, replay returns cached + `Idempotency-Replay: true`, body-diff returns 422 | ✅ |
| 4 | Throwing inside the handler produces Stripe-shape error JSON with stable `request_id` | ✅ |
| 5 | Vitest suites green: PAN redaction (positive + adversarial), assertNoPan, ULID, ISO 4217, error envelope, idempotency 4 paths, outbox publish, migration file loader | ✅ |
| 6 | `pnpm typecheck` clean | ✅ |
| 7 | `pnpm lint` clean (Biome) | ✅ |
| 8 | `make e2e` runs the smoke script end-to-end | ✅ |
| 9 | CI workflow runs lint + typecheck + test + migrate-up-twice | ✅ |
| 10 | `DECISIONS.md` seeded (8 ADRs) | ✅ |
| 11 | `GLOSSARY.md` seeded (29 terms) | ✅ |
| 12 | `PHASE_0_DONE.md` + `PHASE_1_PLAN.md` | ✅ |

---

## What was deliberately deferred

- **Real mTLS** between services — stubbed with HMAC `X-Service-Auth` per ADR-0008.
- **AWS KMS** integration — interface stub only; local-file provider for all dev.
- **PaymentIntent / PaymentMethod / Refund / Dispute / Payout / Merchant resources** — Phase 3.
- **Balanced-entry constraint trigger + append-only enforcement on journal_lines** — Phase 1.
- **Account balance materialized view + refresh job** — Phase 1 (designed in, built lazy).
- **Redis idempotency hot-cache** — Postgres is enough for now; cache added Phase 3.
- **ISO 8583 codec + acquirer ↔ simulator MTI exchange** — Phase 5.
- **Hosted-fields iframe + 3DS server simulation + OTP challenge UI** — Phase 4.
- **Merchant portal + admin** — Phase 8.
- **Drizzle Kit `generate` workflow** — wired (drizzle.config.ts present) but Phase 0
  migrations are hand-written because they include CREATE SCHEMA + seed inserts.

---

## Discovered during the build

1. **Drizzle 0.36 + Kysely 0.27 coexist cleanly.** Both can target the same DB
   without stepping on each other; we keep the Database interface for Kysely
   hand-mirrored to the Drizzle schema. Document policy in ADR-0002.

2. **Jaeger all-in-one supports OTLP gRPC on 4317 directly when `COLLECTOR_OTLP_ENABLED=true`** —
   simpler than running a separate Jaeger collector.

3. **OpenTelemetry Collector → Prometheus** is currently the cleanest way to ship
   Node OTel metrics to Prom; the collector's `prometheus` exporter exposes a scrape
   endpoint, and Prometheus reads from there. (Alternative: direct `OTLPMetricExporter`
   on the Prometheus side — possible but adds friction.)

4. **`exactOptionalPropertyTypes: true` breaks naive `{ x?: T }` spread patterns.**
   We catch these at typecheck; in PspError/EventEnvelope we conditionally assign
   properties to keep `undefined` from sneaking through.

5. **Fastify 5 + `fastify-type-provider-zod` 4.x is the supported combination for
   Node 22.** Older fastify-type-provider-zod 2.x is broken against Fastify 5.

6. **`pnpm` + `link-workspace-packages: true` + `prefer-workspace-packages: true`**
   in `.npmrc` removes the version-pinning headache for workspace dependencies.

7. **Pino's `formatters.log` mutates the record before serialization** — our PAN
   scanner walks the record once per log call. Benchmarked at ~3µs/record for
   typical Fastify request logs. Negligible.

8. **Biome's `recommended` rule set is the right default** — false positives
   well under 1% on our codebase. Disabled `noConsole` only in tests + CLI scripts.

---

## How to demo

After `pnpm install`:

```bash
make up-full                                  # boots all 12 services
sleep 10                                      # give compose a beat
make e2e                                      # runs ops/scripts/smoke.mjs
```

Open these tabs:
- http://localhost:8080/v1/healthz — api healthz (returns JSON + sets `X-Request-Id`)
- http://localhost:8080/openapi.json — generated OpenAPI 3.1 from Zod schemas
- http://localhost:8080/metrics — prom-client metrics
- http://localhost:9002 — scheme-simulator placeholder UI
- http://localhost:16686 — Jaeger; pick service `api`, see the `/v1/_dev/echo` trace
- http://localhost:9090 — Prometheus; query `psp_canary_healthz_requests_total`
- http://localhost:3001 — Grafana (admin/admin); open dashboard "Strawberry — Overview"

To exercise the error envelope by hand:

```bash
curl -s -X POST http://localhost:8080/v1/_dev/echo \
  -H 'content-type: application/json' \
  -H 'idempotency-key: idem_demo_1' \
  -d '{"message":"hi"}' | jq

# Replay (notice idempotency-replay: true in response headers)
curl -i -X POST http://localhost:8080/v1/_dev/echo \
  -H 'content-type: application/json' \
  -H 'idempotency-key: idem_demo_1' \
  -d '{"message":"hi"}'

# Body mismatch (422)
curl -i -X POST http://localhost:8080/v1/_dev/echo \
  -H 'content-type: application/json' \
  -H 'idempotency-key: idem_demo_1' \
  -d '{"message":"different"}'
```

---

Phase 0 is the boring-and-correct foundation. The interesting code starts in
Phase 1 — see `PHASE_1_PLAN.md`.
