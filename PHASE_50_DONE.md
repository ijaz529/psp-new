# Phase 50 — Done

**Date:** 2026-11-07 · **Status:** setting a password no longer prints it.
Plan: `PHASE_50_PLAN.md`.

## What shipped

Both password CLIs read their secret from the environment. `--password` is
gone, not deprecated.

| CLI | Variable |
|---|---|
| `pnpm --filter @psp-new/portal user:create` | `PORTAL_USER_PASSWORD` |
| `pnpm cardholder:set-password` | `CARDHOLDER_PASSWORD` |

```bash
PORTAL_USER_PASSWORD="<8+ chars>" pnpm --filter @psp-new/portal user:create \
  --email you@example.com --name "Ops"
```

`README.md`'s bootstrap line is updated to match. The two portal hint
strings that mention these commands name them without flags, so they were
already correct.

## The bug

pnpm prints the command line it is about to run. With the password as a
flag, every invocation echoed it:

```
> tsx cli/user-create.ts --email you@example.com --name 'Ops Admin' --password <plaintext>
```

That is exactly how `PORTAL_DEMO_PASSWORD` reached a terminal during
Phase 45. `pnpm --silent` suppresses the echo — which is what the Phase 45
write-up recommended — but a flag you have to remember is not a fix. The
default had to stop leaking.

Afterwards the same un-silenced run prints:

```
> tsx cli/user-create.ts --email p50@example.com --name P50
```

## Why both CLIs

The ask was the portal one. `apps/api/cli/cardholder-set-password.ts` had
the identical defect in a mirror-image file — same `parseArgs`, same
`hashPassword`, same echo. Fixing one and leaving the other is the
half-fix this project keeps turning up, so both.

Removing `--password` rather than keeping it as a fallback is deliberate:
a fallback leaves the footgun loaded. `parseArgs({strict:true})` already
rejects unknown options, so an old invocation fails loudly with
`ERR_PARSE_ARGS_UNKNOWN_OPTION` instead of silently ignoring the flag and
writing an unintended password.

Nothing automated calls either CLI — checked `ci.yml`, `ops/scripts/` and
the workspace.

## Verify

Throwaway credentials throughout, never the real `.env` values.

| Check | `user:create` | `cardholder:set-password` |
|---|---|---|
| Un-silenced run: secret anywhere in the output? | **no** | **no** |
| Created credential signs in | 302 | 302 (`/cardholder/signin`) |
| Variable unset | exit 2, usage names the variable | exit 2, same |
| Still passing `--password` | `ERR_PARSE_ARGS_UNKNOWN_OPTION` | `Unknown option '--password'` |

| Gate | Result |
|---|---|
| `pnpm exec biome check` on changed files | clean |
| `pnpm typecheck` | 60/60 |
| `pnpm test`, fresh database, `--force` | 60/60 |
| `make reset-db && make migrate && make e2e` | canary **11/11** |

Test accounts created along the way were deleted; one portal user remains,
the real one.

## What this does not do

- **The value is still visible in the process list** (`ps`) while the
  command runs. Fine on a developer's own machine; said out loud rather
  than engineered around with prompting or a secret manager, neither of
  which this project needs.
- **`user:create` is still a plain insert**, so rotating a password means
  deleting the old row first — `portal_users.email` is unique and
  `portal_sessions.user_id` references it. A real annoyance, unrelated to
  leaking. An upsert would make rotation one command.
- **`PHASE_8_DONE.md:35` still carries a literal example password.** It is
  dead — 401 against the running portal, not the `.env` value, and its
  `admin@example.com` does not exist — and the phase docs are a record of
  what happened. Rewriting them would not unpublish anything: they are
  already on GitHub.

## Still open

- `findCardByPan` matching on bin + last4 alone, unordered (Phase 48).
- The intermittent full-suite failures recorded in Phase 49.
- `PORTAL_DEMO_PASSWORD` itself still wants rotating — this phase removed
  the leak, it did not change the leaked value. The steps are in
  `PHASE_45_DONE.md` and the command above.

## Open list (carried)

- Map Fastify's empty-JSON-body error to 400 (Phase 41 finding).
- Vault-in-harness for tokens/payment-method/3DS test breadth.
- CI job that runs `make e2e` against compose.
- Payouts: `listPayoutCandidates` windows on PI `created_at`; reserves;
  `merchants.payout_schedule` ignored (Phase 43).
- Portal detail pages for payouts and disputes; dispute actions.
- `packages/risk-rules` written but wired into nothing.
