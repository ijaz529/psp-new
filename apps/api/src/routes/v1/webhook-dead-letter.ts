import { PspError } from '@psp-new/errors';
import { WEBHOOK_DELIVERY_QUEUE, type WebhookDeliveryJobData } from '@psp-new/webhook-delivery';
import { Queue } from 'bullmq';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import IORedis from 'ioredis';
import { z } from 'zod';
import { getMerchantId } from '../../lib/auth-helpers.js';
import type { AppContext } from '../../lib/context.js';

/**
 * Admin / merchant replay of permanently-failed webhook deliveries. Looks up
 * the dead-letter row, marks it `retried_at`, enqueues a fresh delivery job.
 */
export function registerWebhookDeadLetter(app: FastifyInstance, ctx: AppContext): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  let queue: Queue<WebhookDeliveryJobData> | null = null;

  // Lazy-construct the queue so unit tests without Redis don't need it.
  const ensureQueue = (): Queue<WebhookDeliveryJobData> => {
    if (queue) return queue;
    const redis = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: null });
    queue = new Queue<WebhookDeliveryJobData>(WEBHOOK_DELIVERY_QUEUE, { connection: redis });
    app.addHook('onClose', async () => {
      await queue?.close();
      await redis.quit();
    });
    return queue;
  };

  typed.get('/v1/webhook_dead_letter', {
    config: { requireApiKeyKind: 'secret' },
    handler: async (req) => {
      const merchantId = getMerchantId(req);
      const rows = await ctx.db
        .selectFrom('paycore.webhook_dead_letter')
        .innerJoin(
          'paycore.webhook_endpoints',
          'paycore.webhook_endpoints.id',
          'paycore.webhook_dead_letter.endpoint_id',
        )
        .select([
          'paycore.webhook_dead_letter.id as id',
          'paycore.webhook_dead_letter.event_id as event_id',
          'paycore.webhook_dead_letter.endpoint_id as endpoint_id',
          'paycore.webhook_dead_letter.reason as reason',
          'paycore.webhook_dead_letter.failed_after_attempts as failed_after_attempts',
          'paycore.webhook_dead_letter.created_at as created_at',
          'paycore.webhook_dead_letter.retried_at as retried_at',
        ])
        .where('paycore.webhook_endpoints.merchant_id', '=', merchantId)
        .orderBy('paycore.webhook_dead_letter.created_at', 'desc')
        .limit(100)
        .execute();
      return {
        object: 'list',
        data: rows.map((r) => ({
          ...r,
          created_at: r.created_at.toISOString(),
          retried_at: r.retried_at?.toISOString() ?? null,
        })),
      };
    },
  });

  typed.post('/v1/webhook_dead_letter/:id/replay', {
    config: { requireApiKeyKind: 'secret' },
    schema: { params: z.object({ id: z.string().regex(/^wdl_/) }) },
    handler: async (req) => {
      const merchantId = getMerchantId(req);
      const { id } = req.params as { id: string };
      const dl = await ctx.db
        .selectFrom('paycore.webhook_dead_letter')
        .innerJoin(
          'paycore.webhook_endpoints',
          'paycore.webhook_endpoints.id',
          'paycore.webhook_dead_letter.endpoint_id',
        )
        .select([
          'paycore.webhook_dead_letter.event_id as event_id',
          'paycore.webhook_dead_letter.endpoint_id as endpoint_id',
        ])
        .where('paycore.webhook_dead_letter.id', '=', id)
        .where('paycore.webhook_endpoints.merchant_id', '=', merchantId)
        .executeTakeFirst();
      if (!dl) throw new PspError('resource_missing');
      await ctx.db
        .updateTable('paycore.webhook_dead_letter')
        .set({ retried_at: new Date() })
        .where('id', '=', id)
        .execute();
      await ensureQueue().add(
        'deliver',
        { eventId: dl.event_id, endpointId: dl.endpoint_id },
        { jobId: `replay:${id}:${Date.now()}` },
      );
      return { id, replayed: true };
    },
  });
}
