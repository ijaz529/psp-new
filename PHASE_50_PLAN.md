# Phase 50 — Plan: take passwords off the command line

**Date:** 2026-11-07 · **Status:** in progress.

## Goal

Setting a password must not print it. Today both password CLIs take the
value as `--password`, and pnpm echoes the command it is about to run:

```
> tsx cli/user-create.ts --email you@example.com --name 'Ops Admin' --password <plaintext>
```

That is how `PORTAL_DEMO_PASSWORD` ended up in a terminal during Phase 45.
`pnpm --silent` suppresses the echo, but a flag you have to remember is
not a fix — the default has to be safe.

## Scope

Two CLIs have the identical defect:

| File | Today |
|---|---|
| `apps/portal/cli/user-create.ts` | `--password` on argv |
| `apps/api/cli/cardholder-set-password.ts` | `--password` on argv |

The ask was the portal one. The second is the same bug in a mirror-image
file — eight lines apart in shape — and fixing one while leaving the
other is the half-fix this project keeps finding. Both.

Each reads its password from the environment instead:

| CLI | Variable |
|---|---|
| `user:create` | `PORTAL_USER_PASSWORD` |
| `cardholder:set-password` | `CARDHOLDER_PASSWORD` |

`--password` is removed rather than kept as a fallback. Keeping it leaves
the footgun loaded, and `parseArgs({strict:true})` already rejects unknown
options, so anyone still passing it gets a loud error rather than a silent
ignore. Nothing automated calls either CLI — checked `ci.yml`, the ops
scripts and the workspace; the only other references are two portal hint
strings that name the command without flags, and they stay correct.

## Out of scope

- No prompting, no stdin, no secret-manager integration. One variable
  each, read and used. The value is still visible in the process list
  (`ps`) while the command runs — acceptable on a developer's own machine
  and worth saying out loud rather than engineering around.
- `user:create` still being a plain insert, so rotating means deleting the
  old row first. A real annoyance, unrelated to leaking, and its own
  phase if it is worth one.
- The historical phase docs. `PHASE_8_DONE.md:35` carries a literal
  example password; it is dead (401 against the running portal, not the
  `.env` value, and its `admin@example.com` does not exist), and those
  docs are a record of what happened. Rewriting them would not unpublish
  anything either — they are already on GitHub.

## Files touched

| File | Change |
|---|---|
| `PHASE_50_PLAN.md` | this doc (commit 1) |
| `apps/portal/cli/user-create.ts` | `PORTAL_USER_PASSWORD` (commit 2) |
| `apps/api/cli/cardholder-set-password.ts` | `CARDHOLDER_PASSWORD` (commit 2) |
| `README.md` | the documented bootstrap command (commit 2) |
| `PHASE_50_DONE.md` | write-up (commit 3) |

## Verify steps

| # | Step | Pass condition |
|---|---|---|
| 1 | Run `user:create` **without** `--silent`, password in the env | pnpm's echoed command line contains no password — this is the phase |
| 2 | The created user signs in | 302 |
| 3 | Variable unset | exits 2 with a usage message naming the variable |
| 4 | Still passing `--password` | fails loudly, does not silently ignore |
| 5 | Same four for `cardholder:set-password` | as above, via `/cardholder/signin` |
| 6 | `pnpm exec biome check` on changed files | clean |
| 7 | `pnpm typecheck` | 60/60 |
| 8 | `pnpm test`, fresh database, `--force` | 60/60 |
| 9 | `make reset-db && make migrate && make e2e` | canary 11/11 |

Step 1 is the point: the proof is grepping the un-silenced output for the
secret and not finding it.

Throwaway credentials for all of it — never the real `.env` values.
