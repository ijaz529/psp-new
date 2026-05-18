#!/usr/bin/env tsx
import { parseArgs } from 'node:util';
import { type Database, createKysely, createPool, dbConfigFromEnv } from '@psp-new/db';
import type { ResourceId } from '@psp-new/ids';
import { postJournal } from '@psp-new/ledger';
import type { Kysely } from 'kysely';

/**
 * Load funds onto an issued card.
 * Posts:
 *   DR  card.funded_account_id        amount
 *   CR  issuer_funded_pool(currency)  amount
 *
 * Sign convention: DR > 0, CR < 0. Amount is in minor units.
 */
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      card: { type: 'string', short: 'c' },
      amount: { type: 'string', short: 'a' }, // decimal in major units, e.g. "100.00"
    },
    strict: true,
  });
  if (!values.card || !values.amount) {
    console.error('usage: pnpm card:load --card card_<id> --amount 100.00');
    process.exit(2);
  }

  const amountMinor = parseMajorToMinor(values.amount);
  if (amountMinor <= 0n) {
    console.error('amount must be > 0');
    process.exit(2);
  }

  const pool = createPool({ ...dbConfigFromEnv(), applicationName: 'card-load-cli' });
  const db = createKysely(pool);
  try {
    const card = await db
      .selectFrom('paycore.cards')
      .innerJoin('paycore.card_products', 'paycore.card_products.id', 'paycore.cards.product_id')
      .select([
        'paycore.cards.id as id',
        'paycore.cards.funded_account_id as funded_account_id',
        'paycore.card_products.currency as currency',
      ])
      .where('paycore.cards.id', '=', values.card)
      .executeTakeFirst();
    if (!card) {
      console.error(`card ${values.card} not found`);
      process.exit(2);
    }

    const fundingPoolId = await resolveFundingPool(db, card.currency);

    await db.transaction().execute(async (trx) => {
      await postJournal(trx, {
        externalId: `card_load:${card.id}:${Date.now()}`,
        description: `card load ${card.id} ${card.currency} ${amountMinor}`,
        occurredAt: new Date(),
        postings: [
          {
            accountId: card.funded_account_id as ResourceId<'account'>,
            amount: amountMinor,
            currency: card.currency,
          },
          {
            accountId: fundingPoolId as ResourceId<'account'>,
            amount: -amountMinor,
            currency: card.currency,
          },
        ],
      });
    });

    console.log(`loaded ${values.amount} ${card.currency} to ${card.id}`);
  } finally {
    await pool.end();
  }
}

function parseMajorToMinor(s: string): bigint {
  if (!/^\d+(\.\d{1,2})?$/.test(s)) throw new Error(`bad amount "${s}" — expect e.g. "100.00"`);
  const [whole, frac = ''] = s.split('.');
  const padded = (frac + '00').slice(0, 2);
  return BigInt(whole) * 100n + BigInt(padded);
}

async function resolveFundingPool(db: Kysely<Database>, currency: string): Promise<string> {
  const row = await db
    .selectFrom('ledger.accounts')
    .select(['id'])
    .where('code', '=', 'issuer_funded_pool')
    .where('currency', '=', currency)
    .where('owner_kind', '=', 'psp')
    .executeTakeFirst();
  if (!row) throw new Error(`no issuer_funded_pool seeded for ${currency}`);
  return row.id;
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
