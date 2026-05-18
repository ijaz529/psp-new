import { PspError } from '@psp-new/errors';
import { isSupportedCurrency } from '@psp-new/money';
import {
  cancelPaymentIntent,
  capturePaymentIntent,
  confirmPaymentIntent,
  createPaymentIntent,
} from '@psp-new/payment-engine';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getMerchantId } from '../../lib/auth-helpers.js';
import type { AppContext } from '../../lib/context.js';
import { paymentIntentToWire } from '../../lib/wire.js';

const CreateBody = z.object({
  amount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  currency: z.string().length(3),
  payment_method: z.string().regex(/^pm_/).optional(),
  customer: z.string().regex(/^cus_/).optional(),
  capture_method: z.enum(['automatic', 'manual']).optional(),
  confirmation_method: z.enum(['automatic', 'manual']).optional(),
  metadata: z.record(z.unknown()).optional(),
  confirm: z.boolean().optional(),
});

const ConfirmBody = z.object({
  payment_method: z.string().regex(/^pm_/).optional(),
});

export function registerPaymentIntents(app: FastifyInstance, ctx: AppContext): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  // --- CREATE -----------------------------------------------------------------
  typed.post('/v1/payment_intents', {
    config: { requireApiKeyKind: 'secret' },
    schema: { body: CreateBody },
    handler: async (req, reply) => {
      const merchantId = getMerchantId(req);
      const body = req.body as z.infer<typeof CreateBody>;
      if (!isSupportedCurrency(body.currency)) {
        throw new PspError('currency_unsupported', { param: 'currency' });
      }

      // Resolve scheme + bin from payment_method (if provided) — needed for journal + 3DS policy.
      let resolvedScheme: 'visa' | 'mastercard' | 'amex' = 'visa';
      let resolvedBin = '';
      if (body.payment_method) {
        const pm = await ctx.db
          .selectFrom('paycore.payment_methods')
          .select(['id', 'scheme', 'bin'])
          .where('id', '=', body.payment_method)
          .where('merchant_id', '=', merchantId)
          .executeTakeFirst();
        if (!pm)
          throw new PspError('resource_missing', { message: 'payment_method not found', param: 'payment_method' });
        if (pm.scheme === 'unknown') {
          throw new PspError('scheme_not_supported', { internal: { paymentMethodId: pm.id } });
        }
        resolvedScheme = pm.scheme as 'visa' | 'mastercard' | 'amex';
        resolvedBin = pm.bin;
      }

      const created = await createPaymentIntent(ctx.db, {
        merchantId,
        amount: BigInt(body.amount),
        currency: body.currency,
        captureMethod: body.capture_method ?? 'automatic',
        confirmationMethod: body.confirmation_method ?? 'automatic',
        ...(body.payment_method ? { paymentMethodId: body.payment_method } : {}),
        ...(body.customer ? { customerId: body.customer } : {}),
        ...(body.metadata ? { metadata: body.metadata } : {}),
        livemode: req.apiKeyEnv === 'live',
      });

      if (body.confirm) {
        const confirmed = await confirmPaymentIntent(ctx.db, {
          paymentIntentId: created.id,
          merchantId,
          scheme: resolvedScheme,
          bin: resolvedBin,
          threeDsRedirectBuilder: (sessionId) => `${ctx.schemeSimulatorPublicUrl}/3ds/challenge/${sessionId}`,
          authorizer: ctx.authorizer,
        });
        reply.status(201);
        return paymentIntentToWire(confirmed);
      }

      reply.status(201);
      return paymentIntentToWire(created);
    },
  });

  // --- GET --------------------------------------------------------------------
  typed.get('/v1/payment_intents/:id', {
    config: { requireApiKeyKind: 'secret' },
    schema: { params: z.object({ id: z.string().regex(/^pi_/) }) },
    handler: async (req) => {
      const merchantId = getMerchantId(req);
      const { id } = req.params as { id: string };
      const row = await ctx.db
        .selectFrom('paycore.payment_intents')
        .selectAll()
        .where('id', '=', id)
        .where('merchant_id', '=', merchantId)
        .executeTakeFirst();
      if (!row) throw new PspError('resource_missing');
      // Use payment-engine's record shape via a small inline mapper — keeps this file thin.
      return paymentIntentToWire({
        id: row.id as `pi_${string}`,
        merchantId: row.merchant_id,
        amount: row.amount,
        amountReceived: row.amount_received,
        amountCapturable: row.amount_capturable,
        currency: row.currency,
        status: row.status as never,
        captureMethod: row.capture_method as never,
        confirmationMethod: row.confirmation_method as never,
        clientSecret: row.client_secret,
        customerId: row.customer_id,
        paymentMethodId: row.payment_method_id,
        metadata: (row.metadata as Record<string, unknown> | null) ?? null,
        livemode: row.livemode,
        created: row.created_at,
        updated: row.updated_at,
        lastPaymentError: row.last_payment_error_code
          ? {
              code: row.last_payment_error_code,
              message: row.last_payment_error_message ?? '',
              ...(row.last_payment_error_decline_code ? { declineCode: row.last_payment_error_decline_code } : {}),
            }
          : null,
      });
    },
  });

  // --- CONFIRM ----------------------------------------------------------------
  typed.post('/v1/payment_intents/:id/confirm', {
    config: { requireApiKeyKind: 'secret' },
    schema: {
      params: z.object({ id: z.string().regex(/^pi_/) }),
      body: ConfirmBody.optional(),
    },
    handler: async (req) => {
      const merchantId = getMerchantId(req);
      const { id } = req.params as { id: string };
      const body = (req.body as z.infer<typeof ConfirmBody> | undefined) ?? {};

      // Attach payment_method first if supplied.
      if (body.payment_method) {
        const pm = await ctx.db
          .selectFrom('paycore.payment_methods')
          .select(['id', 'scheme'])
          .where('id', '=', body.payment_method)
          .where('merchant_id', '=', merchantId)
          .executeTakeFirst();
        if (!pm) throw new PspError('resource_missing', { param: 'payment_method' });
        await ctx.db
          .updateTable('paycore.payment_intents')
          .set({ payment_method_id: pm.id, status: 'requires_confirmation', updated_at: new Date() })
          .where('id', '=', id)
          .where('merchant_id', '=', merchantId)
          .execute();
      }

      // Resolve scheme + bin from the now-attached payment_method.
      const pi = await ctx.db
        .selectFrom('paycore.payment_intents')
        .leftJoin('paycore.payment_methods', 'paycore.payment_methods.id', 'paycore.payment_intents.payment_method_id')
        .select([
          'paycore.payment_intents.id as id',
          'paycore.payment_methods.scheme as scheme',
          'paycore.payment_methods.bin as bin',
        ])
        .where('paycore.payment_intents.id', '=', id)
        .where('paycore.payment_intents.merchant_id', '=', merchantId)
        .executeTakeFirst();
      if (!pi) throw new PspError('resource_missing');
      const scheme = (pi.scheme as 'visa' | 'mastercard' | 'amex' | null) ?? 'visa';
      const bin = pi.bin ?? '';

      const r = await confirmPaymentIntent(ctx.db, {
        paymentIntentId: id,
        merchantId,
        scheme,
        bin,
        threeDsRedirectBuilder: (sessionId) => `${ctx.schemeSimulatorPublicUrl}/3ds/challenge/${sessionId}`,
      });
      return paymentIntentToWire(r);
    },
  });

  // --- CAPTURE ----------------------------------------------------------------
  typed.post('/v1/payment_intents/:id/capture', {
    config: { requireApiKeyKind: 'secret' },
    schema: { params: z.object({ id: z.string().regex(/^pi_/) }) },
    handler: async (req) => {
      const merchantId = getMerchantId(req);
      const { id } = req.params as { id: string };
      const pi = await ctx.db
        .selectFrom('paycore.payment_intents')
        .leftJoin('paycore.payment_methods', 'paycore.payment_methods.id', 'paycore.payment_intents.payment_method_id')
        .select(['paycore.payment_methods.scheme as scheme'])
        .where('paycore.payment_intents.id', '=', id)
        .where('paycore.payment_intents.merchant_id', '=', merchantId)
        .executeTakeFirst();
      if (!pi) throw new PspError('resource_missing');
      const scheme = (pi.scheme as 'visa' | 'mastercard' | 'amex' | null) ?? 'visa';
      const r = await capturePaymentIntent(ctx.db, { paymentIntentId: id, merchantId, scheme });
      return paymentIntentToWire(r);
    },
  });

  // --- CANCEL -----------------------------------------------------------------
  typed.post('/v1/payment_intents/:id/cancel', {
    config: { requireApiKeyKind: 'secret' },
    schema: { params: z.object({ id: z.string().regex(/^pi_/) }) },
    handler: async (req) => {
      const merchantId = getMerchantId(req);
      const { id } = req.params as { id: string };
      const r = await cancelPaymentIntent(ctx.db, { paymentIntentId: id, merchantId });
      return paymentIntentToWire(r);
    },
  });
}
