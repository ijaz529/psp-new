# Phase 18 — Freeze toggle + controls editor on /cards/:id (Plan)

**Status:** Proposed for review · **Predecessor:** Phase 17 (`PHASE_17_DONE.md`).

Adds the first write actions to the cardholder portal. Phase 12 shipped
`/cards/:id` as read-only. Phase 18 makes it editable — admins can freeze
cards and tune per-card spending controls.

---

## Scope

Two write surfaces on the existing `/cards/:id` detail page:

1. **Freeze toggle.** A single button:
   - `active` → button reads "Freeze" → POST `/cards/:id/freeze` → status `frozen`
   - `frozen` → button reads "Unfreeze" → POST `/cards/:id/unfreeze` → status `active`
   - `cancelled` is terminal — no button rendered (card creation is one-way; un-cancel is out of scope).
2. **Controls editor.** Two fields matching `CardControls` from
   `@psp-new/issuing`:
   - Daily limit (number input, minor units). Blank = inherit product default.
   - MCC blocklist (comma-separated text, e.g. `5912, 7995`). Blank = inherit.
   - Submit POSTs `/cards/:id/controls` → updates the `paycore.cards.controls`
     jsonb overlay → 302 back to `/cards/:id`.

Auth model is unchanged from Phase 12 — any signed-in portal user. Frame
both as admin-ops actions until a real cardholder identity surface exists.

---

## Pieces

| Piece | What | Where |
|---|---|---|
| **HTML form sections** | Freeze button + controls form in `cardDetailPage` | `apps/portal/src/cards-views.ts` |
| **Routes** | 3 new POST handlers in the portal app | `apps/portal/src/index.ts` |

Zero schema changes. `paycore.cards.status` enum and `paycore.cards.controls
jsonb` columns both shipped in Phase 9's `0017_issuing.sql`.

---

## Storage shape

The TS `CardControls` type from `@psp-new/issuing` uses **camelCase**:
```ts
{ dailyLimit?: number; mccBlocklist?: string[] }
```

Phase 18 writes per-card overlays in camelCase to match. The issuer-host's
`mergeControls` reads camelCase, so per-card overrides will actually be
enforced at auth time.

**Pre-existing bug (not fixed here):** the product `default_controls`
seeded in `0017_issuing.sql` use snake_case (`daily_limit`,
`mcc_blocklist`), so `mergeControls` silently ignores them and product
defaults never apply. Per-card overrides are the only working control
surface today. Fixing the product defaults requires a small data
migration — out of scope for Phase 18, documented in §Out of scope.

---

## Routes

```
POST /cards/:id/freeze        → status='frozen', redirect 302 /cards/:id
POST /cards/:id/unfreeze      → status='active', redirect 302 /cards/:id
POST /cards/:id/controls      → controls = {dailyLimit?, mccBlocklist?}, redirect 302 /cards/:id
```

Body parsing via the already-registered `@fastify/formbody`. Same auth
preHandler as the rest of the portal (signed-in session cookie). Cards in
`cancelled` status reject freeze/unfreeze with 422; controls editing on a
cancelled card is also rejected for symmetry.

Form validation:
- Daily limit: optional positive integer ≤ 1B (minor units; ≈ $10M USD).
  Blank string → omit field (clears overlay).
- MCC blocklist: optional comma-separated string of 4-digit codes.
  Blank → omit. Trim + filter out empties.

---

## Out of scope (deferred)

- **Fix snake_case product `default_controls` seed.** Pre-existing
  Phase 9 bug — product defaults never apply because `mergeControls`
  reads camelCase keys. Per-card overrides work correctly. A future
  small data migration can rewrite the two seeded product rows; not
  Phase 18's problem.
- **Card cancellation surface.** `status='cancelled'` is terminal. We
  don't expose cancel in the portal (irreversible action; admin SQL only).
- **Country blocklist, channel restrictions, velocity rules.** Only the
  two `CardControls` fields exist today. Adding more would require
  extending the `@psp-new/issuing` evaluator + `evaluateAuthControls`.
- **Audit log of who toggled what.** No `paycore.card_events` table yet.
  The journal entries from auth/capture/etc. cover money flow; status +
  control changes are not audited.
- **CSRF tokens.** The portal is admin-only behind session auth — same
  threat model as Phase 8 (no CSRF tokens on `/merchants/:id/kyb`
  either). Add when the public surface justifies it.
- **Webhooks.** `card.frozen` / `card.controls_updated` events not
  emitted — consistent with the deferred cardholder webhook channel.

---

## Verifiable success criteria

1. `pnpm typecheck` + `pnpm test` green across all 60 packages.
2. Signed-in portal user on `/cards/:id` for an `active` card sees a
   "Freeze" button + controls form pre-filled with current per-card
   overlay values. Clicking Freeze flips status, page reloads with
   "Unfreeze" + status pill showing `frozen`.
3. Setting daily limit to e.g. `5000` and posting the controls form
   results in `paycore.cards.controls = '{"dailyLimit":5000}'` and the
   field is pre-filled with `5000` on reload.
4. An auth request against a frozen card returns RC `05` ("do not honor"
   — Phase 10/16 issuer-host behavior; unchanged).
5. Setting daily limit to `1000` (USD $10) and then attempting a $20
   auth returns RC `61` ("exceeds withdrawal limit") — confirms per-card
   controls flow through the issuer-host (the issuer-host already reads
   `paycore.cards.controls` correctly; this is verifying the write path
   lands in the right shape).
