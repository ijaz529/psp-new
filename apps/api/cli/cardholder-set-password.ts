#!/usr/bin/env tsx
import { parseArgs } from 'node:util';
import { createKysely, createPool, dbConfigFromEnv } from '@psp-new/db';
import { hashPassword } from '@psp-new/portal-auth';

/**
 * Phase 22 — admin-only bootstrap for cardholder passwords.
 *
 * Usage: CARDHOLDER_PASSWORD='…' pnpm cardholder:set-password --email demo@example.com
 *
 * Cardholders without a password row cannot sign in to /cardholder/signin.
 * This CLI is the only reset path until a forgot-password flow is built.
 *
 * Phase 50 — the password comes from CARDHOLDER_PASSWORD, not a flag, for the
 * same reason as the portal's user:create: pnpm echoes the command line it is
 * about to run, so `--password <value>` printed the secret every time.
 */
const PASSWORD_VAR = 'CARDHOLDER_PASSWORD';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      email: { type: 'string', short: 'e' },
    },
    strict: true,
  });
  const password = process.env[PASSWORD_VAR];
  if (!values.email || !password) {
    console.error(
      `usage: ${PASSWORD_VAR}="<password>" pnpm cardholder:set-password --email <email>\n` +
        `  the password is read from ${PASSWORD_VAR} so it is never printed`,
    );
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
    const passwordHash = hashPassword(password);
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
