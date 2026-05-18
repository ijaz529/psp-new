import { PspError } from '@psp-new/errors';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getMerchantId } from '../../lib/auth-helpers.js';
import type { AppContext } from '../../lib/context.js';
import { eventToWire } from '../../lib/wire.js';

const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(10),
  type: z.string().optional(),
});

export function registerEvents(app: FastifyInstance, ctx: AppContext): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.get('/v1/events', {
    config: { requireApiKeyKind: 'secret' },
    schema: { querystring: ListQuery },
    handler: async (req) => {
      const merchantId = getMerchantId(req);
      const q = req.query as z.infer<typeof ListQuery>;
      let qb = ctx.db
        .selectFrom('paycore.events')
        .selectAll()
        .where('merchant_id', '=', merchantId)
        .orderBy('created_at', 'desc')
        .limit(q.limit);
      if (q.type) qb = qb.where('type', '=', q.type);
      const rows = await qb.execute();
      return { object: 'list', data: rows.map(eventToWire) };
    },
  });

  typed.get('/v1/events/:id', {
    config: { requireApiKeyKind: 'secret' },
    schema: { params: z.object({ id: z.string().regex(/^evt_/) }) },
    handler: async (req) => {
      const merchantId = getMerchantId(req);
      const { id } = req.params as { id: string };
      const row = await ctx.db
        .selectFrom('paycore.events')
        .selectAll()
        .where('id', '=', id)
        .where('merchant_id', '=', merchantId)
        .executeTakeFirst();
      if (!row) throw new PspError('resource_missing');
      return eventToWire(row);
    },
  });
}
