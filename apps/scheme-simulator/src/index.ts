import net from 'node:net';
import fastifyFormbody from '@fastify/formbody';
import { createHttpServer } from '@psp-new/http-server';
import { createLogger } from '@psp-new/logger';
import { initTelemetry } from '@psp-new/otel';
import { createFrameReader } from './framing.js';
import { createIssuerClient } from './issuer-client.js';
import { handleAuthRequest, parseBinRanges } from './issuer.js';
import { registerThreeDsRoutes } from './three-ds.js';

async function main(): Promise<void> {
  const shutdownOtel = await initTelemetry({ serviceName: 'scheme-simulator' });
  const logger = createLogger({ service: 'scheme-simulator' });

  const tcpPort = Number.parseInt(process.env.SCHEME_SIMULATOR_TCP_PORT ?? '9001', 10);
  const httpPort = Number.parseInt(process.env.SCHEME_SIMULATOR_HTTP_PORT ?? '9002', 10);

  // Phase 9: optional issuer-host route. If STRAWBERRY_BIN_RANGES is set, open
  // a persistent TCP client to issuer-host and forward PANs that match.
  const strawberryRanges = parseBinRanges(process.env.STRAWBERRY_BIN_RANGES);
  const issuerClient =
    strawberryRanges.length > 0
      ? createIssuerClient({
          host: process.env.ISSUER_HOST_HOST ?? 'issuer-host',
          port: Number.parseInt(process.env.ISSUER_HOST_TCP_PORT ?? '9101', 10),
        })
      : null;
  if (strawberryRanges.length > 0) {
    logger.info({ ranges: strawberryRanges }, 'scheme-simulator: BIN-routing enabled for issuer-host');
  }

  // --- TCP server: accepts 4-byte ASCII length framed messages. Phase 0 just
  //     reads + logs; Phase 5 lifts bodies into the 8583 codec; Phase 9 adds
  //     BIN-routing to issuer-host.
  const tcpServer = net.createServer((socket) => {
    const peer = `${socket.remoteAddress}:${socket.remotePort}`;
    logger.info({ peer }, 'scheme-simulator: client connected');
    const reader = createFrameReader();
    socket.on('data', async (chunk) => {
      let frames: Buffer[];
      try {
        frames = reader.push(chunk);
      } catch (err) {
        logger.warn({ peer, err: (err as Error).message }, 'scheme-simulator: bad framing, dropping');
        socket.destroy();
        return;
      }
      for (const f of frames) {
        const body = f.toString('ascii');
        let response: string;
        try {
          response = await handleAuthRequest(body, { strawberryRanges, issuerClient });
        } catch (err) {
          logger.warn({ peer, err: (err as Error).message }, 'scheme-simulator: failed to handle frame');
          continue;
        }
        const frame = Buffer.from(response.length.toString().padStart(4, '0') + response, 'ascii');
        socket.write(frame);
        logger.info({ peer, in_bytes: f.length, out_bytes: response.length }, 'scheme-simulator: response sent');
      }
    });
    socket.on('close', () => logger.info({ peer }, 'scheme-simulator: client disconnected'));
    socket.on('error', (err) => logger.warn({ peer, err: err.message }, 'scheme-simulator: socket error'));
  });

  await new Promise<void>((resolve) => tcpServer.listen(tcpPort, '0.0.0.0', resolve));
  logger.info({ tcpPort }, 'scheme-simulator: TCP listening');

  // --- HTTP server: /healthz + /metrics + placeholder OTP UI route (Phase 4 will fill in).
  const app = await createHttpServer({
    serviceName: 'scheme-simulator',
    logger,
    disableOpenApi: true,
    readinessChecks: [{ name: 'tcp_listener', check: async () => tcpServer.listening }],
  });

  await app.register(fastifyFormbody);
  registerThreeDsRoutes(app);

  app.get('/', async (_req, reply) => {
    reply.type('text/html');
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>scheme-simulator</title></head>
<body style="font-family:system-ui;padding:2rem;max-width:48rem">
<h1>scheme-simulator</h1>
<p>Phase 4: 3DS ACS challenge UI lives at <code>/3ds/challenge/&lt;sessionId&gt;</code>.</p>
<p>Phase 5 will hook up the ISO 8583 messaging on tcp://&lt;host&gt;:${tcpPort}.</p>
<p>Health: <a href="/healthz">/healthz</a> · Metrics: <a href="/metrics">/metrics</a></p>
</body></html>`;
  });

  await app.listen({ port: httpPort, host: '0.0.0.0' });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down');
    tcpServer.close();
    issuerClient?.close();
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
  console.error('scheme-simulator failed to start', err);
  process.exit(1);
});
