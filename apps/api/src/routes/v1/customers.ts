import { PspError } from '@psp-new/errors';
import { newId } from '@psp-new/ids';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getMerchantId } from '../../lib/auth-helpers.js';
import type { AppContext } from '../../lib/context.js';
import { customerToWire } from '../../lib/wire.js';

const CreateBody = z.object({
  email: z.string().email().optional(),
  name: z.string().min(1).max(256).optional(),
  description: z.string().max(512).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export function registerCustomers(app: FastifyInstance, ctx: AppContext): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.post('/v1/customers', {
    config: { requireApiKeyKind: 'secret' },
    schema: { body: CreateBody },
    handler: async (req, reply) => {
      const merchantId = getMerchantId(req);
      const body = req.body as z.infer<typeof CreateBody>;
      const id = newId('customer');
      const now = new Date();
      await ctx.db
        .insertInto('paycore.customers')
        .values({
          id,
          merchant_id: merchantId,
          email: body.email ?? null,
          name: body.name ?? null,
          description: body.description ?? null,
          metadata: body.metadata ?? null,
          created_at: now,
        })
        .execute();
      const row = await ctx.db
        .selectFrom('paycore.customers')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      reply.status(201);
      return customerToWire(row);
    },
  });

  typed.get('/v1/customers/:id', {
    config: { requireApiKeyKind: 'secret' },
    schema: { params: z.object({ id: z.string() }) },
    handler: async (req) => {
      const merchantId = getMerchantId(req);
      const params = req.params as { id: string };
      const row = await ctx.db
        .selectFrom('paycore.customers')
        .selectAll()
        .where('id', '=', params.id)
        .where('merchant_id', '=', merchantId)
        .executeTakeFirst();
      if (!row) throw new PspError('resource_missing');
      return customerToWire(row);
    },
  });
}
