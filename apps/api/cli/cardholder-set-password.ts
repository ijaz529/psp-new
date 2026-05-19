#!/usr/bin/env tsx
import { parseArgs } from 'node:util';
import { createKysely, createPool, dbConfigFromEnv } from '@psp-new/db';
import { hashPassword } from '@psp-new/portal-auth';

/**
 * Phase 22 — admin-only bootstrap for cardholder passwords.
 *
 * Usage: pnpm cardholder:set-password --email demo@example.com --password 'hunter2hunter2'
 *
 * Cardholders without a password row cannot sign in to /cardholder/signin.
 * This CLI is the only reset path until a forgot-password flow is built.
 */
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      email: { type: 'string', short: 'e' },
      password: { type: 'string', short: 'p' },
    },
    strict: true,
  });
  if (!values.email || !values.password) {
    console.error('usage: pnpm cardholder:set-password --email <email> --password <password>');
    process.exit(2);
  }

  const pool = createPool({ ...dbConfigFromEnv(), applicationName: 'cardholder-set-password' });
  const db = createKysely(pool);
  try {
    const ch = await db
      .selectFrom('paycore.cardholders')
      .select(['id', 'email'])
      .where('email', '=', values.email)
      .executeTakeFirst();
    if (!ch) {
      console.error(`cardholder with email "${values.email}" not found`);
      process.exit(2);
    }
    const passwordHash = hashPassword(values.password);
    await db.updateTable('paycore.cardholders').set({ password_hash: passwordHash }).where('id', '=', ch.id).execute();
    console.log(`password set for cardholder ${ch.id} (${ch.email})`);
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
