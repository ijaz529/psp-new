import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Database, createKysely, createPool, dbConfigFromEnv, migrateUp } from '@psp-new/db';
import { newId } from '@psp-new/ids';
import { buildMessage, decode, encode } from '@psp-new/iso8583';
import { postJournal } from '@psp-new/ledger';
import { createLogger } from '@psp-new/logger';
import { type Kysely, sql } from 'kysely';
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

/**
 * card_auth_holds has a unique (stan, rrn), so the fixed pairs below collide
 * on any second run against the same dev database. A per-run prefix keeps
 * each test's literal readable while making the pair unique — the same
 * remedy the worker integration suite already uses.
 *
 * Eight digits of it, not four: at four the clock wrapped every 10 seconds,
 * so two runs started a multiple of 10s apart still collided.
 */
const RUN = String(Date.now() % 100_000_000).padStart(8, '0');
const rrn12 = (literal: string): string => `${RUN}${literal.slice(-4)}`;

const BIN = '411111'; // the seeded Strawberry Visa product's range

/**
 * findCardByPan (handler.ts:288) matches a card on bin + last4 alone, with
 * no ordering, so two cards sharing them are indistinguishable to it: with a
 * hardcoded PAN, a second run against the same database authorized against
 * whichever row Postgres returned first — the earlier run's card, whose
 * accounts are empty — and declined RC 51. Take a last4 nothing is using.
 *
 * Only the last4 varies: the PAN's first 9 digits stay 411111000, inside
 * prod_strawberry_visa_usd's 411111000–411111999 range, which is what
 * panInRange checks.
 */
async function claimFreeLast4(db: Kysely<Database>): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const last4 = String(Math.floor(Math.random() * 10_000)).padStart(4, '0');
    const taken = await db
      .selectFrom('paycore.cards')
      .select('id')
      .where('bin', '=', BIN)
      .where('last4', '=', last4)
      .executeTakeFirst();
    if (!taken) return last4;
  }
  throw new Error(`no free last4 left under BIN ${BIN} after 50 attempts — reset the dev database`);
}

let LAST4: string;
let PAN: string;

