import { type Database, createKysely, createPool, dbConfigFromEnv } from '@psp-new/db';
import type { Authorizer, Reverser, Settler } from '@psp-new/payment-engine';
import { type ServiceAuth, createServiceAuth } from '@psp-new/service-auth';
import { type VaultClient, createVaultClient } from '@psp-new/vault-client';
import type { Kysely } from 'kysely';
import type pg from 'pg';
import { buildAcquirerAuthorizer, buildAcquirerReverser, buildAcquirerSettler } from './authorizer.js';

const KNOWN_SENDERS: ReadonlyArray<string> = ['api', 'acquirer-host', 'worker', 'outbox-relay', 'vault'];

export interface AppContext {
  readonly db: Kysely<Database>;
  readonly pool: pg.Pool;
  readonly vault: VaultClient;
  readonly serviceAuth: ServiceAuth;
  /**
   * Base URL of the scheme-simulator AS THE CUSTOMER's BROWSER reaches it.
   * In dev compose: http://localhost:9002. The api uses this to build the
   * 3DS challenge redirect URL.
   */
  readonly schemeSimulatorPublicUrl: string;
  /** Phase 5: real authorization via acquirer-host (ISO 8583). */
  readonly authorizer: Authorizer;
  /** Phase 10: 0220 capture client. */
  readonly settler: Settler;
  /** Phase 10: 0420 reversal client. */
  readonly reverser: Reverser;
}

export interface AppContextOptions {
  readonly pool?: pg.Pool;
  readonly serviceAuth?: ServiceAuth;
  readonly vault?: VaultClient;
  readonly vaultBaseUrl?: string;
  readonly schemeSimulatorPublicUrl?: string;
  readonly acquirerHostUrl?: string;
  readonly authorizer?: Authorizer;
  readonly settler?: Settler;
  readonly reverser?: Reverser;
}

export function buildAppContext(opts: AppContextOptions = {}): AppContext {
  const pool = opts.pool ?? createPool({ ...dbConfigFromEnv(), applicationName: 'api' });
  const db = createKysely(pool);
  const serviceAuth = opts.serviceAuth ?? buildDefaultServiceAuth();
  const vaultBaseUrl = opts.vaultBaseUrl ?? process.env.VAULT_URL ?? 'http://vault:8081';
  const vault = opts.vault ?? createVaultClient({ baseUrl: vaultBaseUrl, serviceAuth, senderId: 'api' });
  const schemeSimulatorPublicUrl =
    opts.schemeSimulatorPublicUrl ?? process.env.SCHEME_SIMULATOR_PUBLIC_URL ?? 'http://localhost:9002';
  const acquirerHostUrl = opts.acquirerHostUrl ?? process.env.ACQUIRER_HOST_URL ?? 'http://acquirer-host:8082';
  const factoryOpts = { db, serviceAuth, acquirerHostUrl };
  const authorizer = opts.authorizer ?? buildAcquirerAuthorizer(factoryOpts);
  const settler = opts.settler ?? buildAcquirerSettler(factoryOpts);
  const reverser = opts.reverser ?? buildAcquirerReverser(factoryOpts);
  return { db, pool, vault, serviceAuth, schemeSimulatorPublicUrl, authorizer, settler, reverser };
}

function buildDefaultServiceAuth(): ServiceAuth {
  const secret = process.env.SERVICE_AUTH_SECRET;
  if (!secret) throw new Error('SERVICE_AUTH_SECRET is required');
  return createServiceAuth({ secretsBySender: new Map(KNOWN_SENDERS.map((s) => [s, secret])) });
}
