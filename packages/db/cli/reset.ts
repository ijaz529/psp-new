#!/usr/bin/env tsx
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrateUp } from '../src/migrate.js';
import { createPool, dbConfigFromEnv } from '../src/runtime.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, '..', 'migrations');

/**
 * DESTRUCTIVE. Drops the three schemas and re-runs migrations. Dev only.
 * The script refuses to run when NODE_ENV=production unless RESET_FORCE=1.
 */
async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production' && process.env.RESET_FORCE !== '1') {
    console.error('refusing to reset in NODE_ENV=production without RESET_FORCE=1');
    process.exit(2);
  }
  const pool = createPool(dbConfigFromEnv());
  try {
    await pool.query('drop schema if exists paycore cascade');
    await pool.query('drop schema if exists ledger cascade');
    await pool.query('drop schema if exists vault cascade');
    console.warn('dropped schemas');
    const result = await migrateUp(pool, migrationsDir);
    console.warn(`applied ${result.applied.length} migration(s)`);
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
