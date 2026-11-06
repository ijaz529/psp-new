-- ===========================================================================
-- Phase 47 — supplementary clearing files.
--
-- Until now a (scheme, currency, file_date, format) could hold exactly one
-- file, so a transaction captured after that file was cut reached no file at
-- all: the day it belongs to is already closed, and no later run looks at it
-- again. Phase 46 stopped the re-run from corrupting state; it did not get
-- those transactions cleared.
--
-- Real acquirers submit several presentment files a day, each with its own
-- sequence, each carrying only what has not been presented yet. A submitted
-- file stays immutable — the second run of a day cuts 002, it does not
-- rewrite 001.
--
-- Existing rows take sequence 1 from the default, so nothing already emitted
-- moves and their filenames keep describing them.
-- ===========================================================================

alter table paycore.clearing_files
  add column sequence int not null default 1
    constraint clearing_files_sequence_positive check (sequence >= 1);

drop index if exists paycore.clearing_files_scheme_date_idx;

create unique index clearing_files_scheme_date_seq_idx
  on paycore.clearing_files (scheme, currency, file_date, format, sequence);