describe.skipIf(!HAS_DB)('issuer-host handler — integration', () => {
  let pool: ReturnType<typeof createPool>;
  let db: Kysely<Database>;
  const logger = createLogger({ service: 'issuer-host-test', level: 'warn' });

  let cardId: string;
  let fundedAcct: string;
  let holdsAcct: string;
  let settlementAcct: string;
  let poolAcctId: string;

  beforeAll(async () => {
    pool = createPool({ ...dbConfigFromEnv(), applicationName: 'issuer-host-test' });
    db = createKysely(pool);
    await migrateUp(pool, MIGRATIONS_DIR);

    LAST4 = await claimFreeLast4(db);
    PAN = `${BIN}000999${LAST4}`;

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
      poolAcctId = poolAcct.id;
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

  async function bal(acct: string): Promise<bigint> {
    // account_balances is a MATERIALIZED view that production refreshes on a
    // periodic job, so a journal this test just posted is not in it yet.
    await sql`refresh materialized view ledger.account_balances`.execute(db);
    const r = await db
      .selectFrom('ledger.account_balances')
      .select('balance')
      .where('account_id', '=', acct)
      .executeTakeFirst();
    return (r as { balance: bigint } | undefined)?.balance ?? 0n;
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
  function makeAdvice(mti: '0220' | '0420', stan: string, rrn: string, amount = 0): string {
    return encode(
      buildMessage(mti, {
        11: stan,
        37: rrn,
        ...(amount > 0 ? { 4: amount.toString().padStart(12, '0') } : {}),
      }),
    );
  }

  it('0100 writes funded→holds only — no settlement movement', async () => {
    const stan = '100100';
    const rrn = rrn12('000000010100');
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
    const rrn = rrn12('000000010200');
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
    const rrn = rrn12('000000010220');
    decode(await routeIssuerMessage(makeAuth('0100', stan, rrn, 1000), { db, logger }));
    const holdsAfterAuth = await bal(holdsAcct);
    const settleBefore = await bal(settlementAcct);

    const resp = decode(await routeIssuerMessage(makeAdvice('0220', stan, rrn, 1000), { db, logger }));
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
    const rrn = rrn12('000000010420');
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

  it('0220 against an already-resolved hold → RC 94', async () => {
    const stan = '100094';
    const rrn = rrn12('000000010094');
    decode(await routeIssuerMessage(makeAuth('0100', stan, rrn, 500), { db, logger }));
    // First capture: full amount → hold marked captured.
    decode(await routeIssuerMessage(makeAdvice('0220', '100095', rrn, 500), { db, logger }));
    // Second capture against the now-resolved hold → RC 94.
    const resp = decode(await routeIssuerMessage(makeAdvice('0220', '100096', rrn, 100), { db, logger }));
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

  // ─── Phase 16: partial captures ─────────────────────────────────────────

  it('partial 0220 leaves hold open; subsequent 0220 sum-to-original marks captured', async () => {
    const rrn = rrn12('000000016001');
    decode(await routeIssuerMessage(makeAuth('0100', '160001', rrn, 1000), { db, logger }));
    const holdsAfterAuth = await bal(holdsAcct);
    const settleBefore = await bal(settlementAcct);

    // First partial: 300 / 1000.
    const r1 = decode(await routeIssuerMessage(makeAdvice('0220', '160002', rrn, 300), { db, logger }));
    expect(r1.fields.get(39)).toBe('00');
    let hold = await db
      .selectFrom('paycore.card_auth_holds')
      .selectAll()
      .where('rrn', '=', rrn)
      .executeTakeFirstOrThrow();
    expect(hold.captured_amount).toBe(300n);
    expect(hold.resolved_at).toBeNull();
    expect(hold.resolved_reason).toBeNull();
    expect(await bal(holdsAcct)).toBe(holdsAfterAuth - 300n);
    expect(await bal(settlementAcct)).toBe(settleBefore + 300n);

    // Second partial: 400 / 1000.
    const r2 = decode(await routeIssuerMessage(makeAdvice('0220', '160003', rrn, 400), { db, logger }));
    expect(r2.fields.get(39)).toBe('00');
    hold = await db.selectFrom('paycore.card_auth_holds').selectAll().where('rrn', '=', rrn).executeTakeFirstOrThrow();
    expect(hold.captured_amount).toBe(700n);
    expect(hold.resolved_at).toBeNull();

    // Final partial: 300 / 1000 → captured.
    const r3 = decode(await routeIssuerMessage(makeAdvice('0220', '160004', rrn, 300), { db, logger }));
    expect(r3.fields.get(39)).toBe('00');
    hold = await db.selectFrom('paycore.card_auth_holds').selectAll().where('rrn', '=', rrn).executeTakeFirstOrThrow();
    expect(hold.captured_amount).toBe(1000n);
    expect(hold.resolved_reason).toBe('captured');
    expect(hold.resolved_at).not.toBeNull();

    expect(await bal(holdsAcct)).toBe(holdsAfterAuth - 1000n);
    expect(await bal(settlementAcct)).toBe(settleBefore + 1000n);
  });

  it('0220 with amount > remaining → RC 13, no journal posted', async () => {
    const rrn = rrn12('000000016010');
    decode(await routeIssuerMessage(makeAuth('0100', '160010', rrn, 500), { db, logger }));
    // Capture 400 first — leaves 100 remaining.
    decode(await routeIssuerMessage(makeAdvice('0220', '160011', rrn, 400), { db, logger }));

    const holdsBefore = await bal(holdsAcct);
    const settleBefore = await bal(settlementAcct);

    // Try to capture 200 — exceeds the 100 remaining.
    const resp = decode(await routeIssuerMessage(makeAdvice('0220', '160012', rrn, 200), { db, logger }));
    expect(resp.fields.get(39)).toBe('13');

    // No journal effect; captured_amount unchanged at 400.
    expect(await bal(holdsAcct)).toBe(holdsBefore);
    expect(await bal(settlementAcct)).toBe(settleBefore);
    const hold = await db
      .selectFrom('paycore.card_auth_holds')
      .selectAll()
      .where('rrn', '=', rrn)
      .executeTakeFirstOrThrow();
    expect(hold.captured_amount).toBe(400n);
    expect(hold.resolved_at).toBeNull();
  });

  it('0420 after partial capture reverses ONLY the remaining', async () => {
    const rrn = rrn12('000000016020');
    decode(await routeIssuerMessage(makeAuth('0100', '160020', rrn, 1000), { db, logger }));
    // Partial capture of 600 — leaves 400 remaining.
    decode(await routeIssuerMessage(makeAdvice('0220', '160021', rrn, 600), { db, logger }));

    const fundedBeforeReversal = await bal(fundedAcct);
    const holdsBeforeReversal = await bal(holdsAcct);

    // Reversal: should return ONLY 400 (the uncaptured remainder).
    const resp = decode(await routeIssuerMessage(makeAdvice('0420', '160022', rrn), { db, logger }));
    expect(resp.fields.get(39)).toBe('00');

    expect(await bal(fundedAcct)).toBe(fundedBeforeReversal + 400n);
    expect(await bal(holdsAcct)).toBe(holdsBeforeReversal - 400n);

    const hold = await db
      .selectFrom('paycore.card_auth_holds')
      .selectAll()
      .where('rrn', '=', rrn)
      .executeTakeFirstOrThrow();
    expect(hold.resolved_reason).toBe('reversed');
    // captured_amount preserved at 600 — the partial that DID settle stays settled.
    expect(hold.captured_amount).toBe(600n);
  });

  // Phase 49. The balance the issuer decides on used to come from
  // ledger.account_balances, a MATERIALIZED view refreshed by a worker on a
  // 5-minute timer — so money loaded onto a card was unspendable until that
  // timer fired, and a brand-new account was not in the view at all. These
  // two deliberately never refresh it.
  describe('authorizes against the live ledger, not the materialized view', () => {
    /** Fund a fresh account for this card, leaving the view untouched. */
    async function fundWithoutRefreshing(amount: bigint): Promise<void> {
      await db.transaction().execute(async (trx) => {
        await postJournal(trx, {
          externalId: `live_bal_top_up:${cardId}:${amount}:${Date.now()}`,
          description: 'top-up the card without refreshing the view',
          occurredAt: new Date(),
          postings: [
            { accountId: fundedAcct as never, amount, currency: 'USD' },
            { accountId: poolAcctId as never, amount: -amount, currency: 'USD' },
          ],
        });
      });
    }

    async function liveFunded(): Promise<bigint> {
      const r = await db
        .selectFrom('ledger.journal_lines')
        .select((eb) => eb.fn.sum<string | null>('amount').as('total'))
        .where('account_id', '=', fundedAcct)
        .executeTakeFirst();
      return BigInt(r?.total ?? 0n);
    }

    it('approves against funds the view has not caught up with yet', async () => {
      const stan = '190100';
      const rrn = rrn12('000000019010');

      // Start from a view that is exactly right, then move money without
      // telling it. Asking for the whole live balance is the discriminator:
      // it is more than the view knows about, so a handler reading the view
      // declines RC 51 and one reading the ledger approves.
      await sql`refresh materialized view ledger.account_balances`.execute(db);
      await fundWithoutRefreshing(4000n);

      const live = await liveFunded();
      const view = await db
        .selectFrom('ledger.account_balances')
        .select('balance')
        .where('account_id', '=', fundedAcct)
        .executeTakeFirst();
      const viewBalance = BigInt((view as { balance?: bigint } | undefined)?.balance ?? 0n);
      expect(live).toBe(viewBalance + 4000n);

      const resp = decode(await routeIssuerMessage(makeAuth('0100', stan, rrn, Number(live)), { db, logger }));
      expect(resp.fields.get(39)).toBe('00');
    });

    it('still declines RC 51 over the live balance — the number is a limit, not a flag', async () => {
      const stan = '190051';
      const rrn = rrn12('000000019005');
      const overspend = Number(await liveFunded()) + 1;

      const resp = decode(await routeIssuerMessage(makeAuth('0100', stan, rrn, overspend), { db, logger }));
      expect(resp.fields.get(39)).toBe('51');
    });
  });
});
