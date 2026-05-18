#!/usr/bin/env tsx
import { parseArgs } from 'node:util';
import { createKysely, createPool, dbConfigFromEnv } from '@psp-new/db';
import { newId } from '@psp-new/ids';
import { generatePan } from '@psp-new/issuing';

/**
 * Issue a new virtual card for an existing cardholder + product. Mints a Luhn-
 * valid PAN within the product's BIN range, creates per-card funded + holds
 * ledger accounts, and stores the row in paycore.cards. The PAN is printed
 * ONCE on stdout — operator must capture it.
 */
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      cardholder: { type: 'string', short: 'c' },
      product: { type: 'string', short: 'p' },
      exp: { type: 'string' }, // MMYY, default 12/2030
    },
    strict: true,
  });
  if (!values.cardholder || !values.product) {
    console.error('usage: pnpm card:issue --cardholder ch_<id> --product prod_<id> [--exp MMYY]');
    process.exit(2);
  }
  const cardholderId = values.cardholder;
  const productId = values.product;

  const expRaw = values.exp ?? '1230';
  if (!/^\d{4}$/.test(expRaw)) {
    console.error('--exp must be MMYY (4 digits)');
    process.exit(2);
  }
  const expMonth = expRaw.slice(0, 2);
  const expYear = `20${expRaw.slice(2)}`;

  const pool = createPool({ ...dbConfigFromEnv(), applicationName: 'card-issue-cli' });
  const db = createKysely(pool);
  try {
    const product = await db
      .selectFrom('paycore.card_products')
      .selectAll()
      .where('id', '=', productId)
      .executeTakeFirst();
    if (!product) {
      console.error(`product ${productId} not found`);
      process.exit(2);
    }
    const cardholder = await db
      .selectFrom('paycore.cardholders')
      .select(['id'])
      .where('id', '=', cardholderId)
      .executeTakeFirst();
    if (!cardholder) {
      console.error(`cardholder ${cardholderId} not found`);
      process.exit(2);
    }

    const pan = generatePan({ rangeLow: product.bin_range_low, rangeHigh: product.bin_range_high });
    const bin = pan.slice(0, 6);
    const last4 = pan.slice(-4);
    const cardId = newId('card');
    const fundedAcctId = newId('account');
    const holdsAcctId = newId('account');
    const panToken = newId('token'); // stored token id; for MVP we keep PAN in the print-once stdout

    await db.transaction().execute(async (trx) => {
      await trx
        .insertInto('ledger.accounts')
        .values([
          {
            id: fundedAcctId,
            code: 'cardholder_funded',
            type: 'ASSET',
            currency: product.currency,
            owner_kind: 'issuer',
            owner_id: cardId,
          },
          {
            id: holdsAcctId,
            code: 'cardholder_holds',
            type: 'LIABILITY',
            currency: product.currency,
            owner_kind: 'issuer',
            owner_id: cardId,
          },
        ])
        .execute();

      await trx
        .insertInto('paycore.cards')
        .values({
          id: cardId,
          product_id: product.id,
          cardholder_id: cardholderId,
          pan_token: panToken,
          bin,
          last4,
          exp_month: expMonth,
          exp_year: expYear,
          status: 'active',
          controls: {},
          funded_account_id: fundedAcctId,
          holds_account_id: holdsAcctId,
          created_at: new Date(),
        })
        .execute();
    });

    console.log('');
    console.log('================================ CARD ISSUED ================================');
    console.log(` id:           ${cardId}`);
    console.log(` cardholder:   ${cardholderId}`);
    console.log(` product:      ${product.id} (${product.name})`);
    console.log(` PAN:          ${pan}    ← shown only here`);
    console.log(` exp:          ${expMonth}/${expYear.slice(2)}`);
    console.log(` currency:     ${product.currency}`);
    console.log(` funded acct:  ${fundedAcctId}`);
    console.log(` holds acct:   ${holdsAcctId}`);
    console.log('==============================================================================');
    console.log('');
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
