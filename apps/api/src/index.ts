import { initTelemetry } from '@psp-new/otel';
import { buildApi } from './server.js';

async function main(): Promise<void> {
  const shutdownOtel = await initTelemetry({ serviceName: 'api' });
  const app = await buildApi();

  const port = Number.parseInt(process.env.API_PORT ?? '8080', 10);
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
  console.error('api failed to start', err);
  process.exit(1);
});
