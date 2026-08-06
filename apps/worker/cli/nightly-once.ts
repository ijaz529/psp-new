#!/usr/bin/env tsx
/**
 * Phase 42 — run one nightly pass synchronously, for the e2e canary and
 * for demos (replaces the "shorten the interval env vars" dance from
 * Phases 13–17).
 *
 * `asOf` defaults to now + 24h so the jobs' "yesterday" window is TODAY —
 * the canary's transactions are minutes old, not a day.
 */

import { createKysely, createPool, dbConfigFromEnv } from '@psp-new/db';
import { createLogger } from '@psp-new/logger';
import { refreshAccountBalances, runNightlyJobs } from '../src/clearing-job.js';
import { settleSchemeReceivables } from '../src/scheme-settlement-job.js';

async function main(): Promise<void> {
  const pool = createPool({ ...dbConfigFromEnv(), applicationName: 'nightly-once' });
  const db = createKysely(pool);
  const logger = createLogger({ service: 'nightly-once' });
  const asOf = new Date(Date.now() + 86_400_000);

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
