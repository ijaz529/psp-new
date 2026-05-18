#!/usr/bin/env tsx
import { parseArgs } from 'node:util';
import { createKysely, createPool, dbConfigFromEnv } from '@psp-new/db';
import { newId } from '@psp-new/ids';
import { hashPassword } from '@psp-new/portal-auth';

/**
 * Seed a portal admin user. Use this once after `make migrate` to bootstrap
 * sign-in. Phase 9+ adds per-merchant user management via the portal itself.
 */
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      email: { type: 'string', short: 'e' },
      name: { type: 'string', short: 'n' },
      password: { type: 'string', short: 'p' },
    },
    strict: true,
  });
  if (!values.email || !values.name || !values.password) {
    console.error(
      'usage: pnpm --filter @psp-new/portal user:create --email a@b.com --name "Admin" --password "<at-least-8-chars>"',
    );
    process.exit(2);
  }

  const pool = createPool({ ...dbConfigFromEnv(), applicationName: 'portal-user-create' });
  const db = createKysely(pool);
  try {
    const id = newId('outbox_event').replace('oe_', 'pu_');
    await db
      .insertInto('paycore.portal_users')
      .values({
        id,
        email: values.email,
        display_name: values.name,
        password_hash: hashPassword(values.password),
        totp_secret: null,
        is_admin: true,
        created_at: new Date(),
        last_login_at: null,
        disabled_at: null,
      })
      .execute();
    console.log(`created portal user ${values.email} (${id})`);
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
