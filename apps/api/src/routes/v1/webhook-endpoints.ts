import { randomBytes } from 'node:crypto';
import { PspError } from '@psp-new/errors';
import { newId } from '@psp-new/ids';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getMerchantId } from '../../lib/auth-helpers.js';
import type { AppContext } from '../../lib/context.js';
import { webhookEndpointToWire } from '../../lib/wire.js';

const CreateBody = z.object({
  url: z.string().url(),
  description: z.string().max(512).optional(),
  enabled_events: z.array(z.string()).min(1).default(['*']),
});

const UpdateBody = z.object({
  description: z.string().max(512).optional(),
  enabled_events: z.array(z.string()).min(1).optional(),
  status: z.enum(['enabled', 'disabled']).optional(),
});

export function registerWebhookEndpoints(app: FastifyInstance, ctx: AppContext): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.post('/v1/webhook_endpoints', {
    config: { requireApiKeyKind: 'secret' },
    schema: { body: CreateBody },
    handler: async (req, reply) => {
      const merchantId = getMerchantId(req);
      const body = req.body as z.infer<typeof CreateBody>;
      const id = newId('webhook_endpoint');
      const secret = `whsec_${randomBytes(32).toString('base64url')}`;
      const now = new Date();
      await ctx.db
        .insertInto('paycore.webhook_endpoints')
        .values({
          id,
          merchant_id: merchantId,
          url: body.url,
          description: body.description ?? null,
          enabled_events: body.enabled_events,
          signing_secret: secret,
          status: 'enabled',
          created_at: now,
          disabled_at: null,
        })
        .execute();
      const row = await ctx.db
        .selectFrom('paycore.webhook_endpoints')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      reply.status(201);
      // Returned only once; merchant must store it.
      return webhookEndpointToWire(row, /* includeSecret */ true);
    },
  });

  typed.get('/v1/webhook_endpoints', {
    config: { requireApiKeyKind: 'secret' },
    handler: async (req) => {
      const merchantId = getMerchantId(req);
      const rows = await ctx.db
        .selectFrom('paycore.webhook_endpoints')
        .selectAll()
        .where('merchant_id', '=', merchantId)
        .where('status', '!=', 'deleted')
        .orderBy('created_at', 'desc')
        .execute();
      return { object: 'list', data: rows.map((r) => webhookEndpointToWire(r)) };
    },
  });

  typed.get('/v1/webhook_endpoints/:id', {
    config: { requireApiKeyKind: 'secret' },
    schema: { params: z.object({ id: z.string().regex(/^we_/) }) },
    handler: async (req) => {
      const merchantId = getMerchantId(req);
      const { id } = req.params as { id: string };
      const row = await ctx.db
        .selectFrom('paycore.webhook_endpoints')
        .selectAll()
        .where('id', '=', id)
        .where('merchant_id', '=', merchantId)
        .executeTakeFirst();
      if (!row) throw new PspError('resource_missing');
      return webhookEndpointToWire(row);
    },
  });

  typed.post('/v1/webhook_endpoints/:id', {
    config: { requireApiKeyKind: 'secret' },
    schema: { params: z.object({ id: z.string().regex(/^we_/) }), body: UpdateBody },
    handler: async (req) => {
      const merchantId = getMerchantId(req);
      const { id } = req.params as { id: string };
      const body = req.body as z.infer<typeof UpdateBody>;
      const updates: Record<string, unknown> = {};
      if (body.description !== undefined) updates.description = body.description;
      if (body.enabled_events !== undefined) updates.enabled_events = body.enabled_events;
      if (body.status !== undefined) {
        updates.status = body.status;
        updates.disabled_at = body.status === 'disabled' ? new Date() : null;
      }
      if (Object.keys(updates).length === 0) throw new PspError('parameter_missing');
      const res = await ctx.db
        .updateTable('paycore.webhook_endpoints')
        .set(updates)
        .where('id', '=', id)
        .where('merchant_id', '=', merchantId)
        .executeTakeFirst();
      if (res.numUpdatedRows === 0n) throw new PspError('resource_missing');
      const row = await ctx.db
        .selectFrom('paycore.webhook_endpoints')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      return webhookEndpointToWire(row);
    },
  });

  typed.delete('/v1/webhook_endpoints/:id', {
    config: { requireApiKeyKind: 'secret', idempotency: false },
    schema: { params: z.object({ id: z.string().regex(/^we_/) }) },
    handler: async (req, reply) => {
      const merchantId = getMerchantId(req);
      const { id } = req.params as { id: string };
      const res = await ctx.db
        .updateTable('paycore.webhook_endpoints')
        .set({ status: 'deleted', disabled_at: new Date() })
        .where('id', '=', id)
        .where('merchant_id', '=', merchantId)
        .where('status', '!=', 'deleted')
        .executeTakeFirst();
      if (res.numUpdatedRows === 0n) throw new PspError('resource_missing');
      reply.status(204);
      return null;
    },
  });
}
