# Phase 27 — Done

**Date:** 2026-05-19 · **Status:** Cardholder portal `/webhooks` UI shipped. Plan: `PHASE_27_PLAN.md`.

The Phase 26 cardholder-webhook plumbing now has a UI. Cardholders can
list, create, view, and disable their endpoints from `/cardholder/webhooks`.
The CLI from Phase 26 keeps working unchanged.

## What shipped

### Five routes in `apps/portal/src/index.ts`

| Method | Path | Behavior |
|---|---|---|
| GET | `/cardholder/webhooks` | List endpoints. Empty state links to /new. |
| GET | `/cardholder/webhooks/new` | Form. |
| POST | `/cardholder/webhooks` | Validate, generate `whsec_<hex>`, insert, render the **created** view that shows the secret ONCE. |
| GET | `/cardholder/webhooks/:id` | Detail + recent 20 `webhook_attempts`. |
| POST | `/cardholder/webhooks/:id/disable` | Soft-disable (status='disabled', disabled_at=now). |

All routes filter on `cardholder_id = ch.id` so the URL can't reach
another cardholder's data.

### Views in `apps/portal/src/webhooks-views.ts` (new)

- `cardholderWebhooksListPage`
- `cardholderWebhookFormPage`
- `cardholderWebhookCreatedPage` — the only place the signing secret is
  ever rendered; subsequent views show only the endpoint id/url/status.
- `cardholderWebhookDetailPage` — endpoint metadata + recent attempts.

Reuses `BASE_CSS`, `esc`, and `cardholderLayout` from the existing
portal-view files. Inlines a 3-line `formatDate` and a tiny `statusPill`
helper rather than over-sharing.

### One-line nav addition

`cardholderLayout` in `cards-views.ts`:
- exported (was private)
- added a "Webhooks" link to the cardholder nav

## What did NOT change

- Phase 26 wire format (HMAC header, retry schedule, attempts schema).
- The `cardholder:webhook` CLI keeps working with identical row shape.
- Outbox drainer / webhook-processor code paths.
- Merchant webhook UI / API.
- Schema. Zero migration this phase.

## Verify

| Check | Result |
|---|---|
| `pnpm typecheck` | 60/60 green |
| `pnpm test` | 60/60 green |
| Manual UI exercise | Not run in this session |

## Demo path (manual)

```bash
# Prereq: cardholder + password (phases 9/22), card issued.
pnpm cardholder:set-password --cardholder ch_... --password ...

# Run portal.
pnpm --filter @psp-new/portal dev

# Browse to http://localhost:3000/cardholder/signin, sign in.
# Nav now shows "Webhooks" → /cardholder/webhooks → empty state.
# Click "+ New endpoint" → enter url + events → submit.
# "Endpoint created" page renders whsec_<hex> once. Copy it.
# List shows the endpoint enabled. Click it → detail view, zero attempts.
# Trigger a card_load.succeeded by `pnpm card:load`. Wait ~1s for the
# outbox-relay drain + bullmq deliver. Refresh detail → attempts table
# populates with status + http code.
# Click "Disable endpoint" → status flips to 'disabled', further events
# do not fan out to it.
```

## Open list (Phase 28+ candidates)

- **Cardholder REST API** — `/v1/cardholder/*` mirror of the portal,
  needs cardholder API keys (no API-key scheme exists today for
  cardholders, only merchants).
- **Auto-top-up rules** — requires cardholder-scoped payment methods.
- **Real Base II / IPM parsing** — biggest unblocked item still on the
  open list since Phase 20.
- **Webhook deadletter replay UI** for cardholders (mirror of merchant
  side).
- **Per-card endpoint scoping** — current model is per-cardholder.
