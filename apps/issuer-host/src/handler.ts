import type { Database } from '@psp-new/db';
import { type ResourceId, newId } from '@psp-new/ids';
import { type Iso8583Message, type Mti, buildMessage, decode, encode } from '@psp-new/iso8583';
import { type AuthDecision, evaluateAuthControls, mergeControls, panInRange } from '@psp-new/issuing';
import { postJournal } from '@psp-new/ledger';
import type { Logger } from '@psp-new/logger';
import { type Kysely, type Transaction, sql } from 'kysely';

export interface IssuerHandlerDeps {
  readonly db: Kysely<Database>;
  readonly logger: Logger;
}

/**
 * Dispatch on MTI:
 *   - 0100 = authorization-only (hold)            → 0110
 *   - 0200 = combined auth + settle               → 0210
 *   - 0220 = capture against an existing hold     → 0230
 *   - 0420 = reversal of an existing hold         → 0430
 */
export async function routeIssuerMessage(reqBytes: string, deps: IssuerHandlerDeps): Promise<string> {
  const req = decode(reqBytes);
  switch (req.mti) {
    case '0100':
      return await handleAuth(req, deps, { settleImmediately: false });
    case '0200':
      return await handleAuth(req, deps, { settleImmediately: true });
    case '0220':
      return await handleCapture(req, deps);
    case '0420':
      return await handleReversal(req, deps);
    default:
      return encode(buildMessage('0110', { 39: '96' }));
  }
}

// Backwards-compatible name preserved for the Phase 9 tests / other callers.
export const handleIssuerAuth = routeIssuerMessage;

/* -------------------------------------------------------------------------- */
/* 0100 / 0200 — authorize                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 0100: write hold (funded → holds). Hold stays open for 0220/0420.
 * 0200: write hold AND settle in the same DB transaction. Hold rows still get
 *       written (audit trail) but `resolved_reason='captured'` immediately.
 */
async function handleAuth(
  req: Iso8583Message,
  deps: IssuerHandlerDeps,
  opts: { settleImmediately: boolean },
): Promise<string> {
  const respMti: Mti = req.mti === '0200' ? '0210' : '0110';

  const pan = (req.fields.get(2) as string | undefined) ?? '';
  const amount = Number.parseInt((req.fields.get(4) as string | undefined) ?? '0', 10);
  const stan = (req.fields.get(11) as string | undefined) ?? '000000';
  const rrn = (req.fields.get(37) as string | undefined) ?? '000000000000';
  const mcc = (req.fields.get(18) as string | undefined) ?? null;
  const acceptor = (req.fields.get(43) as string | undefined) ?? null;
  const currency = isoNumericToAlpha((req.fields.get(49) as string | undefined) ?? '840');

  const card = await findCardByPan(deps.db, pan);
  if (!card) {
    deps.logger.warn({ bin: pan.slice(0, 6), last4: pan.slice(-4), stan }, 'issuer: unknown card');
    return encode(buildMessage(respMti, { ...echoFields(req), 39: '14' }));
  }

  const controls = mergeControls(card.default_controls as never, card.controls as never);
  const available = await readAvailableBalance(deps.db, card.funded_account_id);
  const today = await todayHoldsSum(deps.db, card.id);

  const decision: AuthDecision = evaluateAuthControls(
    { status: card.status, currency: card.currency, controls },
    { amount, currency, mcc },
    { available, todayHoldsSum: today },
  );

  if (decision.outcome === 'decline') {
    deps.logger.info({ card: card.id, stan, rc: decision.rc, reason: decision.reason }, 'issuer: auth declined');
    return encode(buildMessage(respMti, { ...echoFields(req), 39: decision.rc }));
  }

  const holdId = newId('card_auth_hold');
  const approvalCode = `APPR${stan.slice(-2)}`.slice(0, 6).padEnd(6, ' ');

  await deps.db.transaction().execute(async (trx) => {
    await trx
      .insertInto('paycore.card_auth_holds')
      .values({
        id: holdId,
        card_id: card.id,
        stan,
        rrn,
        amount: BigInt(amount),
        currency,
        merchant_name: acceptor,
        mcc,
        approval_code: approvalCode,
        created_at: new Date(),
        resolved_at: opts.settleImmediately ? new Date() : null,
        resolved_reason: opts.settleImmediately ? 'captured' : null,
      })
      .execute();

    // Leg 1 (always): move funds from funded → holds.
    await postJournal(trx, {
      externalId: `issuer_hold:${holdId}`,
      description: `issuer hold ${card.id} ${currency} ${amount}`,
      occurredAt: new Date(),
      postings: [
        { accountId: card.funded_account_id as ResourceId<'account'>, amount: -BigInt(amount), currency },
        { accountId: card.holds_account_id as ResourceId<'account'>, amount: BigInt(amount), currency },
      ],
    });

    // Leg 2 (only for 0200): immediately settle — holds → settlement.
    if (opts.settleImmediately) {
      const settlementAccountId = await resolveIssuerSettlement(trx, currency);
      await postJournal(trx, {
        externalId: `issuer_settle:${holdId}`,
        description: `issuer settle ${card.id} ${currency} ${amount}`,
        occurredAt: new Date(),
        postings: [
          { accountId: card.holds_account_id as ResourceId<'account'>, amount: -BigInt(amount), currency },
          { accountId: settlementAccountId as ResourceId<'account'>, amount: BigInt(amount), currency },
        ],
      });
    }
  });

  deps.logger.info(
    { card: card.id, stan, amount, currency, approvalCode, settled: opts.settleImmediately },
    'issuer: auth approved',
  );
  return encode(buildMessage(respMti, { ...echoFields(req), 38: approvalCode, 39: '00' }));
}

