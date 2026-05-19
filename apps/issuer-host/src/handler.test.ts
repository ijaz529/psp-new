import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Database, createKysely, createPool, dbConfigFromEnv, migrateUp } from '@psp-new/db';
import { newId } from '@psp-new/ids';
import { buildMessage, decode, encode } from '@psp-new/iso8583';
import { postJournal } from '@psp-new/ledger';
import { createLogger } from '@psp-new/logger';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routeIssuerMessage } from './handler.js';

/**
 * Phase 10 integration tests for the issuer-host handler. Gated by DATABASE_URL
 * so they no-op outside the compose stack. Mirrors the ledger and vault test
 * shape.
 */
const HAS_DB = !!process.env.DATABASE_URL;
const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', '..', '..', 'packages', 'db', 'migrations');

const PAN = '4111110009999991'; // in the seeded Strawberry Visa product
const BIN = '411111';
const LAST4 = '9991';

describe.skipIf(!HAS_DB)('issuer-host handler — integration', () => {
  let pool: ReturnType<typeof createPool>;
  let db: Kysely<Database>;
  const logger = createLogger({ service: 'issuer-host-test', level: 'warn' });

  let cardId: string;
  let fundedAcct: string;
  let holdsAcct: string;
  let settlementAcct: string;

  beforeAll(async () => {
    pool = createPool({ ...dbConfigFromEnv(), applicationName: 'issuer-host-test' });
    db = createKysely(pool);
    await migrateUp(pool, MIGRATIONS_DIR);

    const cardholderId = newId('cardholder');
    cardId = newId('card');
    fundedAcct = newId('account');
    holdsAcct = newId('account');

    await db.transaction().execute(async (trx) => {
      await trx
        .insertInto('paycore.cardholders')
        .values({
          id: cardholderId,
          email: `t-${Date.now()}@e.com`,
          full_name: 'Test',
          phone: null,
          status: 'active',
          created_at: new Date(),
        })
        .execute();
      const now = new Date();
      await trx
        .insertInto('ledger.accounts')
        .values([
          {
            id: fundedAcct,
            code: 'cardholder_funded',
            type: 'ASSET',
            currency: 'USD',
            owner_kind: 'issuer',
            owner_id: cardId,
            metadata: null,
            created_at: now,
          },
          {
            id: holdsAcct,
            code: 'cardholder_holds',
            type: 'ASSET',
            currency: 'USD',
            owner_kind: 'issuer',
            owner_id: cardId,
            metadata: null,
            created_at: now,
          },
        ])
        .execute();
      await trx
        .insertInto('paycore.cards')
        .values({
          id: cardId,
          product_id: 'prod_strawberry_visa_usd',
          cardholder_id: cardholderId,
          pan_token: newId('token'),
          bin: BIN,
          last4: LAST4,
          exp_month: '12',
          exp_year: '2030',
          status: 'active',
          controls: {},
          funded_account_id: fundedAcct,
          holds_account_id: holdsAcct,
          created_at: new Date(),
        })
        .execute();

      // Load $100 onto the card from the issuer_funded_pool.
      const poolAcct = await trx
        .selectFrom('ledger.accounts')
        .select('id')
        .where('code', '=', 'issuer_funded_pool')
        .where('currency', '=', 'USD')
        .where('owner_kind', '=', 'psp')
        .executeTakeFirstOrThrow();
      await postJournal(trx, {
        externalId: `test_load:${cardId}`,
        description: 'load 10000 USD',
        occurredAt: new Date(),
        postings: [
          { accountId: fundedAcct as never, amount: 10000n, currency: 'USD' },
          { accountId: poolAcct.id as never, amount: -10000n, currency: 'USD' },
        ],
      });
    });

    const s = await db
      .selectFrom('ledger.accounts')
      .select('id')
      .where('code', '=', 'issuer_settlement')
      .where('currency', '=', 'USD')
      .where('owner_kind', '=', 'psp')
      .executeTakeFirstOrThrow();
    settlementAcct = s.id;
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
  });

  function bal(acct: string): Promise<bigint> {
    return db
      .selectFrom('ledger.account_balances')
      .select('balance')
      .where('account_id', '=', acct)
      .executeTakeFirst()
      .then((r) => (r as { balance: bigint } | undefined)?.balance ?? 0n);
  }

  function makeAuth(mti: '0100' | '0200', stan: string, rrn: string, amount: number): string {
    return encode(
      buildMessage(mti, {
        2: PAN,
        3: '000000',
        4: amount.toString().padStart(12, '0'),
        7: '0101000000',
        11: stan,
        37: rrn,
        49: '840',
      }),
    );
  }
  function makeAdvice(mti: '0220' | '0420', stan: string, rrn: string): string {
    return encode(buildMessage(mti, { 11: stan, 37: rrn }));
  }

  it('0100 writes funded→holds only — no settlement movement', async () => {
    const stan = '100100';
    const rrn = '000000010100';
    const fundedBefore = await bal(fundedAcct);
    const holdsBefore = await bal(holdsAcct);
    const settleBefore = await bal(settlementAcct);

    const resp = decode(await routeIssuerMessage(makeAuth('0100', stan, rrn, 1500), { db, logger }));
    expect(resp.mti).toBe('0110');
    expect(resp.fields.get(39)).toBe('00');

    expect(await bal(fundedAcct)).toBe(fundedBefore - 1500n);
    expect(await bal(holdsAcct)).toBe(holdsBefore + 1500n);
    expect(await bal(settlementAcct)).toBe(settleBefore);

    const hold = await db
      .selectFrom('paycore.card_auth_holds')
      .selectAll()
      .where('stan', '=', stan)
      .where('rrn', '=', rrn)
      .executeTakeFirstOrThrow();
    expect(hold.resolved_at).toBeNull();
    expect(hold.resolved_reason).toBeNull();
  });

  it('0200 writes both legs in the same txn — funded→holds and holds→settlement', async () => {
    const stan = '100200';
    const rrn = '000000010200';
    const fundedBefore = await bal(fundedAcct);
    const holdsBefore = await bal(holdsAcct);
    const settleBefore = await bal(settlementAcct);

    const resp = decode(await routeIssuerMessage(makeAuth('0200', stan, rrn, 2500), { db, logger }));
    expect(resp.mti).toBe('0210');
    expect(resp.fields.get(39)).toBe('00');

    expect(await bal(fundedAcct)).toBe(fundedBefore - 2500n);
    expect(await bal(holdsAcct)).toBe(holdsBefore); // net zero (in then out)
    expect(await bal(settlementAcct)).toBe(settleBefore + 2500n);

    const hold = await db
      .selectFrom('paycore.card_auth_holds')
      .selectAll()
      .where('stan', '=', stan)
      .where('rrn', '=', rrn)
      .executeTakeFirstOrThrow();
    expect(hold.resolved_reason).toBe('captured');
  });

  it('0220 captures an open hold — settles + marks captured', async () => {
    const stan = '100220';
    const rrn = '000000010220';
    decode(await routeIssuerMessage(makeAuth('0100', stan, rrn, 1000), { db, logger }));
    const holdsAfterAuth = await bal(holdsAcct);
    const settleBefore = await bal(settlementAcct);

    const resp = decode(await routeIssuerMessage(makeAdvice('0220', stan, rrn), { db, logger }));
    expect(resp.mti).toBe('0230');
    expect(resp.fields.get(39)).toBe('00');

    expect(await bal(holdsAcct)).toBe(holdsAfterAuth - 1000n);
    expect(await bal(settlementAcct)).toBe(settleBefore + 1000n);

    const hold = await db
      .selectFrom('paycore.card_auth_holds')
      .selectAll()
      .where('stan', '=', stan)
      .where('rrn', '=', rrn)
      .executeTakeFirstOrThrow();
    expect(hold.resolved_reason).toBe('captured');
    expect(hold.resolved_at).not.toBeNull();
  });

  it('0420 reverses an open hold — returns to funded + marks reversed', async () => {
    const stan = '100420';
    const rrn = '000000010420';
    decode(await routeIssuerMessage(makeAuth('0100', stan, rrn, 800), { db, logger }));
    const fundedAfterAuth = await bal(fundedAcct);
    const holdsAfterAuth = await bal(holdsAcct);

    const resp = decode(await routeIssuerMessage(makeAdvice('0420', stan, rrn), { db, logger }));
    expect(resp.mti).toBe('0430');
    expect(resp.fields.get(39)).toBe('00');

    expect(await bal(fundedAcct)).toBe(fundedAfterAuth + 800n);
    expect(await bal(holdsAcct)).toBe(holdsAfterAuth - 800n);

    const hold = await db
      .selectFrom('paycore.card_auth_holds')
      .selectAll()
      .where('stan', '=', stan)
      .where('rrn', '=', rrn)
      .executeTakeFirstOrThrow();
    expect(hold.resolved_reason).toBe('reversed');
  });

  it('duplicate 0220 against an already-resolved hold → RC 94', async () => {
    const stan = '100094';
    const rrn = '000000010094';
    decode(await routeIssuerMessage(makeAuth('0100', stan, rrn, 500), { db, logger }));
    decode(await routeIssuerMessage(makeAdvice('0220', stan, rrn), { db, logger }));

    const resp = decode(await routeIssuerMessage(makeAdvice('0220', stan, rrn), { db, logger }));
    expect(resp.fields.get(39)).toBe('94');
  });

  it('0220 against unknown (stan,rrn) → RC 25', async () => {
    const resp = decode(await routeIssuerMessage(makeAdvice('0220', '999999', '999999999999'), { db, logger }));
    expect(resp.fields.get(39)).toBe('25');
  });

  it('0420 against unknown (stan,rrn) → RC 25', async () => {
    const resp = decode(await routeIssuerMessage(makeAdvice('0420', '888888', '888888888888'), { db, logger }));
    expect(resp.fields.get(39)).toBe('25');
  });
});
