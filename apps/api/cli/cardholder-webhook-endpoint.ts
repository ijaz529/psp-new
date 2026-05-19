#!/usr/bin/env tsx
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { createKysely, createPool, dbConfigFromEnv } from '@psp-new/db';
import { newId } from '@psp-new/ids';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      cardholder: { type: 'string', short: 'c' },
      url: { type: 'string', short: 'u' },
      events: { type: 'string', short: 'e' },
      description: { type: 'string', short: 'd' },
    },
    strict: true,
  });
  if (!values.cardholder || !values.url) {
    console.error(
      'usage: pnpm cardholder:webhook --cardholder <ch_...> --url <url> [--events card_load.*,card.*] [--description <text>]',
    );
    process.exit(2);
  }
  const enabledEvents = values.events
    ? values.events
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : ['*'];

  const pool = createPool({ ...dbConfigFromEnv(), applicationName: 'cardholder-webhook-cli' });
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
    const id = newId('webhook_endpoint');
    const secret = `whsec_${randomBytes(32).toString('hex')}`;
    await db
      .insertInto('paycore.webhook_endpoints')
      .values({
        id,
        merchant_id: null,
        cardholder_id: values.cardholder,
        url: values.url,
        description: values.description ?? null,
        enabled_events: enabledEvents,
        signing_secret: secret,
        status: 'enabled',
        created_at: new Date(),
        disabled_at: null,
      })
      .execute();
    console.log('CARDHOLDER WEBHOOK ENDPOINT CREATED');
    console.log(` id:             ${id}`);
    console.log(` cardholder:     ${values.cardholder}`);
    console.log(` url:            ${values.url}`);
    console.log(` enabled_events: ${enabledEvents.join(',')}`);
    console.log(` secret:         ${secret}`);
    console.log('');
    console.log('Save the secret — it will not be shown again.');
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
