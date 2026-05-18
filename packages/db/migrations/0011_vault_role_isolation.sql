-- 0011_vault_role_isolation.sql
-- Postgres-level isolation. The vault schema is grant-fenced so the api,
-- worker, outbox-relay, etc. CANNOT read pan_ciphertext or any vault data.
-- Only the `vault_user` (member of psp_vault role) can.
--
-- ADR-0012 explains the role/grant pattern.
--
-- Idempotent — safe to re-run.

-- Roles -----------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'psp_vault') then
    create role psp_vault nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'psp_app') then
    create role psp_app nologin;
  end if;
end
$$;

-- Login users (dev-only passwords; production should rotate via secrets manager).
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'vault_user') then
    create user vault_user with password 'vault_dev_password' in role psp_vault;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'app_user') then
    create user app_user with password 'app_dev_password' in role psp_app;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- vault.*  → only psp_vault can read/write. Default-deny everyone else.
-- ---------------------------------------------------------------------------
revoke all on schema vault from public;
grant usage on schema vault to psp_vault;
grant select, insert, update on all tables in schema vault to psp_vault;
alter default privileges in schema vault
  grant select, insert, update on tables to psp_vault;

-- Explicit: psp_app is NOT granted anything on vault.*. Default-deny applies.
-- (We could `revoke all from psp_app` for belt-and-braces; default-deny is enough.)

-- ---------------------------------------------------------------------------
-- paycore.* + ledger.*  → psp_app has standard CRUD; ledger.* is append-only
-- so no DELETE there (the trigger would reject anyway; this is defence in depth).
-- ---------------------------------------------------------------------------
grant usage on schema paycore to psp_app;
grant usage on schema ledger  to psp_app;

grant select, insert, update, delete on all tables in schema paycore to psp_app;
grant select, insert, update         on all tables in schema ledger  to psp_app;
grant select                          on ledger.account_balances        to psp_app;

alter default privileges in schema paycore
  grant select, insert, update, delete on tables to psp_app;
alter default privileges in schema ledger
  grant select, insert, update on tables to psp_app;

-- ledger.* sequences and the audit table also need usage for inserts.
grant usage on all sequences in schema paycore to psp_app;
grant usage on all sequences in schema ledger  to psp_app;
alter default privileges in schema paycore grant usage on sequences to psp_app;
alter default privileges in schema ledger  grant usage on sequences to psp_app;

-- Vault user gets sequence usage in its own schema (none today, but future-proof).
grant usage on all sequences in schema vault to psp_vault;
alter default privileges in schema vault grant usage on sequences to psp_vault;
