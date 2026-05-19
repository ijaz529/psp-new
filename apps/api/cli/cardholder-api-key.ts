#!/usr/bin/env tsx
import { parseArgs } from 'node:util';
import { generateCardholderApiKey } from '@psp-new/api-keys';
import { createKysely, createPool, dbConfigFromEnv } from '@psp-new/db';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      cardholder: { type: 'string', short: 'c' },
      env: { type: 'string', short: 'e' },
    },
    strict: true,
  });
  if (!values.cardholder) {
    console.error('usage: pnpm cardholder:api-key --cardholder ch_... [--env test|live]');
    process.exit(2);
  }
  const env = (values.env ?? 'test') as 'test' | 'live';
  if (env !== 'test' && env !== 'live') {
    console.error('--env must be test or live');
    process.exit(2);
  }

  const pool = createPool({ ...dbConfigFromEnv(), applicationName: 'cardholder-api-key-cli' });
  const db = createKysely(pool);
  try {
    const ch = await db
      .selectFrom('paycore.cardholders')
      .select('id')
      .where('id', '=', values.cardholder)
      .executeTakeFirst();
    if (!ch) {
      console.error(`cardholder ${values.cardholder} not found`);
      process.exit(1);
    }
    const key = generateCardholderApiKey({ env });
    await db
      .insertInto('paycore.cardholder_api_keys')
      .values({
        id: key.id,
        cardholder_id: values.cardholder,
        env: key.env,
        prefix: key.prefix,
        sha256_hash: key.sha256Hash,
        created_at: new Date(),
        last_used_at: null,
        revoked_at: null,
      })
      .execute();
    console.log('CARDHOLDER API KEY CREATED');
    console.log(` id:         ${key.id}`);
    console.log(` cardholder: ${values.cardholder}`);
    console.log(` env:        ${key.env}`);
    console.log(` prefix:     ${key.prefix}`);
    console.log(` key:        ${key.raw}`);
    console.log('');
    console.log('Save the key — it will not be shown again.');
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
