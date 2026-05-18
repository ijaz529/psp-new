import type { Database } from '@psp-new/db';
import { PspError } from '@psp-new/errors';
import { makeEvent } from '@psp-new/events';
import { newId } from '@psp-new/ids';
import { publish } from '@psp-new/outbox';
import type { Kysely } from 'kysely';

/**
 * Dispute lifecycle. State machine per ADR-0018:
 *
 *   retrieval_request → first_chargeback → representment → pre_arbitration
 *                                                       → arbitration → won | lost
 *
 *  - retrieval_request and pre_arbitration are optional steps.
 *  - `expired` is terminal — merchant did not respond within evidence_due_at.
 *  - Visa reason codes per ADR-0018 (Mastercard codes mapped Phase 9+).
 */

export type DisputeState =
  | 'retrieval_request'
  | 'first_chargeback'
  | 'representment'
  | 'pre_arbitration'
  | 'arbitration'
  | 'won'
  | 'lost'
  | 'expired';

export const VISA_REASON_CODES: ReadonlyMap<string, string> = new Map([
  ['visa_10.4', 'Other fraud — card-absent environment'],
  ['visa_11.2', 'Declined authorization'],
  ['visa_12.6.1', 'Duplicate processing'],
  ['visa_13.1', 'Merchandise/services not received'],
  ['visa_13.2', 'Cancelled recurring transaction'],
  ['visa_13.3', 'Not as described or defective merchandise'],
  ['visa_13.7', 'Cancelled merchandise/services'],
  ['visa_13.9', 'Non-receipt of cash or load transaction value'],
]);

const NEXT_STATES: ReadonlyMap<DisputeState, ReadonlyArray<DisputeState>> = new Map([
  ['retrieval_request', ['first_chargeback', 'expired']],
  ['first_chargeback', ['representment', 'lost', 'expired']],
  ['representment', ['won', 'pre_arbitration', 'lost']],
  ['pre_arbitration', ['arbitration', 'won', 'lost']],
  ['arbitration', ['won', 'lost']],
  ['won', []],
  ['lost', []],
  ['expired', []],
]);

export interface OpenDisputeInput {
  readonly db: Kysely<Database>;
  readonly merchantId: string;
  readonly paymentIntentId: string;
  readonly scheme: 'visa' | 'mastercard' | 'amex';
  readonly reasonCode: string;
  readonly amount: bigint;
  readonly currency: string;
  /** Evidence-due window. Default: 21 days (Visa standard for first chargeback). */
  readonly evidenceDueAt?: Date;
}

export async function openDispute(input: OpenDisputeInput): Promise<{ id: string }> {
  return await input.db.transaction().execute(async (trx) => {
    if (input.scheme === 'visa' && !VISA_REASON_CODES.has(input.reasonCode)) {
      throw new PspError('parameter_invalid', { message: `unknown Visa reason code ${input.reasonCode}` });
    }
    const id = newId('dispute');
    const now = new Date();
    const dueAt = input.evidenceDueAt ?? new Date(Date.now() + 21 * 86_400_000);
    await trx
      .insertInto('paycore.disputes')
      .values({
        id,
        merchant_id: input.merchantId,
        payment_intent_id: input.paymentIntentId,
        scheme: input.scheme,
        reason_code: input.reasonCode,
        state: 'first_chargeback',
        amount: input.amount,
        currency: input.currency,
        evidence_due_at: dueAt,
        evidence: null,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await trx
      .insertInto('paycore.dispute_events')
      .values({
        id: newId('dispute'),
        dispute_id: id,
        event_type: 'opened',
        data: { reason_code: input.reasonCode },
        created_at: now,
      })
      .execute();
    const envelope = makeEvent({
      type: 'dispute.opened',
      data: {
        id,
        payment_intent: input.paymentIntentId,
        amount: Number(input.amount),
        reason_code: input.reasonCode,
        scheme: input.scheme,
      },
      resourceId: id,
    });
    await trx
      .insertInto('paycore.events')
      .values({
        id: envelope.id,
        merchant_id: input.merchantId,
        type: 'dispute.opened',
        api_version: envelope.api_version,
        resource_id: id,
        data: envelope.data,
        livemode: false,
        created_at: now,
      })
      .execute();
    await publish(trx, {
      eventType: 'dispute.opened',
      payload: envelope,
      resourceId: id,
      headers: { merchant_id: input.merchantId },
    });
    return { id };
  });
}

export async function transitionDispute(
  db: Kysely<Database>,
  args: { id: string; merchantId: string; toState: DisputeState; evidence?: Record<string, unknown> },
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const current = await trx
      .selectFrom('paycore.disputes')
      .selectAll()
      .where('id', '=', args.id)
      .where('merchant_id', '=', args.merchantId)
      .forUpdate()
      .executeTakeFirst();
    if (!current) throw new PspError('resource_missing');
    const allowed = NEXT_STATES.get(current.state as DisputeState) ?? [];
    if (!allowed.includes(args.toState)) {
      throw new PspError('payment_intent_unexpected_state', {
        message: `dispute cannot transition ${current.state} → ${args.toState}`,
      });
    }
    const now = new Date();
    await trx
      .updateTable('paycore.disputes')
      .set({
        state: args.toState,
        evidence: args.evidence ?? current.evidence,
        updated_at: now,
      })
      .where('id', '=', args.id)
      .execute();
    await trx
      .insertInto('paycore.dispute_events')
      .values({
        id: newId('dispute'),
        dispute_id: args.id,
        event_type: args.toState,
        data: args.evidence ?? null,
        created_at: now,
      })
      .execute();
    // Emit terminal-state event for the merchant.
    if (args.toState === 'won' || args.toState === 'lost' || args.toState === 'expired') {
      const envelope = makeEvent({
        type: `dispute.${args.toState}`,
        data: { id: args.id, state: args.toState },
        resourceId: args.id,
      });
      await trx
        .insertInto('paycore.events')
        .values({
          id: envelope.id,
          merchant_id: args.merchantId,
          type: `dispute.${args.toState}`,
          api_version: envelope.api_version,
          resource_id: args.id,
          data: envelope.data,
          livemode: false,
          created_at: now,
        })
        .execute();
      await publish(trx, {
        eventType: `dispute.${args.toState}`,
        payload: envelope,
        resourceId: args.id,
        headers: { merchant_id: args.merchantId },
      });
    }
  });
}
