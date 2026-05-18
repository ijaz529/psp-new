-- 0015_risk_and_disputes.sql
-- Phase 7: risk decisions + disputes lifecycle.

-- ---------------------------------------------------------------------------
-- Risk decisions — one row per authorization attempt.
-- ---------------------------------------------------------------------------
create table paycore.risk_decisions (
  id                text primary key,                -- rd_<ulid>
  merchant_id       text not null,
  payment_intent_id text not null references paycore.payment_intents(id),
  outcome           text not null check (outcome in ('allow', 'review', 'deny')),
  score             int not null check (score >= 0 and score <= 1000),
  triggered_rules   text[] not null default array[]::text[],
  evidence          jsonb,
  created_at        timestamptz not null default now()
);
create index risk_decisions_pi_idx on paycore.risk_decisions (payment_intent_id);
create index risk_decisions_merchant_idx on paycore.risk_decisions (merchant_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Disputes lifecycle — Visa reason codes first (per ADR-0018).
-- States: retrieval_request → first_chargeback → representment → pre_arbitration → arbitration → (won|lost)
-- ---------------------------------------------------------------------------
create table paycore.disputes (
  id                  text primary key,             -- dp_<ulid>
  merchant_id         text not null,
  payment_intent_id   text not null references paycore.payment_intents(id),
  scheme              text not null check (scheme in ('visa', 'mastercard', 'amex')),
  reason_code         text not null,                  -- e.g. 'visa_10.4', 'mc_4837'
  state               text not null check (state in (
                        'retrieval_request',
                        'first_chargeback',
                        'representment',
                        'pre_arbitration',
                        'arbitration',
                        'won',
                        'lost',
                        'expired'
                      )),
  amount              bigint not null check (amount > 0),
  currency            char(3) not null references ledger.currencies(code),
  evidence_due_at     timestamptz,
  evidence            jsonb,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index disputes_merchant_state_idx on paycore.disputes (merchant_id, state, created_at desc);
create index disputes_pi_idx on paycore.disputes (payment_intent_id);

create table paycore.dispute_events (
  id           text primary key,                      -- de_<ulid>
  dispute_id   text not null references paycore.disputes(id),
  event_type   text not null,
  data         jsonb,
  created_at   timestamptz not null default now()
);
create index dispute_events_dispute_idx on paycore.dispute_events (dispute_id, created_at);

-- ---------------------------------------------------------------------------
-- Velocity-check helper view: count + sum per (merchant, card_token) over a window.
-- ---------------------------------------------------------------------------
create or replace function paycore.velocity_for_token(
  p_merchant_id text,
  p_token_id    text,
  p_window_seconds int
) returns table (count int, total bigint) language sql stable as $$
  select count(*)::int, coalesce(sum(amount), 0)::bigint
  from paycore.payment_intents pi
  join paycore.payment_methods pm on pm.id = pi.payment_method_id
  where pi.merchant_id = p_merchant_id
    and pm.token_id = p_token_id
    and pi.created_at >= now() - (p_window_seconds || ' seconds')::interval;
$$;

grant select, insert, update on
  paycore.risk_decisions,
  paycore.disputes,
  paycore.dispute_events
to psp_app;
grant execute on function paycore.velocity_for_token to psp_app;
