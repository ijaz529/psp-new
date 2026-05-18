-- 0016_portal_users_and_kyb.sql
-- Phase 8: portal authentication + KYB.

-- Portal users — Phase 8 ships a single shared admin login per portal
-- deployment. Phase 9+ adds per-merchant tenant separation.
create table paycore.portal_users (
  id              text primary key,                -- pu_<ulid>
  email           citext not null unique,
  display_name    text not null,
  password_hash   text not null,
  totp_secret     text,
  is_admin        boolean not null default false,
  created_at      timestamptz not null default now(),
  last_login_at   timestamptz,
  disabled_at     timestamptz
);
create index portal_users_email_idx on paycore.portal_users (email);

create table paycore.portal_sessions (
  id            text primary key,                  -- ps_<ulid>
  user_id       text not null references paycore.portal_users(id),
  token_hash    text not null unique,              -- sha256(raw cookie token)
  ip_address    text,
  user_agent    text,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  revoked_at    timestamptz
);
create index portal_sessions_user_idx on paycore.portal_sessions (user_id);
create index portal_sessions_token_idx on paycore.portal_sessions (token_hash);
create index portal_sessions_expires_idx on paycore.portal_sessions (expires_at);

-- KYB on the merchant table — simple jsonb blob for Phase 8.
alter table paycore.merchants
  add column kyb_status text not null default 'pending'
    check (kyb_status in ('pending', 'submitted', 'approved', 'rejected')),
  add column kyb_data jsonb;

grant select, insert, update on paycore.portal_users, paycore.portal_sessions to psp_app;
