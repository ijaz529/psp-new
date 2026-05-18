-- 0001_init_schemas.sql
-- Create the three top-level schemas and required extensions.
-- This file is run first; the migrator's tracking table lives in `paycore`.

create extension if not exists "pgcrypto";
create extension if not exists "citext";
create extension if not exists "btree_gist";

create schema if not exists paycore;
create schema if not exists ledger;
create schema if not exists vault;

create table if not exists paycore._schema_migrations (
  filename text primary key,
  applied_at timestamptz not null default now(),
  checksum_sha256 text not null
);
