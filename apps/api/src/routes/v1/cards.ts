import { PspError } from '@psp-new/errors';
import type { ResourceId } from '@psp-new/ids';
import { postJournal, pspAccount } from '@psp-new/ledger';
import { isSupportedCurrency } from '@psp-new/money';
import { publishCardholderEvent } from '@psp-new/outbox';
import { type CardLoadRecord, loadCard } from '@psp-new/payment-engine';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getMerchantId } from '../../lib/auth-helpers.js';
import type { AppContext } from '../../lib/context.js';
import { bigintToWire, dateToUnix } from '../../lib/serialize.js';

const LoadBody = z.object({
  amount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  currency: z.string().length(3),
  payment_method: z.string().regex(/^pm_/),
});

export function registerCards(app: FastifyInstance, ctx: AppContext): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.post('/v1/cards/:id/load', {
    config: { requireApiKeyKind: 'secret' },
    schema: {
      params: z.object({ id: z.string().regex(/^card_/) }),
      body: LoadBody,
    },
    handler: async (req, reply) => {
      const merchantId = getMerchantId(req);
      const { id } = req.params as { id: string };
      const body = req.body as z.infer<typeof LoadBody>;
      if (!isSupportedCurrency(body.currency)) {
        throw new PspError('currency_unsupported', { param: 'currency' });
      }

      const result = await loadCard(ctx.db, {
        cardId: id,
        merchantId,
        paymentMethodId: body.payment_method,
        amountMinor: BigInt(body.amount),
        currency: body.currency,
        authorizer: ctx.authorizer,
      });

      if (result.status === 'failed') {
        // Surfacing the decline through the same error taxonomy as a PI auth fail.
        // The card_loads row was already written for audit.
        throw new PspError('card_declined', {
          message: result.failureMessage ?? `acquirer response ${result.responseCode}`,
          declineCode: result.failureCode ?? 'card_declined',
          internal: { cardLoadId: result.id, responseCode: result.responseCode },
        });
      }

      reply.status(201);
      return cardLoadToWire(result);
    },
  });

  // Phase 25 — card-load chargeback / refund.
  typed.post('/v1/card_loads/:id/refund', {
    config: { requireApiKeyKind: 'secret' },
    schema: { params: z.object({ id: z.string().regex(/^cl_/) }) },
    handler: async (req) => {
      const merchantId = getMerchantId(req);
      const { id } = req.params as { id: string };

      // One join pulls the load, the funded account id, and the per-card
      // stored_value (if Phase 23 set one). Filter on payment_method.merchant
      // so the caller can only refund their own loads.
      const row = await ctx.db
        .selectFrom('paycore.card_loads')
        .innerJoin('paycore.payment_methods', 'paycore.payment_methods.id', 'paycore.card_loads.payment_method_id')
        .innerJoin('paycore.cards', 'paycore.cards.id', 'paycore.card_loads.card_id')
        .select([
          'paycore.card_loads.id as id',
          'paycore.card_loads.card_id as card_id',
          'paycore.card_loads.amount as amount',
          'paycore.card_loads.currency as currency',
          'paycore.card_loads.status as status',
          'paycore.card_loads.response_code as response_code',
          'paycore.card_loads.rrn as rrn',
          'paycore.card_loads.stan as stan',
          'paycore.card_loads.created_at as created_at',
          'paycore.cards.funded_account_id as funded_account_id',
          'paycore.cards.stored_value_account_id as stored_value_account_id',
          'paycore.cards.cardholder_id as cardholder_id',
        ])
        .where('paycore.card_loads.id', '=', id)
        .where('paycore.payment_methods.merchant_id', '=', merchantId)
        .executeTakeFirst();
      if (!row) throw new PspError('resource_missing');
      if (row.status !== 'succeeded') {
        throw new PspError('payment_intent_unexpected_state', {
          message: `card_load is ${row.status}; only succeeded loads can be refunded`,
        });
      }

      // Validate the cardholder still has the loaded balance available.
      const fundedBal = (await ctx.db
        .selectFrom('ledger.account_balances')
        .select('balance')
        .where('account_id', '=', row.funded_account_id)
        .executeTakeFirst()) as { balance: bigint } | undefined;
      const available = fundedBal?.balance ?? 0n;
      if (available < row.amount) {
        throw new PspError('amount_too_large', {
          message: `card has ${available} available; refund needs ${row.amount}`,
        });
      }

      // Route the +X credit leg to the per-card stored_value if Phase 23 set
      // one, else fall back to the PSP-level external_load_clearing (matches
      // the Phase 17 sweeper's fallback).
      const creditAccount = (row.stored_value_account_id ??
        pspAccount('external_load_clearing', row.currency)) as ResourceId<'account'>;

      await ctx.db.transaction().execute(async (trx) => {
        await postJournal(trx, {
          externalId: `card_load_refund:${row.id}`,
          description: `card-load refund ${row.id} ${row.currency} ${row.amount}`,
          occurredAt: new Date(),
          postings: [
            {
              accountId: row.funded_account_id as ResourceId<'account'>,
              amount: -row.amount,
              currency: row.currency,
            },
            { accountId: creditAccount, amount: row.amount, currency: row.currency },
          ],
        });
        await trx
          .updateTable('paycore.card_loads')
          .set({ status: 'refunded' })
          .where('id', '=', row.id)
          .where('status', '=', 'succeeded')
          .execute();
        await publishCardholderEvent(trx, {
          cardholderId: row.cardholder_id,
          type: 'card_load.refunded',
          resourceId: row.id,
          data: {
            id: row.id,
            object: 'card_load',
            card: row.card_id,
            amount: bigintToWire(row.amount),
            currency: row.currency,
            status: 'refunded',
            response_code: row.response_code,
            rrn: row.rrn,
            stan: row.stan,
          },
        });
      });

      return {
        id: row.id,
        object: 'card_load',
        card: row.card_id,
        amount: bigintToWire(row.amount),
        currency: row.currency,
        status: 'refunded',
        response_code: row.response_code,
        rrn: row.rrn,
        stan: row.stan,
        created: dateToUnix(row.created_at),
      };
    },
  });
}

function cardLoadToWire(r: CardLoadRecord): Record<string, unknown> {
  return {
    id: r.id,
    object: 'card_load',
    card: r.cardId,
    amount: bigintToWire(r.amountMinor),
    currency: r.currency,
    status: r.status,
    response_code: r.responseCode,
    rrn: r.rrn,
    stan: r.stan,
    created: dateToUnix(r.created),
  };
}
