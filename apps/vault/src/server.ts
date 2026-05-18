import { createKysely, createPool, dbConfigFromEnv } from '@psp-new/db';
import { createHttpServer } from '@psp-new/http-server';
import { type KmsProvider, createKmsProviderFromEnv } from '@psp-new/kms';
import { type Logger, createLogger } from '@psp-new/logger';
import { type ServiceAuth, createServiceAuth } from '@psp-new/service-auth';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { serviceAuthPlugin } from './lib/service-auth-hook.js';
import { registerDetokenizeRoute } from './routes/detokenize.js';
import { registerTokenizeRoute } from './routes/tokenize.js';

export interface BuildVaultOpts {
  readonly dbPool?: pg.Pool;
  readonly kms?: KmsProvider;
  readonly serviceAuth?: ServiceAuth;
  readonly logger?: Logger;
}

const KNOWN_SENDERS: ReadonlyArray<string> = ['api', 'acquirer-host', 'worker', 'outbox-relay'];

export async function buildVault(opts: BuildVaultOpts = {}): Promise<FastifyInstance> {
  const logger = opts.logger ?? createLogger({ service: 'vault' });
  const pool = opts.dbPool ?? createPool({ ...dbConfigFromEnv(), applicationName: 'vault' });
  const db = createKysely(pool);
  const kms = opts.kms ?? createKmsProviderFromEnv();

  const sharedSecret = process.env.SERVICE_AUTH_SECRET;
  if (!sharedSecret) throw new Error('SERVICE_AUTH_SECRET is required for vault');
  const serviceAuth =
    opts.serviceAuth ?? createServiceAuth({ secretsBySender: new Map(KNOWN_SENDERS.map((s) => [s, sharedSecret])) });

  const app = await createHttpServer({
    serviceName: 'vault',
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

  await app.register(serviceAuthPlugin, { auth: serviceAuth });
  registerTokenizeRoute(app, { db, kms });
  registerDetokenizeRoute(app, { db, kms });

  app.addHook('onClose', async () => {
    await pool.end();
  });

  return app;
}
