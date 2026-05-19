import fastifyCors from '@fastify/cors';
import { apiKeyAuthPlugin } from '@psp-new/api-keys';
import { createHttpServer } from '@psp-new/http-server';
import { idempotencyPlugin } from '@psp-new/idempotency';
import { type Logger, createLogger } from '@psp-new/logger';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { cardholderAuthPlugin } from './lib/cardholder-auth.js';
import { type AppContext, type AppContextOptions, buildAppContext } from './lib/context.js';
import { registerCardholder } from './routes/v1/cardholder.js';
import { registerCards } from './routes/v1/cards.js';
import { registerCustomers } from './routes/v1/customers.js';
import { registerDisputes } from './routes/v1/disputes.js';
import { registerEvents } from './routes/v1/events.js';
import { registerPaymentIntents } from './routes/v1/payment-intents.js';
import { registerPaymentMethods } from './routes/v1/payment-methods.js';
import { registerRefunds } from './routes/v1/refunds.js';
import { registerThreeDsCallback } from './routes/v1/three-ds.js';
import { registerTokens } from './routes/v1/tokens.js';
import { registerWebhookDeadLetter } from './routes/v1/webhook-dead-letter.js';
import { registerWebhookEndpoints } from './routes/v1/webhook-endpoints.js';

export interface BuildApiOpts extends AppContextOptions {
  readonly logger?: Logger;
  readonly context?: AppContext;
}

export async function buildApi(opts: BuildApiOpts = {}): Promise<FastifyInstance> {
  const logger = opts.logger ?? createLogger({ service: 'api' });
  const ctx = opts.context ?? buildAppContext(opts);

  const app = await createHttpServer({
    serviceName: 'api',
    serviceVersion: '0.0.0',
    logger,
    openApiTitle: 'Strawberry API',
    readinessChecks: [
      {
        name: 'postgres',
        check: async () => {
          await ctx.pool.query('select 1');
          return true;
        },
      },
    ],
  });

  // CORS: open for Phase 4. The pk-only auth gate on /v1/tokens is the real
  // control; sk-only routes are never called from a browser. Phase 7 will
  // tighten via per-merchant origin whitelist.
  await app.register(fastifyCors, {
    origin: true,
    credentials: false,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['authorization', 'content-type', 'idempotency-key', 'paycore-version'],
    exposedHeaders: ['x-request-id', 'idempotency-replay', 'paycore-version'],
  });

  // API-key auth → idempotency. Order matters: auth sets req.merchantId, which
  // idempotency reads. Cardholder auth runs alongside and only fires on routes
  // that opt in via config.requireCardholderKey.
  await app.register(apiKeyAuthPlugin, { db: ctx.db });
  await app.register(cardholderAuthPlugin, { db: ctx.db });
  await app.register(idempotencyPlugin, { db: ctx.db });

  // --- v1 resources ----------------------------------------------------------
  registerCustomers(app, ctx);
  registerPaymentMethods(app, ctx);
  registerPaymentIntents(app, ctx);
  registerRefunds(app, ctx);
  registerWebhookEndpoints(app, ctx);
  registerEvents(app, ctx);
  registerTokens(app, ctx);
  registerThreeDsCallback(app, ctx);
  registerDisputes(app, ctx);
  registerCards(app, ctx);
  registerWebhookDeadLetter(app, ctx);
  registerCardholder(app, ctx);

  // --- Dev / Phase 0 echo (kept for smoke.mjs back-compat) -------------------
  const typed = app.withTypeProvider<import('fastify-type-provider-zod').ZodTypeProvider>();
  typed.post('/v1/_dev/echo', {
    config: { skipApiKey: true, idempotency: false },
    schema: {
      body: z.object({ message: z.string().min(1).max(512) }),
      response: { 201: z.object({ received: z.string(), request_id: z.string() }) },
    },
    handler: async (req, reply) => {
      reply.status(201);
      return { received: (req.body as { message: string }).message, request_id: req.id };
    },
  });

  app.get('/v1/healthz', { config: { skipApiKey: true } }, async () => ({ status: 'ok', service: 'api' }));

  app.addHook('onClose', async () => {
    await ctx.pool.end();
  });

  return app;
}
