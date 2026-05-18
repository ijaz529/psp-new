import { PspError } from '@psp-new/errors';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getMerchantId } from '../../lib/auth-helpers.js';
import type { AppContext } from '../../lib/context.js';

/**
 * Public tokenize endpoint for the hosted-fields iframe.
 *
 * Accepts ONLY publishable keys (`pk_test_…` / `pk_live_…`). Calls vault.tokenize
 * server-side (since only our internal services can talk to the vault) and
 * returns the resulting token to the browser.
 *
 * CORS: open for Phase 4 (per Q1 recommendation; per-merchant origin whitelist
 * lands in Phase 7 risk). The pk-only auth is the primary control.
 */
const TokenizeBody = z.object({
  card: z.object({
    number: z.string().min(12).max(25),
    exp_month: z.string().regex(/^(0[1-9]|1[0-2])$/),
    exp_year: z.string().regex(/^\d{4}$/),
    cvc: z.string().min(3).max(4).optional(),
  }),
});

export function registerTokens(app: FastifyInstance, ctx: AppContext): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.post('/v1/tokens', {
    config: { requireApiKeyKind: 'publishable', idempotency: false },
    schema: { body: TokenizeBody },
    handler: async (req, reply) => {
      const merchantId = getMerchantId(req);
      const body = req.body as z.infer<typeof TokenizeBody>;
      try {
        const t = await ctx.vault.tokenize({
          pan: body.card.number,
          merchantId,
          expMonth: body.card.exp_month,
          expYear: body.card.exp_year,
        });
        reply.status(201);
        return { id: t.token, object: 'token', bin: t.bin, last4: t.last4, scheme: t.scheme };
      } catch (err) {
        // Vault validation errors come back as VaultClientError with the underlying envelope.
        if ((err as { status?: number }).status === 400) {
          throw new PspError('parameter_invalid', { message: (err as Error).message, param: 'card.number' });
        }
        throw err;
      }
    },
  });
}
