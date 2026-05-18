import { VISA_REASON_CODES, openDispute, transitionDispute } from '@psp-new/disputes';
import { PspError } from '@psp-new/errors';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getMerchantId } from '../../lib/auth-helpers.js';
import type { AppContext } from '../../lib/context.js';

const OpenBody = z.object({
  payment_intent: z.string().regex(/^pi_/),
  reason_code: z.string(),
  amount: z.number().int().positive().optional(),
});

const TransitionBody = z.object({
  to_state: z.enum(['representment', 'won', 'lost', 'expired', 'pre_arbitration', 'arbitration']),
  evidence: z.record(z.unknown()).optional(),
});

export function registerDisputes(app: FastifyInstance, ctx: AppContext): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.post('/v1/disputes', {
    config: { requireApiKeyKind: 'secret' },
    schema: { body: OpenBody },
    handler: async (req, reply) => {
      const merchantId = getMerchantId(req);
      const body = req.body as z.infer<typeof OpenBody>;
      const pi = await ctx.db
        .selectFrom('paycore.payment_intents')
        .leftJoin('paycore.payment_methods', 'paycore.payment_methods.id', 'paycore.payment_intents.payment_method_id')
        .select([
          'paycore.payment_intents.amount_received as amount_received',
          'paycore.payment_intents.currency as currency',
          'paycore.payment_methods.scheme as scheme',
        ])
        .where('paycore.payment_intents.id', '=', body.payment_intent)
        .where('paycore.payment_intents.merchant_id', '=', merchantId)
        .executeTakeFirst();
      if (!pi) throw new PspError('resource_missing', { param: 'payment_intent' });
      const scheme = (pi.scheme as 'visa' | 'mastercard' | 'amex' | null) ?? 'visa';
      const amount = body.amount !== undefined ? BigInt(body.amount) : pi.amount_received;
      if (scheme === 'visa' && !VISA_REASON_CODES.has(body.reason_code)) {
        throw new PspError('parameter_invalid', {
          message: `unknown Visa reason code ${body.reason_code}`,
          param: 'reason_code',
        });
      }
      const { id } = await openDispute({
        db: ctx.db,
        merchantId,
        paymentIntentId: body.payment_intent,
        scheme,
        reasonCode: body.reason_code,
        amount,
        currency: pi.currency,
      });
      reply.status(201);
      return { id, object: 'dispute', state: 'first_chargeback' };
    },
  });

  typed.get('/v1/disputes/:id', {
    config: { requireApiKeyKind: 'secret' },
    schema: { params: z.object({ id: z.string().regex(/^dp_/) }) },
    handler: async (req) => {
      const merchantId = getMerchantId(req);
      const { id } = req.params as { id: string };
      const row = await ctx.db
        .selectFrom('paycore.disputes')
        .selectAll()
        .where('id', '=', id)
        .where('merchant_id', '=', merchantId)
        .executeTakeFirst();
      if (!row) throw new PspError('resource_missing');
      return {
        id: row.id,
        object: 'dispute',
        payment_intent: row.payment_intent_id,
        scheme: row.scheme,
        reason_code: row.reason_code,
        state: row.state,
        amount: Number(row.amount),
        currency: row.currency,
        evidence_due_at: row.evidence_due_at?.toISOString() ?? null,
        evidence: row.evidence ?? null,
        created: Math.floor(row.created_at.getTime() / 1000),
      };
    },
  });

  typed.post('/v1/disputes/:id/transition', {
    config: { requireApiKeyKind: 'secret' },
    schema: { params: z.object({ id: z.string().regex(/^dp_/) }), body: TransitionBody },
    handler: async (req) => {
      const merchantId = getMerchantId(req);
      const { id } = req.params as { id: string };
      const body = req.body as z.infer<typeof TransitionBody>;
      await transitionDispute(ctx.db, {
        id,
        merchantId,
        toState: body.to_state,
        ...(body.evidence ? { evidence: body.evidence } : {}),
      });
      return { id, state: body.to_state };
    },
  });
}
