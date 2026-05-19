import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Database } from '@psp-new/db';
import { PspError } from '@psp-new/errors';
import { type ResourceId, newId } from '@psp-new/ids';
import type { FastifyPluginAsync } from 'fastify';
import fastifyPlugin from 'fastify-plugin';
import type { Kysely } from 'kysely';

export type ApiKeyKind = 'publishable' | 'secret';
export type ApiKeyEnv = 'test' | 'live';

export interface GenerateApiKeyOptions {
  readonly kind: ApiKeyKind;
  readonly env: ApiKeyEnv;
}

export interface GeneratedApiKey {
  /** Internal id (ak_<ulid>) — used as the DB primary key. */
  readonly id: ResourceId<'api_key'>;
  /** The raw key string shown to the merchant ONCE. */
  readonly raw: string;
  /** sha256 hex of the raw key — what we store at rest. */
  readonly sha256Hash: string;
  /** First 12 chars of the raw key — stored for display ("pk_test_abcd…"). */
  readonly prefix: string;
  readonly kind: ApiKeyKind;
  readonly env: ApiKeyEnv;
}

/**
 * Build a fresh key.
 *
 * Format: `{pk|sk}_{test|live}_<base64url(32 bytes)>` — 32 random bytes → 43
 * base64url chars → ~256 bits of entropy. No ULID, no creation-time leakage.
 */
export function generateApiKey(opts: GenerateApiKeyOptions): GeneratedApiKey {
  const prefixKind = opts.kind === 'publishable' ? 'pk' : 'sk';
  const random = randomBytes(32).toString('base64url');
  const raw = `${prefixKind}_${opts.env}_${random}`;
  return {
    id: newId('api_key'),
    raw,
    sha256Hash: hashApiKey(raw),
    prefix: raw.slice(0, 12),
    kind: opts.kind,
    env: opts.env,
  };
}

export function hashApiKey(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/* -------------------------------------------------------------------------- */
/* Phase 30 — Cardholder API keys                                              */
/* -------------------------------------------------------------------------- */

export interface GenerateCardholderApiKeyOptions {
  readonly env: ApiKeyEnv;
}

export interface GeneratedCardholderApiKey {
  readonly id: ResourceId<'cardholder_api_key'>;
  readonly raw: string; // 'csk_test_<base64url 32 bytes>' — show ONCE
  readonly sha256Hash: string;
  readonly prefix: string; // first 13 chars: 'csk_test_<6>'
  readonly env: ApiKeyEnv;
}

export function generateCardholderApiKey(opts: GenerateCardholderApiKeyOptions): GeneratedCardholderApiKey {
  const random = randomBytes(32).toString('base64url');
  const raw = `csk_${opts.env}_${random}`;
  return {
    id: newId('cardholder_api_key'),
    raw,
    sha256Hash: hashApiKey(raw),
    prefix: raw.slice(0, 13),
    env: opts.env,
  };
}

export function parseCardholderApiKeyFormat(raw: string): { env: ApiKeyEnv } | null {
  const m = raw.match(/^csk_(test|live)_[A-Za-z0-9_-]{20,}$/);
  if (!m) return null;
  return { env: m[1] as ApiKeyEnv };
}

/**
 * Parse the raw value from an `Authorization: Bearer <key>` header.
 * Strict: no whitespace tolerance, no case folding on "Bearer".
 */
export function parseAuthorizationHeader(value: string | undefined): string | null {
  if (!value) return null;
  const m = value.match(/^Bearer\s+(\S+)$/);
  return m ? (m[1] ?? null) : null;
}

/**
 * Parse the format-bits of an API key into (kind, env). Useful pre-DB lookup.
 * Returns null if the value doesn't match the expected shape — caller decides
 * how to surface the error.
 */
export function parseApiKeyFormat(raw: string): { kind: ApiKeyKind; env: ApiKeyEnv } | null {
  const m = raw.match(/^(pk|sk)_(test|live)_[A-Za-z0-9_-]{20,}$/);
  if (!m) return null;
  return {
    kind: m[1] === 'pk' ? 'publishable' : 'secret',
    env: m[2] as ApiKeyEnv,
  };
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the api-key auth plugin after successful auth. */
    apiKey?: {
      readonly id: string;
      readonly kind: ApiKeyKind;
      readonly env: ApiKeyEnv;
      readonly prefix: string;
    };
    /** Merchant id resolved from the api key. */
    merchantId?: string;
    /** Convenience: api key environment, used by idempotency/webhook plugins. */
    apiKeyEnv?: ApiKeyEnv;
  }
  interface FastifyContextConfig {
    /** Set `skipApiKey: true` on platform routes (/healthz etc.) to skip auth. */
    skipApiKey?: boolean;
    /** Restrict the route to one kind only. */
    requireApiKeyKind?: ApiKeyKind;
  }
}

