# Phase 13 — Auth-expiry sweeper (Plan)

**Status:** Proposed for review · **Predecessor:** Phase 12 (`PHASE_12_DONE.md`).

Real PSPs let card authorizations expire if they're never captured. Visa/MC
operating rules give merchants ~7 days before the issuer must release the
hold. Without this sweeper, a Strawberry-issued card whose hold is never
captured stays encumbered forever — the funds never return to `funded`, the
cardholder's available balance is stuck low, and `card_auth_holds_open_idx`
grows unbounded.

This phase fills that gap: a periodic worker job that walks stale open holds,
posts the reversal journal, and marks the row `resolved_reason='expired'`.

---

## End-to-end goal

```
                          worker (every 6h)
                                │
                                ▼
       paycore.card_auth_holds  where resolved_at is null
       AND created_at < now() - $EXPIRY_WINDOW
                                │
              for each stale hold ↓
                                │
              ┌─────────────────────────────────┐
              │ post journal:                   │
              │   card.holds_account_id  -X     │
              │   card.funded_account_id +X     │
              │ update hold:                    │
              │   resolved_at = now()           │
              │   resolved_reason = 'expired'   │
              └─────────────────────────────────┘
```

Same posting shape as Phase 10's `0420` reversal — just driven by time rather
than an explicit `0420` message. The `resolved_reason='expired'` enum value
is already in the schema (added in Phase 9's `0017` migration).

---

## Pieces

| Piece | What | Where |
|---|---|---|
| **`expireStaleAuthHolds`** | Pure function: query open + stale holds, post reversal journal + update each row | `apps/worker/src/auth-expiry-job.ts` (NEW) |
| **`setInterval` wiring** | Schedule the sweeper on a configurable cadence + window | `apps/worker/src/index.ts` |
| **Integration test** | HAS_DB-gated: seed a stale open hold, run sweeper, assert ledger + row state | `apps/worker/src/auth-expiry-job.test.ts` (NEW) |

Zero schema changes. Zero new packages. Zero new dependencies. The
`card_auth_holds_open_idx` partial index already exists from Phase 9
(`packages/db/migrations/0017_issuing.sql:85`) and is exactly what the
sweeper query needs.

---

## Function shape

```ts
export interface AuthExpiryDeps {
  readonly db: Kysely<Database>;
  readonly logger: Logger;
}

export interface AuthExpiryConfig {
  /** How stale a hold must be to count as expired. Default: 7 days. */
  readonly windowMs: number;
}

export interface AuthExpiryResult {
  readonly scanned: number;
  readonly expired: number;
}

export async function expireStaleAuthHolds(
  deps: AuthExpiryDeps,
  config: AuthExpiryConfig,
  asOf: Date = new Date(),
): Promise<AuthExpiryResult>;
```

Loop per-hold (not per-batch) so a single bad row doesn't poison the whole
run. Each iteration runs in its own DB transaction (insert journal + update
hold). Idempotency rides the journal's `externalId =
'auth_expire:${hold.id}'`; a re-run hits the unique constraint and gets
skipped via try/catch.

---

## Wiring

`apps/worker/src/index.ts` adds two `setInterval`-driven jobs alongside
`runNightlyJobs` + `refreshAccountBalances`:

```ts
const expiryIntervalMs = Number.parseInt(process.env.AUTH_EXPIRY_INTERVAL_MS ?? '21600000', 10); // 6h
const expiryWindowMs   = Number.parseInt(process.env.AUTH_EXPIRY_WINDOW_MS   ?? '604800000', 10); // 7d

const expiryTimer = setInterval(() => {
  expireStaleAuthHolds({ db, logger }, { windowMs: expiryWindowMs })
    .catch((err) => logger.error({ err }, 'auth-expiry job crashed'));
}, expiryIntervalMs);
```

Defaults match the ISO 8583 spec norms — 7-day expiry, swept every 6 hours.
Both env-overridable for the demo.

---

## Out of scope (deferred)

- **0421 reversal-advice retransmit** — real card schemes send a `0421` to
  the acquirer when an issuer expires a hold, so the acquirer's books can
  reconcile. We don't have an acquirer-side hold to reconcile (Phase 11
  acquiring-side accounting was deferred to a future sweep too), so this is
  moot for now.
- **`card.auth_expired` webhook event** — consistent with Phase 11 / 12:
  the cardholder webhook channel doesn't exist yet.
- **Per-product expiry windows** — `paycore.card_products` could carry an
  `auth_expiry_hours` column for product-specific windows. For MVP the
  single env-driven default is enough.
- **Distributed leader election** — `setInterval` in one worker process is
  fine for the dev stack. Production would use a BullMQ repeatable job with
  a Postgres advisory lock (same pattern Phase 6 deferred for clearing).
- **BullMQ repeatable job** — would also fit, but the existing
  `runNightlyJobs` / `refreshAccountBalances` use plain `setInterval` and we
  match that for consistency.

---

## Verifiable success criteria

1. `pnpm typecheck` + `pnpm test` green across all 60 packages.
2. `auth-expiry-job.test.ts` (HAS_DB-gated): with `DATABASE_URL` set,
   create a stale open hold (created_at = 8 days ago) → run sweeper →
   assert hold row has `resolved_reason='expired'`, `resolved_at IS NOT
   NULL`, and the funded balance increased by the hold amount.
3. Same test asserts a fresh hold (created today) is NOT expired.
4. Re-running the sweeper a second time over already-expired rows is a
   no-op (idempotency).
