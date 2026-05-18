#!/usr/bin/env tsx
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrateUp } from '../src/migrate.js';
import { createPool, dbConfigFromEnv } from '../src/runtime.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, '..', 'migrations');

async function main(): Promise<void> {
  const pool = createPool(dbConfigFromEnv());
  try {
    const result = await migrateUp(pool, migrationsDir);
    if (result.applied.length === 0 && result.skipped.length === 0) {
      console.warn(`no migrations found in ${migrationsDir}`);
      return;
    }
    if (result.applied.length > 0) console.warn(`applied:\n  ${result.applied.join('\n  ')}`);
    if (result.skipped.length > 0) console.warn(`skipped (already applied):\n  ${result.skipped.join('\n  ')}`);
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