/* -------------------------------------------------------------------------- */
/* 0220 — capture against an existing hold                                    */
/* -------------------------------------------------------------------------- */

async function handleCapture(req: Iso8583Message, deps: IssuerHandlerDeps): Promise<string> {
  const respMti: Mti = '0230';
  const stan = (req.fields.get(11) as string | undefined) ?? '000000';
  const rrn = (req.fields.get(37) as string | undefined) ?? '000000000000';

  const hold = await findHoldByStanRrn(deps.db, stan, rrn);
  if (!hold) {
    deps.logger.warn({ stan, rrn }, 'issuer: capture for unknown auth');
    // RC 25 = unable to locate record on file
    return encode(buildMessage(respMti, { ...echoFields(req), 39: '25' }));
  }
  if (hold.resolved_at !== null) {
    deps.logger.info({ stan, rrn, hold: hold.id, prior: hold.resolved_reason }, 'issuer: duplicate capture');
    // RC 94 = duplicate transmission. Idempotency aid for retransmits.
    return encode(buildMessage(respMti, { ...echoFields(req), 39: '94' }));
  }

  await deps.db.transaction().execute(async (trx) => {
    const settlementAccountId = await resolveIssuerSettlement(trx, hold.currency);
    await postJournal(trx, {
      externalId: `issuer_capture:${hold.id}`,
      description: `issuer capture ${hold.card_id} ${hold.currency} ${hold.amount}`,
      occurredAt: new Date(),
      postings: [
        { accountId: hold.holds_account_id as ResourceId<'account'>, amount: -hold.amount, currency: hold.currency },
        { accountId: settlementAccountId as ResourceId<'account'>, amount: hold.amount, currency: hold.currency },
      ],
    });
    await trx
      .updateTable('paycore.card_auth_holds')
      .set({ resolved_at: new Date(), resolved_reason: 'captured' })
      .where('id', '=', hold.id)
      .execute();
  });

  deps.logger.info({ stan, rrn, hold: hold.id, amount: hold.amount.toString() }, 'issuer: capture posted');
  return encode(buildMessage(respMti, { ...echoFields(req), 39: '00' }));
}

/* -------------------------------------------------------------------------- */
/* 0420 — reversal of an existing hold                                        */
/* -------------------------------------------------------------------------- */

