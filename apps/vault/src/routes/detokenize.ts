import type { Database } from '@psp-new/db';
import { PspError } from '@psp-new/errors';
import { newId } from '@psp-new/ids';
import type { KmsProvider } from '@psp-new/kms';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { decryptPan } from '../lib/kms-pan.js';
import { requireSender } from '../lib/service-auth-hook.js';

const DetokenizeBody = z.object({
  token: z.string().min(1),
  merchantId: z.string().min(1),
  reason: z.enum(['authorization', 'capture', 'refund', 'audit']),
});

const DetokenizeResponseSchema = z.object({
  pan: z.string(),
  expMonth: z.string().nullable(),
  expYear: z.string().nullable(),
});

export interface DetokenizeDeps {
  readonly db: Kysely<Database>;
  readonly kms: KmsProvider;
}

const ALLOWED_SENDERS: ReadonlyArray<string> = ['acquirer-host'];

export function registerDetokenizeRoute(app: FastifyInstance, deps: DetokenizeDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.post('/internal/v1/detokenize', {
    schema: { body: DetokenizeBody, response: { 200: DetokenizeResponseSchema } },
    handler: async (req) => {
      requireSender(req, ALLOWED_SENDERS);
      const body = req.body as z.infer<typeof DetokenizeBody>;

      const row = await deps.db
        .selectFrom('vault.tokens')
        .select(['merchant_id', 'pan_ciphertext', 'kms_key_id', 'exp_month', 'exp_year'])
        .where('id', '=', body.token)
        .executeTakeFirst();
      if (!row) {
        throw new PspError('resource_missing', { message: 'token not found', internal: { token: body.token } });
      }
      if (row.merchant_id !== body.merchantId) {
        // Don't leak existence info — same error code as missing.
        throw new PspError('resource_missing', {
          message: 'token not found',
          internal: { reason: 'merchant mismatch', actual: row.merchant_id, requested: body.merchantId },
        });
      }
      if (!row.pan_ciphertext || !row.kms_key_id) {
        throw new PspError('internal_error', { message: 'token has no ciphertext', internal: { token: body.token } });
      }

      const pan = await decryptPan(deps.kms, row.merchant_id, row.pan_ciphertext, row.kms_key_id);

      // Audit log + last_used_at touch in one transaction.
      await deps.db.transaction().execute(async (trx) => {
        await trx
          .insertInto('vault.detokenize_audit')
          .values({
            id: newId('detokenize_audit'),
            token_id: body.token,
            merchant_id: body.merchantId,
            sender: req.serviceAuthSender ?? 'unknown',
            reason: body.reason,
            request_id: req.id,
            detokenized_at: new Date(),
          })
          .execute();
        await trx.updateTable('vault.tokens').set({ last_used_at: new Date() }).where('id', '=', body.token).execute();
      });

      // The PAN goes back over the wire to acquirer-host. We deliberately do
      // NOT log the response body — the Pino redaction + scanner would catch
      // it, but the cheaper precaution is not to log it at all.
      req.log.info(
        { token: body.token, merchant_id: body.merchantId, sender: req.serviceAuthSender, reason: body.reason },
        'token detokenized',
      );
      return { pan, expMonth: row.exp_month, expYear: row.exp_year };
    },
  });
}
