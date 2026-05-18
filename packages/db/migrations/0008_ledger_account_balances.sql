-- 0008_ledger_account_balances.sql
-- Materialized view of per-account balances. Refresh CONCURRENTLY from a
-- periodic job in Phase 6+. Until then, the view is populated once at migration
-- and apps fall back to direct SUM() when staleness matters.

create materialized view ledger.account_balances as
select
  a.id           as account_id,
  a.currency,
  coalesce(sum(case when jl.amount > 0 then jl.amount else 0 end), 0)::bigint  as debit_total,
  coalesce(sum(case when jl.amount < 0 then -jl.amount else 0 end), 0)::bigint as credit_total,
  coalesce(sum(jl.amount), 0)::bigint                                          as balance,
  max(je.occurred_at)                                                          as last_journal_at
from ledger.accounts a
left join ledger.journal_lines jl on jl.account_id = a.id
left join ledger.journal_entries je on je.id = jl.entry_id
group by a.id, a.currency;

-- Unique index is required for REFRESH MATERIALIZED VIEW CONCURRENTLY.
create unique index account_balances_pk on ledger.account_balances (account_id);

-- A non-unique secondary index for "find biggest balances per currency" queries.
create index account_balances_currency_idx on ledger.account_balances (currency);