async function handleReversal(req: Iso8583Message, deps: IssuerHandlerDeps): Promise<string> {
  const respMti: Mti = '0430';
  const stan = (req.fields.get(11) as string | undefined) ?? '000000';
  const rrn = (req.fields.get(37) as string | undefined) ?? '000000000000';

  const hold = await findHoldByStanRrn(deps.db, stan, rrn);
  if (!hold) {
    deps.logger.warn({ stan, rrn }, 'issuer: reversal for unknown auth');
    return encode(buildMessage(respMti, { ...echoFields(req), 39: '25' }));
  }
  if (hold.resolved_at !== null) {
    deps.logger.info({ stan, rrn, hold: hold.id, prior: hold.resolved_reason }, 'issuer: duplicate reversal');
    return encode(buildMessage(respMti, { ...echoFields(req), 39: '94' }));
  }

  await deps.db.transaction().execute(async (trx) => {
    await postJournal(trx, {
      externalId: `issuer_reverse:${hold.id}`,
      description: `issuer reverse ${hold.card_id} ${hold.currency} ${hold.amount}`,
      occurredAt: new Date(),
      postings: [
        { accountId: hold.holds_account_id as ResourceId<'account'>, amount: -hold.amount, currency: hold.currency },
        { accountId: hold.funded_account_id as ResourceId<'account'>, amount: hold.amount, currency: hold.currency },
      ],
    });
    await trx
      .updateTable('paycore.card_auth_holds')
      .set({ resolved_at: new Date(), resolved_reason: 'reversed' })
      .where('id', '=', hold.id)
      .execute();
  });

  deps.logger.info({ stan, rrn, hold: hold.id, amount: hold.amount.toString() }, 'issuer: reversal posted');
  return encode(buildMessage(respMti, { ...echoFields(req), 39: '00' }));
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

interface CardLookup {
  id: string;
  status: 'active' | 'frozen' | 'cancelled';
  controls: unknown;
  funded_account_id: string;
  holds_account_id: string;
  cardholder_id: string;
  bin_range_low: string;
  bin_range_high: string;
  currency: string;
  default_controls: unknown;
}

async function findCardByPan(db: Kysely<Database>, pan: string): Promise<CardLookup | null> {
  const bin = pan.slice(0, 6);
  const last4 = pan.slice(-4);
  const rows = await db
    .selectFrom('paycore.cards')
    .innerJoin('paycore.card_products', 'paycore.card_products.id', 'paycore.cards.product_id')
    .where('paycore.cards.bin', '=', bin)
    .where('paycore.cards.last4', '=', last4)
    .select([
      'paycore.cards.id as id',
      'paycore.cards.status as status',
      'paycore.cards.controls as controls',
      'paycore.cards.funded_account_id as funded_account_id',
      'paycore.cards.holds_account_id as holds_account_id',
      'paycore.cards.cardholder_id as cardholder_id',
      'paycore.card_products.bin_range_low as bin_range_low',
      'paycore.card_products.bin_range_high as bin_range_high',
      'paycore.card_products.currency as currency',
      'paycore.card_products.default_controls as default_controls',
    ])
    .execute();
  for (const row of rows) {
    if (panInRange(pan, row.bin_range_low, row.bin_range_high)) return row as CardLookup;
  }
  return null;
}

interface HoldLookup {
  id: string;
  card_id: string;
  amount: bigint;
  currency: string;
  resolved_at: Date | null;
  resolved_reason: string | null;
  funded_account_id: string;
  holds_account_id: string;
}

async function findHoldByStanRrn(db: Kysely<Database>, stan: string, rrn: string): Promise<HoldLookup | null> {
  const row = await db
    .selectFrom('paycore.card_auth_holds')
    .innerJoin('paycore.cards', 'paycore.cards.id', 'paycore.card_auth_holds.card_id')
    .where('paycore.card_auth_holds.stan', '=', stan)
    .where('paycore.card_auth_holds.rrn', '=', rrn)
    .select([
      'paycore.card_auth_holds.id as id',
      'paycore.card_auth_holds.card_id as card_id',
      'paycore.card_auth_holds.amount as amount',
      'paycore.card_auth_holds.currency as currency',
      'paycore.card_auth_holds.resolved_at as resolved_at',
      'paycore.card_auth_holds.resolved_reason as resolved_reason',
      'paycore.cards.funded_account_id as funded_account_id',
      'paycore.cards.holds_account_id as holds_account_id',
    ])
    .executeTakeFirst();
  return (row as HoldLookup | undefined) ?? null;
}

async function readAvailableBalance(db: Kysely<Database>, fundedAccountId: string): Promise<number> {
  // Phase 10: funded is the spendable balance. Open holds have already moved
  // funds OUT of funded into the per-card holds account, so funded alone is
  // the right "available" figure. See PHASE_10_PLAN.md §Ledger changes.
  const funded = (await db
    .selectFrom('ledger.account_balances')
    .select(['balance'])
    .where('account_id', '=', fundedAccountId)
    .executeTakeFirst()) as { balance: bigint } | undefined;
  return Number(funded?.balance ?? 0n);
}

async function todayHoldsSum(db: Kysely<Database>, cardId: string): Promise<number> {
  const r = (await db
    .selectFrom('paycore.card_auth_holds')
    .select((eb) => eb.fn.sum<number>('amount').as('sum'))
    .where('card_id', '=', cardId)
    .where(sql<boolean>`created_at::date = current_date`)
    .executeTakeFirst()) as { sum: number | null } | undefined;
  return Number(r?.sum ?? 0);
}

async function resolveIssuerSettlement(trx: Transaction<Database>, currency: string): Promise<string> {
  const row = await trx
    .selectFrom('ledger.accounts')
    .select(['id'])
    .where('code', '=', 'issuer_settlement')
    .where('currency', '=', currency)
    .where('owner_kind', '=', 'psp')
    .executeTakeFirst();
  if (!row) throw new Error(`no issuer_settlement account seeded for ${currency}`);
  return row.id;
}

function echoFields(req: Iso8583Message): Record<number, string> {
  const out: Record<number, string> = {};
  for (const de of [3, 4, 7, 11, 37, 49]) {
    const v = req.fields.get(de) as string | undefined;
    if (v !== undefined) out[de] = v;
  }
  return out;
}

const NUMERIC_TO_ALPHA: ReadonlyMap<string, string> = new Map([
  ['840', 'USD'],
  ['978', 'EUR'],
  ['826', 'GBP'],
  ['784', 'AED'],
  ['356', 'INR'],
]);

function isoNumericToAlpha(numeric: string): string {
  return NUMERIC_TO_ALPHA.get(numeric) ?? 'USD';
}
