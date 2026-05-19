-- ===========================================================================
-- Phase 10 — Hold lifecycle.
--
-- Adds the two correlation fields the api needs to drive a 0220 capture or
-- 0420 reversal against the same hold issuer-host wrote at 0100 auth time.
-- Both are populated by the orchestrator from AuthorizeResponse and read by
-- capturePaymentIntent / cancelPaymentIntent when calling the acquirer-host
-- capture / reverse endpoints.
--
-- We keep them as plain nullable columns rather than a sibling
-- paycore.payment_intent_auths table — for MVP a PI has at most one open
-- authorization at a time, so the join would buy nothing.
-- ===========================================================================

alter table paycore.payment_intents
  add column last_auth_rrn  char(12),
  add column last_auth_stan char(6);
