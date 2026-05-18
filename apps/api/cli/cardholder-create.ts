#!/usr/bin/env tsx
import { parseArgs } from 'node:util';
import { createKysely, createPool, dbConfigFromEnv } from '@psp-new/db';
import { newId } from '@psp-new/ids';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      email: { type: 'string', short: 'e' },
      name: { type: 'string', short: 'n' },
      phone: { type: 'string', short: 'p' },
    },
    strict: true,
  });
  if (!values.email || !values.name) {
    console.error('usage: pnpm cardholder:create --email <e> --name <n> [--phone <p>]');
    process.exit(2);
  }

  const pool = createPool({ ...dbConfigFromEnv(), applicationName: 'cardholder-create-cli' });
  const db = createKysely(pool);
  try {
    const id = newId('cardholder');
    await db
      .insertInto('paycore.cardholders')
      .values({
        id,
        email: values.email,
        full_name: values.name,
        phone: values.phone ?? null,
        status: 'active',
        created_at: new Date(),
      })
      .execute();
    console.log('CARDHOLDER CREATED');
    console.log(` id:    ${id}`);
    console.log(` email: ${values.email}`);
    console.log(` name:  ${values.name}`);
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
