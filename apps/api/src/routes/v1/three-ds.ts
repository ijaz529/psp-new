import { PspError } from '@psp-new/errors';
import { completeThreeDs } from '@psp-new/payment-engine';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { AppContext } from '../../lib/context.js';

/**
 * Internal callback the scheme-simulator hits after the customer clicks
 * Approve/Decline on the 3DS challenge page.
 *
 * Auth: open in Phase 4 (internal compose network). Phase 7 wraps this in
 * service-auth so only the scheme-simulator can invoke it.
 */
const CallbackBody = z.object({
  session_id: z.string().regex(/^tds_/),
  outcome: z.enum(['approve', 'decline', 'attempted']),
});

export function registerThreeDsCallback(app: FastifyInstance, ctx: AppContext): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.post('/v1/_internal/three_ds/callback', {
    config: { skipApiKey: true, idempotency: false },
    schema: { body: CallbackBody },
    handler: async (req) => {
      const body = req.body as z.infer<typeof CallbackBody>;
      try {
        const pi = await completeThreeDs(ctx.db, {
          sessionId: body.session_id,
          outcome: body.outcome,
          authorizer: ctx.authorizer,
        });
        return { ok: true, payment_intent_id: pi.id, status: pi.status };
      } catch (err) {
        if (err instanceof PspError) throw err;
        throw new PspError('internal_error', { internal: { reason: (err as Error).message } });
      }
    },
  });
}
