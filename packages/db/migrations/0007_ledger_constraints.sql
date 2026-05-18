-- 0007_ledger_constraints.sql
-- Enforce the ledger invariants at the DB level. App code CANNOT bypass these.
--
--   1. Every journal entry must sum to 0 per currency.
--   2. A single entry must use ONE currency (no mixed-currency entries).
--   3. Every journal_line.currency must match its account.currency.
--   4. journal_lines and journal_entries are append-only — no UPDATE, no DELETE.
--
-- See DECISIONS.md ADR-0009 (debit-positive sign convention).

-- 1+2: balanced-entry + single-currency check.
-- Deferred to commit time so multi-line inserts can be staged inside a single
-- transaction before the assertion fires.
create or replace function ledger.check_entry_balanced() returns trigger
language plpgsql as $$
declare
  bad_count int;
  currencies_count int;
begin
  -- Single-currency-per-entry
  select count(distinct currency) into currencies_count
  from ledger.journal_lines
  where entry_id = new.entry_id;

  if currencies_count > 1 then
    raise exception 'journal entry % mixes currencies (% distinct)', new.entry_id, currencies_count
      using errcode = '23514'; -- check_violation
  end if;

  -- Balanced per currency (with exactly one currency, equivalent to sum = 0).
  select count(*) into bad_count
  from (
    select currency, sum(amount) as total
    from ledger.journal_lines
    where entry_id = new.entry_id
    group by currency
    having sum(amount) != 0
  ) bad;

  if bad_count > 0 then
    raise exception 'journal entry % is unbalanced', new.entry_id
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create constraint trigger journal_lines_balanced_entry
after insert on ledger.journal_lines
deferrable initially deferred
for each row execute function ledger.check_entry_balanced();

-- 3: currency must match the parent account. Immediate (per-row).
create or replace function ledger.check_line_currency() returns trigger
language plpgsql as $$
declare
  acct_currency char(3);
begin
  select currency into acct_currency from ledger.accounts where id = new.account_id;
  if acct_currency is null then
    raise exception 'journal line references unknown account %', new.account_id
      using errcode = '23503'; -- foreign_key_violation
  end if;
  if acct_currency != new.currency then
    raise exception 'journal line currency % does not match account currency % (account %)',
      new.currency, acct_currency, new.account_id
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger journal_lines_currency_match
before insert on ledger.journal_lines
for each row execute function ledger.check_line_currency();

-- 4: append-only — block UPDATE + DELETE on both ledger tables.
create or replace function ledger.deny_modification() returns trigger
language plpgsql as $$
begin
  raise exception 'ledger.% is append-only; % rejected', tg_table_name, tg_op
    using errcode = '42501'; -- insufficient_privilege
end;
$$;

create trigger journal_lines_append_only
before update or delete on ledger.journal_lines
for each row execute function ledger.deny_modification();

create trigger journal_entries_append_only
before update or delete on ledger.journal_entries
for each row execute function ledger.deny_modification();

-- Bonus: reject zero-amount lines (a zero line carries no information and
-- breaks the "every line has economic meaning" invariant).
alter table ledger.journal_lines
  add constraint journal_lines_amount_nonzero check (amount != 0);
