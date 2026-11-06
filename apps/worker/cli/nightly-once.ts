#!/usr/bin/env tsx
/**
 * Phase 42 — run one nightly pass synchronously, for the e2e canary and
 * for demos (replaces the "shorten the interval env vars" dance from
 * Phases 13–17).
 *
 * `asOf` defaults to now + 24h so the jobs' "yesterday" window is TODAY —
 * the canary's transactions are minutes old, not a day.
 *
 * Phase 47: `--date YYYY-MM-DD` clears that day instead. The scheduled job
 * only ever looks at yesterday, so without this a day the worker was down
 * for could never be swept — its transactions have no clearing_records row
 * and no run would offer them again.
 */

import { parseArgs } from 'node:util';
import { createKysely, createPool, dbConfigFromEnv } from '@psp-new/db';
import { createLogger } from '@psp-new/logger';
import { refreshAccountBalances, runNightlyJobs } from '../src/clearing-job.js';
import { settleSchemeReceivables } from '../src/scheme-settlement-job.js';

/** The jobs window on `asOf - 24h`, so target the day after the one we want. */
function asOfForDate(date: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    console.error(`bad --date "${date}" — expected YYYY-MM-DD`);
    process.exit(2);
  }
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const target = Date.UTC(y, m - 1, d);
  if (Number.isNaN(target)) {
    console.error(`bad --date "${date}" — not a real date`);
    process.exit(2);
  }
  return new Date(target + 86_400_000);
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { date: { type: 'string' } }, strict: true });

  const pool = createPool({ ...dbConfigFromEnv(), applicationName: 'nightly-once' });
  const db = createKysely(pool);
  const logger = createLogger({ service: 'nightly-once' });
  const asOf = values.date ? asOfForDate(values.date) : new Date(Date.now() + 86_400_000);

  await refreshAccountBalances(db, logger);
  await runNightlyJobs({ db, logger }, asOf);
  await refreshAccountBalances(db, logger);
  const settled = await settleSchemeReceivables({ db, logger });
  await refreshAccountBalances(db, logger);
  console.log(`nightly-once complete: settled ${settled.settled}/${settled.scanned} scheme balances`);
  await pool.end();
}

main().catch((err: unknown) => {
  console.error('nightly-once failed', err);
  process.exit(1);
});
