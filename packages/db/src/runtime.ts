import pg from 'pg';
import { configurePgTypes } from './kysely.js';

export interface DbConfig {
  readonly url: string;
  readonly maxConnections?: number;
  readonly idleTimeoutMillis?: number;
  readonly applicationName?: string;
}

export function createPool(cfg: DbConfig): pg.Pool {
  configurePgTypes();
  return new pg.Pool({
    connectionString: cfg.url,
    max: cfg.maxConnections ?? 10,
    idleTimeoutMillis: cfg.idleTimeoutMillis ?? 30_000,
    application_name: cfg.applicationName,
  });
}

export function dbConfigFromEnv(env: NodeJS.ProcessEnv = process.env): DbConfig {
  const url = env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const cfg: { url: string; maxConnections?: number; applicationName?: string } = { url };
  if (env.DATABASE_MAX_CONNECTIONS) cfg.maxConnections = Number.parseInt(env.DATABASE_MAX_CONNECTIONS, 10);
  if (env.APP_NAME) cfg.applicationName = env.APP_NAME;
  return cfg;
}
