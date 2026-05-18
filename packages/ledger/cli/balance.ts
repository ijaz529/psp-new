#!/usr/bin/env tsx
import { createKysely, createPool, dbConfigFromEnv } from '@psp-new/db';
import { format } from '@psp-new/money';
import { balance } from '../src/balance.js';

async function main(): Promise<void> {
  const accountId = process.argv[2];
  if (!accountId) {
    console.error('usage: pnpm ledger:balance <account_id>');
    console.error('       or:   pnpm --filter @psp-new/ledger balance <account_id>');
    process.exit(2);
  }

  const pool = createPool({ ...dbConfigFromEnv(), applicationName: 'ledger-cli' });
  const db = createKysely(pool);
  try {
    const live = await balance(db, accountId, { freshness: 'live' });
    const cached = await balance(db, accountId, { freshness: 'view' });
    console.log(`account:    ${accountId}`);
    console.log(`balance:    ${format(live)}  (live)`);
    console.log(`view:       ${format(cached)}  (materialized; refresh to update)`);
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
