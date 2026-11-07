#!/usr/bin/env tsx
import { parseArgs } from 'node:util';
import { createKysely, createPool, dbConfigFromEnv } from '@psp-new/db';
import { newId } from '@psp-new/ids';
import { hashPassword } from '@psp-new/portal-auth';

/**
 * Seed a portal admin user. Use this once after `make migrate` to bootstrap
 * sign-in. Phase 9+ adds per-merchant user management via the portal itself.
 *
 * Phase 50 — the password comes from PORTAL_USER_PASSWORD, not a flag. pnpm
 * echoes the command line it is about to run, so `--password <value>` printed
 * the secret to the terminal every time; `pnpm --silent` hid it, but a flag
 * you have to remember is not a safe default. It is still visible in the
 * process list while this runs, which is fine on a developer's own machine
 * and is not a claim to be anything more.
 */
const PASSWORD_VAR = 'PORTAL_USER_PASSWORD';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      email: { type: 'string', short: 'e' },
      name: { type: 'string', short: 'n' },
    },
    strict: true,
  });
  const password = process.env[PASSWORD_VAR];
  if (!values.email || !values.name || !password) {
    console.error(
      `usage: ${PASSWORD_VAR}="<at-least-8-chars>" pnpm --filter @psp-new/portal user:create --email a@b.com --name "Admin"\n` +
        `  the password is read from ${PASSWORD_VAR} so it is never printed; set it in .env and \`set -a; source .env; set +a\` first`,
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
        password_hash: hashPassword(password),
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
