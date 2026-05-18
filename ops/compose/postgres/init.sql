-- ops/compose/postgres/init.sql
-- Runs once on first Postgres boot (when the data volume is empty).
-- Provisions extensions that need superuser; per-table schema is in
-- packages/db/migrations and runs via the app's migrator at boot.

create extension if not exists "pgcrypto";
create extension if not exists "citext";
create extension if not exists "btree_gist";
