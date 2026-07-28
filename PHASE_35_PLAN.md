# Phase 35 — Plan

**Goal:** `maskPanDeep` stops mutating its input. Today the Pino
`formatters.log` hook (`packages/logger/src/index.ts:88`) passes the
live log record through `maskPanDeep`, which rewrites every string
in place — including objects the record references by identity, like
`req.headers`. Any header value containing a 12+ consecutive-digit
run between non-alphanumerics is permanently replaced with the masked
form for every later reader of the request.

Documented repro (found in Phase 32): an `Idempotency-Key` like
`t-<Date.now()>-x` carries a 13-digit run; after the request log
fires, the idempotency plugin reads the corrupted
`t-178030******1592-x`, fails `/^[A-Za-z0-9_-]{1,255}$/`, and the
request 400s with `idempotency_key_invalid`. Phase 32 worked around
it in tests with UUID keys; real clients sending digit-heavy keys
still break.

## Scope

- `packages/logger/src/redaction.ts` — rewrite `maskPanDeep` to
  return a masked copy:
  - Strings/primitives: unchanged behavior (mask string, pass
    primitives through).
  - Arrays and plain objects: rebuild into new containers; input is
    never written to.
  - Cycles: `WeakMap<source, copy>` so self-references resolve to the
    corresponding copy (previously a `WeakSet` guard).
  - Non-plain objects (Date, class instances): returned as-is,
    unwalked. Pino's serializers (`err`, `req`, `res`) have already
    reduced records to plain shapes by the time `formatters.log`
    runs; walking into class internals was never meaningful, and
    mutating them was the bug.
  - Signature simplifies to `maskPanDeep(value: unknown): unknown`;
    the `seen` parameter was internal plumbing and no caller passes
    it (verified: only `index.ts` and tests import it).
- `packages/logger/src/redaction.test.ts` — new tests:
  - input object (headers-shaped, with a 13-digit-run key value) is
    NOT mutated; returned copy is masked (red against current code);
  - self-referential input still terminates and the copy's cycle
    points at the copy;
  - Date instance passes through by identity.
- `packages/logger/src/index.ts` — fix the stale "Mutates `record`
  in place; Pino is done with it" comment.

## Out of scope

- Removing the Phase 32 UUID-key workaround comment in
  `apps/api/src/routes/v1/cardholder.test.ts` — harmless, still good
  practice, not this phase's file surface.
- Any change to layer 1 (Pino `redact` paths) or `assertNoPan`.
- Performance work; one extra allocation per logged container is
  accepted (the header comment already budgets ~1–5µs per record).

## Files touched

| File | Change |
|---|---|
| `packages/logger/src/redaction.ts` | copy-on-walk `maskPanDeep` |
| `packages/logger/src/redaction.test.ts` | + no-mutation / cycle-copy / Date tests |
| `packages/logger/src/index.ts` | comment only |

No migrations, no new packages, no dep changes.

## Verify steps

| Check | Expected |
|---|---|
| New no-mutation test red-first | fails before the rewrite, passes after |
| `pnpm --filter @psp-new/logger test` | all green, incl. existing mask/cycle tests |
| `pnpm typecheck` | `Tasks: 60 successful, 60 total` |
| `pnpm test` | `Tasks: 60 successful, 60 total` |
