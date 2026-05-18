import { createHttpServer } from '@psp-new/http-server';
import { createLogger } from '@psp-new/logger';
import { initTelemetry } from '@psp-new/otel';
import { demoHtml } from './demo-html.js';
import { hostedFieldsJs } from './hosted-fields-js.js';
import { iframeHtml } from './iframe-html.js';

async function main(): Promise<void> {
  const shutdownOtel = await initTelemetry({ serviceName: 'checkout' });
  const logger = createLogger({ service: 'checkout' });

  const port = Number.parseInt(process.env.CHECKOUT_PORT ?? '7001', 10);
  const checkoutOrigin = process.env.CHECKOUT_PUBLIC_ORIGIN ?? `http://localhost:${port}`;
  const apiBaseUrl = process.env.API_PUBLIC_URL ?? 'http://localhost:8080';

  const app = await createHttpServer({
    serviceName: 'checkout',
    logger,
    disableOpenApi: true,
  });

  // The merchant-side bundle. Cache for a short window in dev.
  app.get('/v1/hosted-fields.js', async (_req, reply) => {
    reply.type('application/javascript');
    reply.header('cache-control', 'public, max-age=60');
    return hostedFieldsJs({ checkoutOrigin });
  });

  // The iframe HTML — served from a separate origin from the merchant page.
  // Allow framing from anywhere in Phase 4 (Phase 8 reads from merchant.allowed_origins).
  app.get('/iframe', async (req, reply) => {
    const q = req.query as { pk?: string; parentOrigin?: string };
    if (!q.pk || !q.parentOrigin) {
      reply.status(400).type('text/plain');
      return 'Wirecore iframe: pk and parentOrigin query parameters are required';
    }
    reply.type('text/html');
    reply.header('content-security-policy', "frame-ancestors *; default-src 'self' 'unsafe-inline'");
    return iframeHtml({ apiBaseUrl, publishableKey: q.pk, parentOrigin: q.parentOrigin });
  });

  // Demo merchant page — same-origin convenience hosted off the checkout origin.
  app.get('/demo.html', async (_req, reply) => {
    reply.type('text/html');
    return demoHtml({ apiBaseUrl, checkoutOrigin });
  });

  // Root: redirect to the demo for convenience.
  app.get('/', async (_req, reply) => {
    reply.redirect('/demo.html', 302);
  });

  await app.listen({ port, host: '0.0.0.0' });

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
  console.error('checkout failed to start', err);
  process.exit(1);
});
