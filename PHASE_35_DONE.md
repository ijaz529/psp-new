# Phase 35 — Done

**Date:** 2026-07-28 · **Status:** log redaction no longer corrupts
request state. Plan: `PHASE_35_PLAN.md`.

The Pino `formatters.log` hook ran every log record through
`maskPanDeep`, which rewrote strings in place — including objects the
record referenced by identity, like `req.headers`. The Phase 32 repro:
an `Idempotency-Key` containing a 13-digit `Date.now()` run was
masked to `t-178030******1592-…` after the request log fired, so the
idempotency plugin read a corrupted key and 400'd with
`idempotency_key_invalid`.

## What shipped

### `packages/logger/src/redaction.ts`

`maskPanDeep` is now copy-on-walk:

- Strings are masked, primitives pass through — behavior unchanged.
- Arrays and plain objects are rebuilt into new containers; the input
  is never written to.
- Cycles resolve via a `WeakMap<source, copy>`, so a self-referential
  bindings object maps to its (possibly still-filling) copy — the
  copy's cycle points at the copy, the input's cycle stays intact.
- Non-plain objects (Date, class instances) pass through by identity,
  unwalked. Pino's `err`/`req`/`res` serializers have already reduced
  records to plain shapes before `formatters.log` runs.
- Signature simplified to `maskPanDeep(value)` — the `seen` parameter
  was internal plumbing no caller used.

### `packages/logger/src/redaction.test.ts`

Four new tests: header-shaped input not mutated with masking on the
returned copy (the Phase 32 repro verbatim — red before the rewrite),
arrays not mutated, self-referential copy semantics, Date identity
pass-through.

### `packages/logger/src/index.ts`

Comment on the `formatters.log` hook updated ("returns a masked copy"
instead of the now-false "Pino is done with it").

## Verify

| Check | Result |
|---|---|
| New no-mutation tests before rewrite | 3 red (Date pass-through already held) |
| `pnpm --filter @psp-new/logger exec vitest --run` | 30/30 green |
| `pnpm typecheck` | 60/60 green |
| `pnpm test` | 60/60 green |

## What did NOT change

- Layer 1 Pino `redact` paths and `assertNoPan` — untouched.
- `maskPanInString` — same regex, same BIN+last4 masking.
- The Phase 32 UUID-key comment in `cardholder.test.ts` — still
  accurate as history; UUID keys remain fine practice.
- Cost profile: one extra allocation per logged container, inside the
  file's stated ~1–5µs-per-record budget.

## Open list (Phase 34's list, one item closed)

- Webhook deadletter replay UI for cardholders.
- Per-card endpoint scoping.
- TC 25 / MTI 1442 chargeback scheme-file fan-out from Phase 25.
- Merchant route integration tests — broader coverage still open.
- ~~Fix logger redaction mutation~~ — closed this phase.
- Janitor sweep for expired `paycore.cardholder_idempotency_keys`.
- Run the Phase 33 DB-gated confirm test against a live Postgres and
  record the result (still blocked: no local Postgres, Docker registry
  unreachable in the authoring sessions).
- Window clearing collection on capture time instead of `created_at`.
- `make e2e` payment canary (the PROJECT_BRIEF success criterion).
