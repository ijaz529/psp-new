import { createKysely, createPool, dbConfigFromEnv } from '@psp-new/db';
import { createHttpServer } from '@psp-new/http-server';
import { createLogger } from '@psp-new/logger';
import { initTelemetry } from '@psp-new/otel';
import { WEBHOOK_DELIVERY_QUEUE, type WebhookDeliveryJobData } from '@psp-new/webhook-delivery';
import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { expireStaleAuthHolds } from './auth-expiry-job.js';
import { reconcileCardLoadAcquiring } from './card-load-acquiring-job.js';
import { sweepClearingAdjustments } from './clearing-adjustments-sweep-job.js';
import { refreshAccountBalances, runNightlyJobs } from './clearing-job.js';
import { reconcileCardLoads } from './pool-reconciliation-job.js';
import { settleSchemeReceivables } from './scheme-settlement-job.js';
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

  // Phase 13 — auth-expiry sweeper. Defaults: 6h cadence, 7d expiry window.
  const expiryIntervalMs = Number.parseInt(process.env.AUTH_EXPIRY_INTERVAL_MS ?? '21600000', 10);
  const expiryWindowMs = Number.parseInt(process.env.AUTH_EXPIRY_WINDOW_MS ?? '604800000', 10);
  const expiryTimer = setInterval(() => {
    expireStaleAuthHolds({ db, logger }, { windowMs: expiryWindowMs }).catch((err) =>
      logger.error({ err }, 'auth-expiry job crashed'),
    );
  }, expiryIntervalMs);

  // Phase 14 — pool reconciliation. Default: 1h cadence.
  const reconIntervalMs = Number.parseInt(process.env.POOL_RECON_INTERVAL_MS ?? '3600000', 10);
  const reconTimer = setInterval(() => {
    reconcileCardLoads({ db, logger }).catch((err) => logger.error({ err }, 'pool-reconciliation job crashed'));
  }, reconIntervalMs);

  // Phase 15 — scheme settlement. Default: 24h cadence (Visa/MC T+1 net-settlement).
  const settleIntervalMs = Number.parseInt(process.env.SCHEME_SETTLE_INTERVAL_MS ?? '86400000', 10);
  const settleTimer = setInterval(() => {
    settleSchemeReceivables({ db, logger }).catch((err) => logger.error({ err }, 'scheme-settlement job crashed'));
  }, settleIntervalMs);

  // Phase 17 — card-load acquiring leg. Default: 30min cadence.
  const acquiringIntervalMs = Number.parseInt(process.env.CARD_LOAD_ACQ_INTERVAL_MS ?? '1800000', 10);
  const acquiringTimer = setInterval(() => {
    reconcileCardLoadAcquiring({ db, logger }).catch((err) => logger.error({ err }, 'card-load-acquiring job crashed'));
  }, acquiringIntervalMs);

  // Phase 24 — sweep clearing_adjustments to adjustment_revenue. Default: 24h.
  const clearingSweepIntervalMs = Number.parseInt(process.env.CLEARING_SWEEP_INTERVAL_MS ?? '86400000', 10);
  const clearingSweepTimer = setInterval(() => {
    sweepClearingAdjustments({ db, logger }).catch((err) =>
      logger.error({ err }, 'clearing-adjustments sweep job crashed'),
    );
  }, clearingSweepIntervalMs);

  app.addHook('onClose', async () => {
    clearInterval(nightlyTimer);
    clearInterval(balanceTimer);
    clearInterval(expiryTimer);
    clearInterval(reconTimer);
    clearInterval(settleTimer);
    clearInterval(acquiringTimer);
    clearInterval(clearingSweepTimer);
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
