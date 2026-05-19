# Phase 27 — Cardholder Portal: /webhooks UI

**Goal.** Cardholders can list, create, and disable their webhook
endpoints from the portal — the missing piece left by Phase 26 (which
shipped delivery + a CLI but no UI).

**Non-goal (later).** REST API mirror at `/v1/cardholder/webhook_endpoints`.
Per-endpoint event filter UI (a free-text comma-separated input is good
enough). Replay/retry attempts from the UI. Webhook test-send.

## Routes (all under `/cardholder/*`, session-gated)

| Method | Path | Behavior |
|---|---|---|
| GET | `/cardholder/webhooks` | List the signed-in cardholder's endpoints. Empty-state hints at the CLI for ops still wanting it. |
| GET | `/cardholder/webhooks/new` | Form to create one. |
| POST | `/cardholder/webhooks` | Validate `url` + comma-separated `events`, generate `whsec_<hex>`, insert. Redirect to a one-time "Secret created" page that displays the secret ONCE. |
| GET | `/cardholder/webhooks/:id` | Detail: url, status, events list, recent attempts (last 20 via `webhook_attempts` join). |
| POST | `/cardholder/webhooks/:id/disable` | Soft disable (status='disabled', disabled_at=now). Redirect back to detail. |

All routes filter `paycore.webhook_endpoints.cardholder_id = ch.id` so
the URL can't escape the cardholder's scope.

## Views (new file `apps/portal/src/webhooks-views.ts`)

- `cardholderWebhooksListPage({user, endpoints})` — table of id/url/status/events
- `cardholderWebhookFormPage({user, error?})` — url+events+description form
- `cardholderWebhookCreatedPage({user, endpoint, secret})` — one-time
  display of the freshly minted secret with a "Got it" link back to the
  list.
- `cardholderWebhookDetailPage({user, endpoint, attempts})` — endpoint
  fields + a recent-attempts table.

Reuse `BASE_CSS` + `esc` from `dashboard-views.ts`. Export
`cardholderLayout` from `cards-views.ts` (currently private) and add a
"Webhooks" nav link there so it appears across cardholder pages.

## What does NOT change

- Phase 26 wire format (HMAC header, retry schedule, etc.).
- CLI keeps working — `pnpm cardholder:webhook` still provisions, identical row shape.
- Drainer / worker code paths.
- Merchant webhook UI (already exists separately).

## Files touched (estimate)

- `apps/portal/src/webhooks-views.ts` (new)
- `apps/portal/src/cards-views.ts` (export `cardholderLayout`, add Webhooks nav link)
- `apps/portal/src/index.ts` (5 new routes)
- `PHASE_27_DONE.md` (after impl)

No migration, no new package deps, no schema delta.

## Verify

1. `pnpm typecheck` green across all 60 packages.
2. `pnpm test` green across all 60 packages.
3. Manual demo (not blocking commit):
   - Sign in as cardholder → `/cardholder/webhooks` shows empty state.
   - Create one with url `http://localhost:9876` + events `card_load.*`.
   - One-time secret page shows `whsec_<hex>`; copy it.
   - List page shows the row enabled.
   - Detail page shows zero attempts. Trigger a card load → wait → attempts populate.
   - Disable → list shows status disabled.
