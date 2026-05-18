import { PspError } from '@psp-new/errors';
import type { FastifyRequest } from 'fastify';

/**
 * Read `req.merchantId` set by the api-key auth plugin. If somehow the plugin
 * didn't run (bug), throw a clear internal error instead of letting `undefined`
 * leak deeper.
 */
export function getMerchantId(req: FastifyRequest): string {
  const m = req.merchantId;
  if (!m) {
    throw new PspError('internal_error', { message: 'merchant context missing — api-key auth plugin misconfigured' });
  }
  return m;
}
