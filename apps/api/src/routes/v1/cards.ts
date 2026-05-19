import { PspError } from '@psp-new/errors';
import { isSupportedCurrency } from '@psp-new/money';
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
