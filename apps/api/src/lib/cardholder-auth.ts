/**
 * Phase 30 — Cardholder API auth.
 *
 * Sits alongside the merchant `apiKeyAuthPlugin`. Routes opt in via
 * `config.requireCardholderKey: true`; those routes ALSO set
 * `config.skipApiKey: true` so the merchant plugin doesn't reject the
 * `csk_` bearer as malformed (it requires pk_/sk_).
 *
 * Resolves `Authorization: Bearer csk_<env>_<hex>` against
 * paycore.cardholder_api_keys, sets `req.cardholderId`, touches
 * `last_used_at` async.
 */

import { hashApiKey, parseAuthorizationHeader, parseCardholderApiKeyFormat } from '@psp-new/api-keys';
import type { Database } from '@psp-new/db';
import { PspError } from '@psp-new/errors';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import fastifyPlugin from 'fastify-plugin';
import type { Kysely } from 'kysely';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the cardholder-auth plugin after successful auth. */
    cardholderId?: string;
    cardholderApiKeyId?: string;
  }
  interface FastifyContextConfig {
    /** Opt-in: this route requires a cardholder csk_ key. Also set skipApiKey:true. */
    requireCardholderKey?: boolean;
  }
}

export interface CardholderAuthOptions {
  readonly db: Kysely<Database>;
}

const cardholderAuthAsync: FastifyPluginAsync<CardholderAuthOptions> = async (fastify, opts) => {
  const db = opts.db;
  fastify.addHook('preHandler', async (req) => {
    const cfg = req.routeOptions.config as { requireCardholderKey?: boolean } | undefined;
    if (!cfg?.requireCardholderKey) return;

    const raw = parseAuthorizationHeader(req.headers.authorization);
    if (!raw) throw new PspError('api_key_missing');
    const format = parseCardholderApiKeyFormat(raw);
    if (!format) throw new PspError('api_key_invalid');

    const hash = hashApiKey(raw);
    const row = await db
      .selectFrom('paycore.cardholder_api_keys')
      .select(['id', 'cardholder_id', 'env', 'revoked_at'])
      .where('sha256_hash', '=', hash)
      .executeTakeFirst();
    if (!row) throw new PspError('api_key_invalid');
    if (row.revoked_at) throw new PspError('api_key_revoked');
    if (row.env !== format.env) throw new PspError('api_key_invalid');

    req.cardholderId = row.cardholder_id;
    req.cardholderApiKeyId = row.id;

    void db
      .updateTable('paycore.cardholder_api_keys')
      .set({ last_used_at: new Date() })
      .where('id', '=', row.id)
      .execute()
      .catch(() => undefined);
  });
};

export const cardholderAuthPlugin = fastifyPlugin(cardholderAuthAsync, { name: 'psp-new-cardholder-auth' });

export function getCardholderId(req: FastifyRequest): string {
  const c = req.cardholderId;
  if (!c) {
    throw new PspError('internal_error', {
      message: 'cardholder context missing — cardholder-auth plugin misconfigured',
    });
  }
  return c;
}
