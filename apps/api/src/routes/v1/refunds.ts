import { PspError } from '@psp-new/errors';
import { createRefund } from '@psp-new/payment-engine';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getMerchantId } from '../../lib/auth-helpers.js';
import type { AppContext } from '../../lib/context.js';
import { refundToWire } from '../../lib/wire.js';

const CreateBody = z.object({
  payment_intent: z.string().regex(/^pi_/),
  amount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  reason: z.enum(['requested_by_customer', 'duplicate', 'fraudulent', 'expired_uncaptured_charge']).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export function registerRefunds(app: FastifyInstance, ctx: AppContext): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.post('/v1/refunds', {
    config: { requireApiKeyKind: 'secret' },
    schema: { body: CreateBody },
    handler: async (req, reply) => {
      const merchantId = getMerchantId(req);
      const body = req.body as z.infer<typeof CreateBody>;
      // Resolve PaymentIntent + its scheme.
      const pi = await ctx.db
        .selectFrom('paycore.payment_intents')
        .leftJoin('paycore.payment_methods', 'paycore.payment_methods.id', 'paycore.payment_intents.payment_method_id')
        .select([
          'paycore.payment_intents.id as id',
          'paycore.payment_intents.amount_received as amount_received',
          'paycore.payment_methods.scheme as scheme',
        ])
        .where('paycore.payment_intents.id', '=', body.payment_intent)
        .where('paycore.payment_intents.merchant_id', '=', merchantId)
        .executeTakeFirst();
      if (!pi) throw new PspError('resource_missing', { param: 'payment_intent' });
      const refundAmount = body.amount ? BigInt(body.amount) : pi.amount_received;
      const scheme = (pi.scheme as 'visa' | 'mastercard' | 'amex' | null) ?? 'visa';
      const r = await createRefund(ctx.db, {
        merchantId,
        paymentIntentId: body.payment_intent,
        amount: refundAmount,
        scheme,
        ...(body.reason ? { reason: body.reason } : {}),
        ...(body.metadata ? { metadata: body.metadata } : {}),
      });
      reply.status(201);
      return refundToWire(r);
    },
  });

  typed.get('/v1/refunds/:id', {
    config: { requireApiKeyKind: 'secret' },
    schema: { params: z.object({ id: z.string().regex(/^re_/) }) },
    handler: async (req) => {
      const merchantId = getMerchantId(req);
      const { id } = req.params as { id: string };
      const row = await ctx.db
        .selectFrom('paycore.refunds')
        .selectAll()
        .where('id', '=', id)
        .where('merchant_id', '=', merchantId)
        .executeTakeFirst();
      if (!row) throw new PspError('resource_missing');
      return refundToWire({
        id: row.id as `re_${string}`,
        paymentIntentId: row.payment_intent_id,
        amount: row.amount,
        currency: row.currency,
        status: row.status as 'succeeded',
        reason:
          (row.reason as 'requested_by_customer' | 'duplicate' | 'fraudulent' | 'expired_uncaptured_charge' | null) ??
          null,
        created: row.created_at,
        metadata: (row.metadata as Record<string, unknown> | null) ?? null,
      });
    },
  });
}
