import { PspError } from '@psp-new/errors';
import { newId } from '@psp-new/ids';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getMerchantId } from '../../lib/auth-helpers.js';
import type { AppContext } from '../../lib/context.js';
import { paymentMethodToWire } from '../../lib/wire.js';

/**
 * Two creation modes (Stripe-mirror):
 *   - `card.token`     — tokenize-already-happened (preferred for SAQ-A merchants).
 *   - `card.number...` — server-side raw PAN; the api proxies to vault.tokenize.
 *                        Acceptable in Phase 3 testing; Phase 4 hosted-fields removes this path
 *                        for merchants who want to stay out of PCI scope.
 */
const CardWithToken = z.object({
  token: z.string().regex(/^tok_/, 'token must start with tok_'),
});

const CardWithRaw = z.object({
  number: z.string().min(12).max(25),
  exp_month: z.string().regex(/^(0[1-9]|1[0-2])$/),
  exp_year: z.string().regex(/^\d{4}$/),
  cvc: z.string().min(3).max(4).optional(),
});

const CreateBody = z.object({
  type: z.literal('card'),
  customer: z.string().optional(),
  card: z.union([CardWithToken, CardWithRaw]),
});

export function registerPaymentMethods(app: FastifyInstance, ctx: AppContext): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.post('/v1/payment_methods', {
    config: { requireApiKeyKind: 'secret' },
    schema: { body: CreateBody },
    handler: async (req, reply) => {
      const merchantId = getMerchantId(req);
      const body = req.body as z.infer<typeof CreateBody>;

      let tokenId: string;
      let bin: string;
      let last4: string;
      let scheme: string;
      let expMonth: string | null;
      let expYear: string | null;

      if ('token' in body.card) {
        // Hosted-fields path: the iframe already tokenized, so the merchant
        // page never held the PAN. Read the metadata back from the vault.
        const meta = await ctx.vault.tokenMetadata({ token: body.card.token, merchantId });
        tokenId = body.card.token;
        bin = meta.bin;
        last4 = meta.last4;
        scheme = meta.scheme;
        expMonth = meta.expMonth;
        expYear = meta.expYear;
      } else {
        // Raw card path → tokenize via vault.
        const t = await ctx.vault.tokenize({
          pan: body.card.number,
          merchantId,
          expMonth: body.card.exp_month,
          expYear: body.card.exp_year,
        });
        tokenId = t.token;
        bin = t.bin;
        last4 = t.last4;
        scheme = t.scheme;
        expMonth = body.card.exp_month;
        expYear = body.card.exp_year;
      }

      const id = newId('payment_method');
      const now = new Date();
      await ctx.db
        .insertInto('paycore.payment_methods')
        .values({
          id,
          merchant_id: merchantId,
          customer_id: body.customer ?? null,
          token_id: tokenId,
          bin,
          last4,
          scheme,
          exp_month: expMonth,
          exp_year: expYear,
          created_at: now,
        })
        .execute();
      const row = await ctx.db
        .selectFrom('paycore.payment_methods')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      reply.status(201);
      return paymentMethodToWire(row);
    },
  });

  typed.get('/v1/payment_methods/:id', {
    config: { requireApiKeyKind: 'secret' },
    schema: { params: z.object({ id: z.string() }) },
    handler: async (req) => {
      const merchantId = getMerchantId(req);
      const { id } = req.params as { id: string };
      const row = await ctx.db
        .selectFrom('paycore.payment_methods')
        .selectAll()
        .where('id', '=', id)
        .where('merchant_id', '=', merchantId)
        .executeTakeFirst();
      if (!row) throw new PspError('resource_missing');
      return paymentMethodToWire(row);
    },
  });
}
