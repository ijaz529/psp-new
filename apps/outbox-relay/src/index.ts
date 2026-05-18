import { createKysely, createPool, dbConfigFromEnv } from '@psp-new/db';
import { createHttpServer } from '@psp-new/http-server';
import { createLogger } from '@psp-new/logger';
import { initTelemetry } from '@psp-new/otel';
import { WEBHOOK_DELIVERY_QUEUE, type WebhookDeliveryJobData } from '@psp-new/webhook-delivery';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { drainOnce } from './drainer.js';

async function main(): Promise<void> {
  const shutdownOtel = await initTelemetry({ serviceName: 'outbox-relay' });
  const logger = createLogger({ service: 'outbox-relay' });

  const pool = createPool({ ...dbConfigFromEnv(), applicationName: 'outbox-relay' });
  const db = createKysely(pool);

  const redis = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    maxRetriesPerRequest: null,
  });
  const queue = new Queue<WebhookDeliveryJobData>(WEBHOOK_DELIVERY_QUEUE, { connection: redis });

  const app = await createHttpServer({
    serviceName: 'outbox-relay',
    logger,
    disableOpenApi: true,
    readinessChecks: [
      {
        name: 'postgres',
        check: async () => {
          await pool.query('select 1');
          return true;
        },
      },
      {
        name: 'redis',
        check: async () => redis.status === 'ready' || (await redis.ping()) === 'PONG',
      },
    ],
  });

  app.addHook('onClose', async () => {
    await queue.close();
    await redis.quit();
    await pool.end();
  });

  const port = Number.parseInt(process.env.OUTBOX_RELAY_METRICS_PORT ?? '8083', 10);
  await app.listen({ port, host: '0.0.0.0' });

  // --- Drain loop: poll every 1s. --------------------------------------------
  let stopping = false;
  const intervalMs = Number.parseInt(process.env.OUTBOX_DRAIN_INTERVAL_MS ?? '1000', 10);
  void (async function loop() {
    while (!stopping) {
      try {
        const n = await drainOnce({ db, queue, logger });
        if (n === 0) await sleep(intervalMs);
      } catch (err) {
        logger.error({ err }, 'drain loop iteration failed');
        await sleep(intervalMs);
      }
    }
  })();

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down');
    stopping = true;
    try {
      await app.close();
      await shutdownOtel();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('outbox-relay failed to start', err);
  process.exit(1);
});
