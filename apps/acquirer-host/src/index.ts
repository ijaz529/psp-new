import { createHttpServer } from '@psp-new/http-server';
import { createLogger } from '@psp-new/logger';
import { initTelemetry } from '@psp-new/otel';
import { createServiceAuth } from '@psp-new/service-auth';
import { createVaultClient } from '@psp-new/vault-client';
import { registerCaptureRoute, registerReverseRoute } from './advice.js';
import { registerAuthorizeRoute } from './authorize.js';
import { createSchemeClient } from './client.js';
import { createStanAllocator } from './stan.js';

const KNOWN_SENDERS = ['api', 'acquirer-host', 'worker', 'outbox-relay', 'vault'];

async function main(): Promise<void> {
  const shutdownOtel = await initTelemetry({ serviceName: 'acquirer-host' });
  const logger = createLogger({ service: 'acquirer-host' });

  const secret = process.env.SERVICE_AUTH_SECRET;
  if (!secret) throw new Error('SERVICE_AUTH_SECRET required');
  const serviceAuth = createServiceAuth({ secretsBySender: new Map(KNOWN_SENDERS.map((s) => [s, secret])) });
  const vault = createVaultClient({
    baseUrl: process.env.VAULT_URL ?? 'http://vault:8081',
    serviceAuth,
    senderId: 'acquirer-host',
  });

  const simHost = process.env.SCHEME_SIMULATOR_HOST ?? 'scheme-simulator';
  const simPort = Number.parseInt(process.env.SCHEME_SIMULATOR_TCP_PORT_INTERNAL ?? '9001', 10);
  const schemeClient = createSchemeClient({ host: simHost, port: simPort });
  const stan = createStanAllocator();

  const app = await createHttpServer({
    serviceName: 'acquirer-host',
    logger,
    disableOpenApi: true,
    readinessChecks: [{ name: 'scheme_tcp', check: async () => schemeClient.isConnected() }],
  });

  registerAuthorizeRoute(app, { vault, client: schemeClient, stan, logger });
  registerCaptureRoute(app, { vault, client: schemeClient, stan, logger });
  registerReverseRoute(app, { vault, client: schemeClient, stan, logger });

  // Hooks must be registered BEFORE listen — Fastify 5 throws
  // FST_ERR_INSTANCE_ALREADY_LISTENING otherwise (Phase 42 found this
  // once the image's fastify was lockfile-pinned to match the host).
  app.addHook('onClose', async () => {
    schemeClient.close();
  });

  const port = Number.parseInt(process.env.ACQUIRER_HOST_PORT ?? '8082', 10);
  await app.listen({ port, host: '0.0.0.0' });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
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
  console.error('acquirer-host failed to start', err);
  process.exit(1);
});