export interface ApiKeyAuthOptions {
  readonly db: Kysely<Database>;
  /** Paths that bypass auth. Defaults to /healthz /readyz /metrics /openapi.json. */
  readonly skipPaths?: ReadonlyArray<string>;
}

const DEFAULT_SKIP_PATHS = ['/healthz', '/readyz', '/metrics', '/openapi.json', '/'];

const apiKeyAuthAsync: FastifyPluginAsync<ApiKeyAuthOptions> = async (fastify, opts) => {
  const db = opts.db;
  const skipPaths = new Set([...DEFAULT_SKIP_PATHS, ...(opts.skipPaths ?? [])]);

  fastify.addHook('preHandler', async (req) => {
    // Platform routes — skip.
    const bareUrl = req.url.split('?')[0] ?? req.url;
    if (skipPaths.has(bareUrl)) return;
    // Route opt-out via routeOptions.config.
    const cfg = req.routeOptions.config as { skipApiKey?: boolean; requireApiKeyKind?: ApiKeyKind } | undefined;
    if (cfg?.skipApiKey) return;

    const raw = parseAuthorizationHeader(req.headers.authorization);
    if (!raw) throw new PspError('api_key_missing');

    const format = parseApiKeyFormat(raw);
    if (!format) throw new PspError('api_key_invalid');

    const hash = hashApiKey(raw);
    const row = await db
      .selectFrom('paycore.api_keys')
      .select(['id', 'merchant_id', 'kind', 'env', 'prefix', 'revoked_at'])
      .where('sha256_hash', '=', hash)
      .executeTakeFirst();
    if (!row) throw new PspError('api_key_invalid');
    if (row.revoked_at) throw new PspError('api_key_revoked');

    // Constant-time format match — belt-and-braces; the hash above is the
    // real security boundary, but compare format anyway.
    const expectedKind: ApiKeyKind = row.kind as ApiKeyKind;
    if (expectedKind !== format.kind) throw new PspError('api_key_invalid');
    const expectedEnv: ApiKeyEnv = row.env as ApiKeyEnv;
    if (expectedEnv !== format.env) throw new PspError('api_key_invalid');

    // Route-level kind enforcement (e.g. server-side endpoints reject pk_ keys).
    if (cfg?.requireApiKeyKind && cfg.requireApiKeyKind !== expectedKind) {
      throw new PspError('permission_denied', {
        message: `this endpoint requires a ${cfg.requireApiKeyKind} key`,
        internal: { requested: expectedKind, expected: cfg.requireApiKeyKind },
      });
    }

    req.apiKey = { id: row.id, kind: expectedKind, env: expectedEnv, prefix: row.prefix };
    req.merchantId = row.merchant_id;
    req.apiKeyEnv = expectedEnv;

    // Touch last_used_at asynchronously — best-effort, ignore errors.
    void db
      .updateTable('paycore.api_keys')
      .set({ last_used_at: new Date() })
      .where('id', '=', row.id)
      .execute()
      .catch(() => undefined);
  });
};

export const apiKeyAuthPlugin = fastifyPlugin(apiKeyAuthAsync, { name: 'psp-new-api-key-auth' });

/** Constant-time string compare. Useful for client_secret comparisons later. */
export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
