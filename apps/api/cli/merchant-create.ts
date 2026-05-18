#!/usr/bin/env tsx
import { parseArgs } from 'node:util';
import { generateApiKey } from '@psp-new/api-keys';
import { createKysely, createPool, dbConfigFromEnv } from '@psp-new/db';
import { newId } from '@psp-new/ids';

/**
 * Admin-only. Creates a merchant + a (pk, sk) key pair in one env (default: test).
 * Prints the raw keys ONCE — operator must copy them now.
 *
 * Usage:
 *   pnpm merchant:create --name "Acme Inc."
 *   pnpm merchant:create --name "Acme Inc." --env test
 */
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      name: { type: 'string', short: 'n' },
      env: { type: 'string', short: 'e', default: 'test' },
      'allowed-origins': { type: 'string', short: 'o' },
    },
    strict: true,
  });
  const name = values.name;
  if (!name) {
    console.error('usage: pnpm merchant:create --name "Merchant Name" [--env test|live] [--allowed-origins "<csv>"]');
    process.exit(2);
  }
  const env = values.env as 'test' | 'live';
  if (env !== 'test' && env !== 'live') {
    console.error("env must be 'test' or 'live'");
    process.exit(2);
  }
  const allowedOrigins = values['allowed-origins']
    ? values['allowed-origins']
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : ['http://localhost:3000', 'http://localhost:7001', 'http://localhost:8080'];

  const pool = createPool({ ...dbConfigFromEnv(), applicationName: 'merchant-create-cli' });
  const db = createKysely(pool);
  try {
    const merchantId = newId('merchant');
    const pk = generateApiKey({ kind: 'publishable', env });
    const sk = generateApiKey({ kind: 'secret', env });
    const now = new Date();

    await db.transaction().execute(async (trx) => {
      await trx
        .insertInto('paycore.merchants')
        .values({
          id: merchantId,
          name,
          env,
          allowed_origins: allowedOrigins,
          reserve_basis_points: 0,
          payout_schedule: 'daily',
          created_at: now,
        })
        .execute();
      await trx
        .insertInto('paycore.api_keys')
        .values([
          {
            id: pk.id,
            merchant_id: merchantId,
            kind: 'publishable',
            env,
            prefix: pk.prefix,
            sha256_hash: pk.sha256Hash,
            created_at: now,
            last_used_at: null,
            revoked_at: null,
          },
          {
            id: sk.id,
            merchant_id: merchantId,
            kind: 'secret',
            env,
            prefix: sk.prefix,
            sha256_hash: sk.sha256Hash,
            created_at: now,
            last_used_at: null,
            revoked_at: null,
          },
        ])
        .execute();
    });

    console.log('');
    console.log('================================ MERCHANT CREATED ================================');
    console.log(` id:    ${merchantId}`);
    console.log(` name:  ${name}`);
    console.log(` env:   ${env}`);
    console.log(` allowed_origins: ${allowedOrigins.join(', ')}`);
    console.log('');
    console.log(' Save these keys NOW. The secret key is shown only once.');
    console.log('');
    console.log(` publishable:  ${pk.raw}`);
    console.log(` secret:       ${sk.raw}`);
    console.log('==================================================================================');
    console.log('');
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
