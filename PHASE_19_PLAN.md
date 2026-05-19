# Phase 19 — Fix product-defaults snake_case bug (Plan)

**Status:** Proposed for review · **Predecessor:** Phase 18 (`PHASE_18_DONE.md`).

One-off bug fix from Phase 9. The two seeded `paycore.card_products` rows
have `default_controls` stored with **snake_case** JSON keys
(`daily_limit`, `mcc_blocklist`), but `mergeControls` in
`@psp-new/issuing` reads **camelCase** (`dailyLimit`, `mccBlocklist`).
Net effect today: product defaults silently never apply at auth time.
Phase 18 documented this twice; this phase fixes it.

---

## Scope

A single data migration (`0023`) that rewrites the existing two product
rows' `default_controls` JSON to camelCase keys. Idempotent — running
twice is a no-op because the WHERE clause filters on the presence of
snake_case keys.

No code changes. No new accounts. No schema changes.

---

## Migration

```sql
update paycore.card_products
   set default_controls = jsonb_build_object(
         'dailyLimit', (default_controls ->> 'daily_limit')::int,
         'mccBlocklist', coalesce(default_controls -> 'mcc_blocklist', '[]'::jsonb)
       )
 where default_controls ? 'daily_limit'
    or default_controls ? 'mcc_blocklist';
```

Behaviour:
- Picks up only rows that still have the buggy keys.
- Preserves the `dailyLimit` integer value and the `mccBlocklist` array.
- Strips the snake_case keys.
- Re-runs after first apply are no-ops (the WHERE clause matches nothing).
- Fresh DBs apply 0017 (snake_case seeds) then immediately 0023
  (rewrite). Net result: clean camelCase product defaults.

---

## Why this fixes the bug

Before:
```sql
select default_controls from paycore.card_products where id = 'prod_strawberry_visa_usd';
-- {"daily_limit": 100000, "mcc_blocklist": []}
```

`mergeControls({daily_limit: 100000, mcc_blocklist: []}, {})`:
- reads `defaults.dailyLimit` → `undefined`
- reads `defaults.mccBlocklist` → `undefined`
- returns `{}` (no limits, no blocklist)

→ `evaluateAuthControls` sees `dailyLimit = 0` (treated as unlimited) and
`mccBlocklist?.includes()` → `undefined?.includes()` → `false`. Net: product
defaults never enforced.

After:
```sql
select default_controls from paycore.card_products where id = 'prod_strawberry_visa_usd';
-- {"dailyLimit": 100000, "mccBlocklist": []}
```

`mergeControls` reads the camelCase keys correctly. The seeded
`dailyLimit: 100000` (= $1000 USD) and the empty `mccBlocklist` now
actually apply at auth time, exactly as Phase 9's plan intended.

---

## Out of scope

- **Phase 18's per-card overlay path** — already correct (writes
  camelCase). Untouched.
- **A schema-level CHECK for camelCase keys** — overkill for two fields.
  Tests are the right place.
- **A test against the migrated data** — the migration is so simple it
  self-verifies. Existing `mergeControls` unit tests in
  `packages/issuing/src/controls.test.ts` already cover the camelCase
  read path with hand-constructed objects.

---

## Verifiable success criteria

1. `pnpm typecheck` + `pnpm test` green across all 60 packages.
2. With compose up, after migrate:
   ```sql
   select id, default_controls from paycore.card_products;
   -- both rows show: {"dailyLimit": 100000, "mccBlocklist": []}
   ```
3. End-to-end (existing Phase 9 setup, no per-card overlay): a card with
   no `controls` override now actually enforces the $1000/day product
   default. An auth for $1001 returns RC 61.
