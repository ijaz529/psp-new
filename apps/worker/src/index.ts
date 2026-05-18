import { createKysely, createPool, dbConfigFromEnv } from '@psp-new/db';
import { createHttpServer } from '@psp-new/http-server';
import { createLogger } from '@psp-new/logger';
import { initTelemetry } from '@psp-new/otel';
import { WEBHOOK_DELIVERY_QUEUE, type WebhookDeliveryJobData } from '@psp-new/webhook-delivery';
import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { refreshAccountBalances, runNightlyJobs } from './clearing-job.js';
import { processWebhookDeliveryJob } from './webhook-processor.js';

async function main(): Promise<void> {
  const shutdownOtel = await initTelemetry({ serviceName: 'worker' });
  const logger = createLogger({ service: 'worker' });

  const pool = createPool({ ...dbConfigFromEnv(), applicationName: 'worker' });
  const db = createKysely(pool);

  const redis = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    maxRetriesPerRequest: null,
  });
  const queue = new Queue<WebhookDeliveryJobData>(WEBHOOK_DELIVERY_QUEUE, { connection: redis });
  const bullWorker = new Worker<WebhookDeliveryJobData>(
    WEBHOOK_DELIVERY_QUEUE,
    async (job) => processWebhookDeliveryJob({ db, queue, logger }, job.data),
    {
      connection: redis,
      concurrency: Number.parseInt(process.env.WEBHOOK_CONCURRENCY ?? '8', 10),
    },
  );

  bullWorker.on('failed', (job, err) => {
    logger.error(
      { job_id: job?.id, err },
      'webhook job failed (will not auto-retry — our processor schedules retries explicitly)',
    );
  });

  const app = await createHttpServer({
    serviceName: 'worker',
    logger,
    disableOpenApi: true,
    readinessChecks: [
      { name: 'postgres', check: async () => (await pool.query('select 1')) && true },
      { name: 'redis', check: async () => redis.status === 'ready' || (await redis.ping()) === 'PONG' },
    ],
  });

  app.addHook('onClose', async () => {
    await bullWorker.close();
    await queue.close();
    await redis.quit();
    await pool.end();
  });

  const port = Number.parseInt(process.env.WORKER_METRICS_PORT ?? '8084', 10);
  await app.listen({ port, host: '0.0.0.0' });
  logger.info({ port }, 'worker started — webhook-delivery queue subscribed');

  // Cron-style intervals — Phase 6 keeps it simple with setInterval. Phase 7+
  // can swap in a BullMQ repeatable job for distributed leader election.
  const nightlyIntervalMs = Number.parseInt(process.env.NIGHTLY_INTERVAL_MS ?? '86400000', 10);
  const balanceIntervalMs = Number.parseInt(process.env.BALANCE_REFRESH_MS ?? '300000', 10);

  const nightlyTimer = setInterval(() => {
    runNightlyJobs({ db, logger }, new Date()).catch((err) => logger.error({ err }, 'nightly job crashed'));
  }, nightlyIntervalMs);
  const balanceTimer = setInterval(() => {
    refreshAccountBalances(db, logger).catch((err) => logger.warn({ err }, 'balance refresh crashed'));
  }, balanceIntervalMs);

  app.addHook('onClose', async () => {
    clearInterval(nightlyTimer);
    clearInterval(balanceTimer);
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down');
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

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('worker failed to start', err);
  process.exit(1);
});
