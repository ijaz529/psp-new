import type { Database } from '@psp-new/db';
import { PspError } from '@psp-new/errors';
import { newId } from '@psp-new/ids';
import type { KmsProvider } from '@psp-new/kms';
import type { CardScheme } from '@psp-new/vault-client';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { encryptPan, panHmacScoped } from '../lib/kms-pan.js';
import { isValidLuhn } from '../lib/luhn.js';
import { detectScheme } from '../lib/scheme.js';

const TokenizeBody = z.object({
  pan: z.string().min(12).max(25),
  expMonth: z
    .string()
    .regex(/^(0[1-9]|1[0-2])$/)
    .optional(),
  expYear: z
    .string()
    .regex(/^\d{4}$/)
    .optional(),
  merchantId: z.string().min(1),
});

const TokenizeResponseSchema = z.object({
  token: z.string(),
  bin: z.string(),
  last4: z.string(),
  scheme: z.enum(['visa', 'mastercard', 'amex', 'unknown']),
});

export interface TokenizeDeps {
  readonly db: Kysely<Database>;
  readonly kms: KmsProvider;
}

export function registerTokenizeRoute(app: FastifyInstance, deps: TokenizeDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.post('/internal/v1/tokenize', {
    schema: { body: TokenizeBody, response: { 200: TokenizeResponseSchema } },
    handler: async (req) => {
      const body = req.body as z.infer<typeof TokenizeBody>;
      const cleaned = body.pan.replace(/[ -]/g, '');

      if (!/^\d{12,19}$/.test(cleaned)) {
        throw new PspError('parameter_invalid', { message: 'PAN must be 12–19 digits', param: 'pan' });
      }
      if (!isValidLuhn(cleaned)) {
        throw new PspError('parameter_invalid', { message: 'PAN failed Luhn check', param: 'pan' });
      }

      const scheme: CardScheme = detectScheme(cleaned);
      const bin = cleaned.slice(0, 6);
      const last4 = cleaned.slice(-4);

      const panHmac = await panHmacScoped(deps.kms, body.merchantId, cleaned);

      // Dedup: same merchant + same PAN → existing token id.
      const existing = await deps.db
        .selectFrom('vault.tokens')
        .select(['id'])
        .where('merchant_id', '=', body.merchantId)
        .where('pan_hmac', '=', panHmac)
        .executeTakeFirst();
      if (existing) {
        await deps.db
          .updateTable('vault.tokens')
          .set({ last_used_at: new Date() })
          .where('id', '=', existing.id)
          .execute();
        return { token: existing.id, bin, last4, scheme };
      }

      const enc = await encryptPan(deps.kms, body.merchantId, cleaned);
      const tokenId = newId('token');
      const now = new Date();

      await deps.db
        .insertInto('vault.tokens')
        .values({
          id: tokenId,
          merchant_id: body.merchantId,
          pan_hmac: panHmac,
          bin,
          last4,
          exp_month: body.expMonth ?? null,
          exp_year: body.expYear ?? null,
          scheme,
          pan_ciphertext: enc.value,
          kms_key_id: enc.keyId,
          created_at: now,
          last_used_at: now,
        })
        .execute();

      req.log.info({ token: tokenId, merchant_id: body.merchantId, bin, last4, scheme }, 'token issued');
      return { token: tokenId, bin, last4, scheme };
    },
  });
}
