-- ===========================================================================
-- Phase 36 — Capture timestamp.
--
-- Clearing must window on when money was actually captured, not when the
-- PaymentIntent row was created: a PI authorized day N and captured day N+2
-- was missed by day N's nightly job (not yet succeeded) and excluded from
-- day N+2's (created_at outside the window), so it never cleared.
--
-- Nullable plain column, same rationale as 0018's last_auth_*: no backfill.
-- Historical rows keep NULL and clearing falls back to created_at, which is
-- exactly the pre-Phase-36 behavior for them.
--
-- Stamped by the orchestrator at both succeeded-transition sites: the
-- auto-capture path (runAuthorizeAndPost) and the final manual capture
-- (capturePaymentIntent). Partial captures do not stamp — a PI clears once,
-- in full, on the day it finishes capturing.
-- ===========================================================================

alter table paycore.payment_intents
  add column captured_at timestamptz;
