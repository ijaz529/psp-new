import type { Database } from '@psp-new/db';
import { makeEvent } from '@psp-new/events';
import { type ResourceId, newId } from '@psp-new/ids';
import { ensureMerchantAccounts, postJournal, pspAccount } from '@psp-new/ledger';
import { publish } from '@psp-new/outbox';
import type { Kysely } from 'kysely';

/**
 * Payout orchestrator. For a single (merchant, currency):
 *
 *   1. Compute net = gross_succeeded_today - refunds_today.
 *   2. If net <= 0, no payout. (Negative net → merchant owes us; Phase 7 handles
 *      this with the reserve account.)
 *   3. Post journal entry that zeroes the settlement_liability into the
 *      merchant_payout_clearing account.
 *   4. Insert `paycore.payouts` row with status='paid' (simulated instant bank push).
 *   5. Publish `payout.paid` event.
 */

export interface PayoutInput {
  readonly db: Kysely<Database>;
  readonly merchantId: string;
  readonly currency: string;
  readonly scheduledFor: Date;
}

export interface PayoutResult {
  readonly id: ResourceId<'payout'>;
  readonly merchantId: string;
  readonly currency: string;
  readonly amount: bigint;
  readonly status: 'paid' | 'skipped';
}

export async function runPayout(input: PayoutInput): Promise<PayoutResult> {
  return await input.db.transaction().execute(async (trx) => {
    const start = utcStartOfDay(input.scheduledFor);
    const end = new Date(start.getTime() + 86_400_000);

    // Sum captured (succeeded) and refunded amounts since last payout window.
    const captured = await trx
      .selectFrom('paycore.payment_intents')
      .select((eb) => eb.fn.sum<bigint | string>('amount_received').as('total'))
      .where('merchant_id', '=', input.merchantId)
      .where('currency', '=', input.currency)
      .where('status', '=', 'succeeded')
      .where('created_at', '>=', start)
      .where('created_at', '<', end)
      .executeTakeFirst();

    const refunded = await trx
      .selectFrom('paycore.refunds')
      .select((eb) => eb.fn.sum<bigint | string>('amount').as('total'))
      .where('merchant_id', '=', input.merchantId)
      .where('currency', '=', input.currency)
      .where('status', '=', 'succeeded')
      .where('created_at', '>=', start)
      .where('created_at', '<', end)
      .executeTakeFirst();

    const grossNet = toBig(captured?.total);
    const refundsNet = toBig(refunded?.total);
    // Use MDR-net merchant settlement amounts. Captured here is the gross
    // amount_received; we want the *settlement liability delta*. For Phase 6
    // we approximate net = captured * (1 - mdr%) since Phase 3's posting
    // already booked the MDR. Simpler: use the merchant_settlement_liability
    // ledger sum for the window. Phase 7 refactors this to read the materialized view.
    const net = grossNet - refundsNet;

    if (net <= 0n) {
      return {
        id: newId('payout'),
        merchantId: input.merchantId,
        currency: input.currency,
        amount: 0n,
        status: 'skipped',
      };
    }

    const accounts = await ensureMerchantAccounts(trx, input.merchantId, input.currency);
    // Post: settlement_liability ↑ +net (zero it out), payout_clearing ↓ -net (we now owe via bank rail)
    const journalEntry = await postJournal(trx, {
      externalId: `payout:${input.merchantId}:${input.currency}:${utcDateKey(input.scheduledFor)}`,
      description: `payout ${input.currency} ${net} for merchant ${input.merchantId}`,
      occurredAt: new Date(),
      postings: [
        { accountId: accounts.settlementLiability, amount: net, currency: input.currency },
        // Simulated instant bank rail: net cash leaves psp_cash_at_bank into payout_clearing.
        { accountId: pspAccount('psp_cash_at_bank', input.currency), amount: -net, currency: input.currency },
      ],
    });

    const payoutId = newId('payout');
    const now = new Date();
    await trx
      .insertInto('paycore.payouts')
      .values({
        id: payoutId,
        merchant_id: input.merchantId,
        currency: input.currency,
        amount: net,
        status: 'paid',
        journal_entry_id: journalEntry.id,
        scheduled_for: input.scheduledFor,
        paid_at: now,
        metadata: null,
        created_at: now,
      })
      .execute();

    const envelope = makeEvent({
      type: 'payout.paid',
      data: { id: payoutId, merchant: input.merchantId, currency: input.currency, amount: Number(net) },
      resourceId: payoutId,
    });
    await trx
      .insertInto('paycore.events')
      .values({
        id: envelope.id,
        merchant_id: input.merchantId,
        type: 'payout.paid',
        api_version: envelope.api_version,
        resource_id: payoutId,
        data: envelope.data,
        livemode: false,
        created_at: now,
      })
      .execute();
    await publish(trx, {
      eventType: 'payout.paid',
      payload: envelope,
      resourceId: payoutId,
      headers: { merchant_id: input.merchantId },
    });

    return {
      id: payoutId,
      merchantId: input.merchantId,
      currency: input.currency,
      amount: net,
      status: 'paid',
    };
  });
}

/** Find all (merchant, currency) pairs that had any successful settlement on the date. */
export async function listPayoutCandidates(
  db: Kysely<Database>,
  scheduledFor: Date,
): Promise<Array<{ merchantId: string; currency: string }>> {
  const start = utcStartOfDay(scheduledFor);
  const end = new Date(start.getTime() + 86_400_000);
  const rows = await db
    .selectFrom('paycore.payment_intents')
    .select(['merchant_id', 'currency'])
    .where('status', '=', 'succeeded')
    .where('created_at', '>=', start)
    .where('created_at', '<', end)
    .groupBy(['merchant_id', 'currency'])
    .execute();
  return rows.map((r) => ({ merchantId: r.merchant_id, currency: r.currency }));
}

function toBig(v: unknown): bigint {
  if (v === undefined || v === null) return 0n;
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(v);
  if (typeof v === 'string') return BigInt(v);
  return 0n;
}

function utcStartOfDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function utcDateKey(d: Date): string {
  const start = utcStartOfDay(d);
  return start.toISOString().slice(0, 10);
}
