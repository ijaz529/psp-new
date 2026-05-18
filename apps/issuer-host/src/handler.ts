import type { Database } from '@psp-new/db';
import { type ResourceId, newId } from '@psp-new/ids';
import { type Iso8583Message, buildMessage, decode, encode } from '@psp-new/iso8583';
import { type AuthDecision, evaluateAuthControls, mergeControls, panInRange } from '@psp-new/issuing';
import { postJournal } from '@psp-new/ledger';
import type { Logger } from '@psp-new/logger';
import { type Kysely, type Transaction, sql } from 'kysely';

export interface IssuerHandlerDeps {
  readonly db: Kysely<Database>;
  readonly logger: Logger;
}

/**
 * Build a 0110 response for the given 0100 request bytes.
 *
 * MVP simplification: every approved auth is settled in the same DB
 * transaction — the hold record is created with `resolved_reason='captured'`.
 * Real-world 0220 capture / 0420 reversal lifecycle is post-MVP. See
 * PHASE_9_DONE.md §Simplifications.
 *
 * Echoes back DE 3 (proc-code), DE 4 (amount), DE 7 (transmission timestamp),
 * DE 11 (STAN), DE 37 (RRN), DE 49 (currency). Sets DE 39 (RC) and DE 38
 * (approval code) per decision.
 */
export async function handleIssuerAuth(reqBytes: string, deps: IssuerHandlerDeps): Promise<string> {
  const req = decode(reqBytes);
  if (req.mti !== '0100' && req.mti !== '0200') {
    return encode(buildMessage('0110', { 39: '96' }));
  }

  const pan = (req.fields.get(2) as string | undefined) ?? '';
  const amount = Number.parseInt((req.fields.get(4) as string | undefined) ?? '0', 10);
  const stan = (req.fields.get(11) as string | undefined) ?? '000000';
  const rrn = (req.fields.get(37) as string | undefined) ?? '000000000000';
  const mcc = (req.fields.get(18) as string | undefined) ?? null;
  const acceptor = (req.fields.get(43) as string | undefined) ?? null;
  const currency = isoNumericToAlpha((req.fields.get(49) as string | undefined) ?? '840');
  const respMti: Iso8583Message['mti'] = req.mti === '0200' ? '0210' : '0110';

  const card = await findCardByPan(deps.db, pan);
  if (!card) {
    deps.logger.warn({ bin: pan.slice(0, 6), last4: pan.slice(-4), stan }, 'issuer: unknown card');
    // RC 14 = invalid card number
    return encode(buildMessage(respMti, { ...echoFields(req), 39: '14' }));
  }

  const controls = mergeControls(card.default_controls as never, card.controls as never);
  const available = await readAvailableBalance(deps.db, card.funded_account_id, card.holds_account_id);
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

  // Approve — write the hold record + ledger entry atomically.
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
        resolved_at: new Date(),
        resolved_reason: 'captured',
      })
      .execute();

    const settlementAccountId = await resolveIssuerSettlement(trx, currency);

    // Cardholder pays. Sign convention: debit > 0, credit < 0.
    // funded is ASSET — crediting it (decrease) = negative
    // settlement is LIABILITY — debiting it (decrease on issuer's books) = positive
    // The two sum to zero. We treat the cardholder paying as a debit to the
    // settlement liability (we now owe the rest of the world less) and a
    // credit to the cardholder's asset balance.
    await postJournal(trx, {
      externalId: `issuer_auth:${holdId}`,
      description: `issuer auth ${card.id} ${currency} ${amount}`,
      occurredAt: new Date(),
      postings: [
        {
          accountId: card.funded_account_id as ResourceId<'account'>,
          amount: -BigInt(amount),
          currency,
        },
        {
          accountId: settlementAccountId as ResourceId<'account'>,
          amount: BigInt(amount),
          currency,
        },
      ],
    });
  });

  deps.logger.info({ card: card.id, stan, amount, currency, approvalCode }, 'issuer: auth approved');
  return encode(
    buildMessage(respMti, {
      ...echoFields(req),
      38: approvalCode,
      39: '00',
    }),
  );
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
  // BIN+last4 is unique enough for our test BIN slices.
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

async function readAvailableBalance(
  db: Kysely<Database>,
  fundedAccountId: string,
  holdsAccountId: string,
): Promise<number> {
  // ledger.account_balances stores a signed sum of postings. For the cardholder's
  // asset account, fewer debits = lower balance (credits drove it down). The
  // available figure is funded_balance + holds_balance because the holds account
  // is a liability sibling whose balance is what was reserved.
  const funded = (await db
    .selectFrom('ledger.account_balances')
    .select(['balance'])
    .where('account_id', '=', fundedAccountId)
    .executeTakeFirst()) as { balance: bigint } | undefined;
  const holds = (await db
    .selectFrom('ledger.account_balances')
    .select(['balance'])
    .where('account_id', '=', holdsAccountId)
    .executeTakeFirst()) as { balance: bigint } | undefined;
  return Number(funded?.balance ?? 0n) - Number(holds?.balance ?? 0n);
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
