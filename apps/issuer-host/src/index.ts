import net from 'node:net';
import { createKysely, createPool, dbConfigFromEnv } from '@psp-new/db';
import { createHttpServer } from '@psp-new/http-server';
import { createLogger } from '@psp-new/logger';
import { initTelemetry } from '@psp-new/otel';
import { handleIssuerAuth } from './handler.js';

/**
 * Issuer-host. TCP server (default :9101) that speaks the same 4-byte ASCII
 * length-framed ISO 8583 dialect the scheme-simulator uses. Scheme-simulator
 * routes inbound 0100/0200 by BIN — Strawberry-issued BINs land here.
 *
 * Also exposes /healthz, /readyz, /metrics over HTTP for parity with the
 * other apps.
 */

const FRAME_HEADER_LEN = 4;

interface FrameReader {
  push(chunk: Buffer): Buffer[];
}

function createFrameReader(): FrameReader {
  let buf = Buffer.alloc(0);
  return {
    push(chunk) {
      buf = Buffer.concat([buf, chunk]);
      const out: Buffer[] = [];
      while (buf.length >= FRAME_HEADER_LEN) {
        const lenStr = buf.subarray(0, FRAME_HEADER_LEN).toString('ascii');
        const len = Number.parseInt(lenStr, 10);
        if (!Number.isFinite(len) || len <= 0 || len > 65_000) {
          throw new Error(`bad frame length: ${lenStr}`);
        }
        if (buf.length < FRAME_HEADER_LEN + len) break;
        out.push(buf.subarray(FRAME_HEADER_LEN, FRAME_HEADER_LEN + len));
        buf = buf.subarray(FRAME_HEADER_LEN + len);
      }
      return out;
    },
  };
}

async function main(): Promise<void> {
  const shutdownOtel = await initTelemetry({ serviceName: 'issuer-host' });
  const logger = createLogger({ service: 'issuer-host' });

  const pool = createPool({ ...dbConfigFromEnv(), applicationName: 'issuer-host' });
  const db = createKysely(pool);

  const tcpPort = Number.parseInt(process.env.ISSUER_HOST_TCP_PORT ?? '9101', 10);
  const httpPort = Number.parseInt(process.env.ISSUER_HOST_HTTP_PORT ?? '9102', 10);

  const tcpServer = net.createServer((socket) => {
    const peer = `${socket.remoteAddress}:${socket.remotePort}`;
    logger.info({ peer }, 'issuer-host: peer connected');
    const reader = createFrameReader();

    socket.on('data', async (chunk) => {
      let frames: Buffer[];
      try {
        frames = reader.push(chunk);
      } catch (err) {
        logger.warn({ peer, err: (err as Error).message }, 'issuer-host: bad framing, dropping peer');
        socket.destroy();
        return;
      }
      for (const f of frames) {
        const body = f.toString('ascii');
        let response: string;
        try {
          response = await handleIssuerAuth(body, { db, logger });
        } catch (err) {
          logger.error({ peer, err: (err as Error).message }, 'issuer-host: handler threw');
          continue;
        }
        const frame = Buffer.from(response.length.toString().padStart(4, '0') + response, 'ascii');
        socket.write(frame);
        logger.info({ peer, in_bytes: f.length, out_bytes: response.length }, 'issuer-host: response sent');
      }
    });

    socket.on('close', () => logger.info({ peer }, 'issuer-host: peer closed'));
    socket.on('error', (err) => logger.warn({ peer, err: err.message }, 'issuer-host: socket error'));
  });

  tcpServer.listen(tcpPort, '0.0.0.0', () => {
    logger.info({ port: tcpPort }, 'issuer-host: TCP listening');
  });

  const app = await createHttpServer({
    serviceName: 'issuer-host',
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
    ],
  });
  await app.listen({ port: httpPort, host: '0.0.0.0' });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'issuer-host: shutting down');
    tcpServer.close();
    try {
      await app.close();
      await pool.end();
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
  console.error('issuer-host failed to start', err);
  process.exit(1);
});
