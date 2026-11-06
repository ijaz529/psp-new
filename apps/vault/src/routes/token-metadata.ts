import type { Database } from '@psp-new/db';
import { PspError } from '@psp-new/errors';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { requireSender } from '../lib/service-auth-hook.js';

/**
 * Phase 45 — read a token's non-sensitive metadata back.
 *
 * The hosted-fields flow tokenizes inside the iframe, so the merchant page
 * only ever holds a `tok_`. `POST /v1/payment_methods` needs bin/last4/scheme
 * to build the PaymentMethod and had no way to get them, which is why the
 * `card.token` branch threw and the demo page fell back to a raw PAN.
 *
 * No ciphertext, no PAN, no KMS call — that is what `/internal/v1/detokenize`
 * is for, and it stays restricted to acquirer-host.
 */

const TokenMetadataBody = z.object({
  token: z.string().min(1),
  merchantId: z.string().min(1),
});

const TokenMetadataResponseSchema = z.object({
  bin: z.string(),
  last4: z.string(),
  scheme: z.enum(['visa', 'mastercard', 'amex', 'unknown']),
  expMonth: z.string().nullable(),
  expYear: z.string().nullable(),
});

export interface TokenMetadataDeps {
  readonly db: Kysely<Database>;
}

const ALLOWED_SENDERS: ReadonlyArray<string> = ['api'];

export function registerTokenMetadataRoute(app: FastifyInstance, deps: TokenMetadataDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.post('/internal/v1/token_metadata', {
    schema: { body: TokenMetadataBody, response: { 200: TokenMetadataResponseSchema } },
    handler: async (req) => {
      requireSender(req, ALLOWED_SENDERS);
      const body = req.body as z.infer<typeof TokenMetadataBody>;

      const row = await deps.db
        .selectFrom('vault.tokens')
        .select(['merchant_id', 'bin', 'last4', 'scheme', 'exp_month', 'exp_year'])
        .where('id', '=', body.token)
        .executeTakeFirst();
      if (!row) {
        throw new PspError('resource_missing', { message: 'token not found', internal: { token: body.token } });
      }
      if (row.merchant_id !== body.merchantId) {
        // Same non-leaking error as detokenize: don't confirm the token exists.
        throw new PspError('resource_missing', {
          message: 'token not found',
          internal: { reason: 'merchant mismatch', actual: row.merchant_id, requested: body.merchantId },
        });
      }

      return {
        bin: row.bin,
        last4: row.last4,
        scheme: row.scheme as z.infer<typeof TokenMetadataResponseSchema>['scheme'],
        expMonth: row.exp_month,
        expYear: row.exp_year,
      };
    },
  });
}
