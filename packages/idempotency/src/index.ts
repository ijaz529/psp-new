import type { Database } from '@psp-new/db';
import { PspError } from '@psp-new/errors';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fastifyPlugin from 'fastify-plugin';
import type { Kysely } from 'kysely';
import { hashRequestBody } from './hash.js';

export { canonicalize, hashRequestBody, sha256 } from './hash.js';

const IDEMPOTENCY_KEY_REGEX = /^[A-Za-z0-9_-]{1,255}$/;
const REPLAY_HEADER = 'idempotency-replay';

export interface IdempotencyOptions {
  readonly db: Kysely<Database>;
  /** Resolve merchant id from the authenticated request. Default extracts from `request.merchantId`. */
  readonly resolveMerchantId?: (req: FastifyRequest) => string | undefined;
  /** Idempotency TTL in seconds (default 24h). */
  readonly ttlSeconds?: number;
  /** Allow callers to opt-out per route by setting `routeOptions.idempotency = false`. */
}

declare module 'fastify' {
  interface FastifyRequest {
    /** The validated Idempotency-Key for this request, if any. */
    idempotencyKey?: string;
    /** Merchant id (set by upstream auth plugin; we read it here). */
    merchantId?: string;
  }
  interface FastifyContextConfig {
    /** Set `idempotency: false` on a route to disable enforcement (rarely needed). */
    idempotency?: boolean;
  }
}

interface CachedRow {
  request_hash: string;
  response_status: number | null;
  response_body: unknown | null;
  locked_at: Date | null;
  completed_at: Date | null;
  expires_at: Date;
}

const idempotencyPluginAsync: FastifyPluginAsync<IdempotencyOptions> = async (fastify, opts) => {
  const db = opts.db;
  const ttl = (opts.ttlSeconds ?? 86_400) * 1000;
  const resolveMerchantId = opts.resolveMerchantId ?? ((req) => req.merchantId);

  fastify.addHook('preHandler', async (req, reply) => {
    // Only state-changing methods need idempotency.
    const method = req.method.toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;

    // Route can opt-out.
    const routeIdempotency = (req.routeOptions.config as { idempotency?: boolean } | undefined)?.idempotency;
    if (routeIdempotency === false) return;

    const rawKey = req.headers['idempotency-key'];
    const key = Array.isArray(rawKey) ? rawKey[0] : rawKey;

    if (!key) {
      throw new PspError('idempotency_key_missing');
    }
    if (!IDEMPOTENCY_KEY_REGEX.test(key)) {
      throw new PspError('idempotency_key_invalid');
    }

    const merchantId = resolveMerchantId(req);
    if (!merchantId) {
      // Idempotency requires auth context. If we don't have it, the auth plugin
      // should have rejected first; treat as internal misconfiguration.
      throw new PspError('internal_error', {
        internal: { reason: 'idempotency plugin found no merchant id on request' },
      });
    }

    const requestHash = hashRequestBody(req.body ?? null);

    const result = await db.transaction().execute(async (trx) => {
      const existing = await trx
        .selectFrom('paycore.idempotency_keys')
        .select(['request_hash', 'response_status', 'response_body', 'locked_at', 'completed_at', 'expires_at'])
        .where('merchant_id', '=', merchantId)
        .where('key', '=', key)
        .forUpdate()
        .executeTakeFirst();

      if (existing) {
        return processExisting(existing as CachedRow, requestHash);
      }

      // Fresh — lock it and let the handler run.
      await trx
        .insertInto('paycore.idempotency_keys')
        .values({
          merchant_id: merchantId,
          key,
          method,
          path: req.url,
          request_hash: requestHash,
          response_status: null,
          response_body: null,
          locked_at: new Date(),
          completed_at: null,
          expires_at: new Date(Date.now() + ttl),
          created_at: new Date(),
        })
        .execute();
      return { kind: 'fresh' as const };
    });

    if (result.kind === 'replay') {
      reply.header(REPLAY_HEADER, 'true');
      reply.status(result.status);
      reply.send(result.body);
      return;
    }
    if (result.kind === 'locked') {
      throw new PspError('idempotency_key_in_use');
    }
    if (result.kind === 'body_mismatch') {
      throw new PspError('idempotency_key_reused_with_different_body');
    }
    // Fresh — record key on the request so the response hook can write it back.
    req.idempotencyKey = key;
  });

  fastify.addHook('onSend', async (req: FastifyRequest, reply: FastifyReply, payload) => {
    const key = req.idempotencyKey;
    if (!key) return payload;

    const merchantId = resolveMerchantId(req);
    if (!merchantId) return payload;

    let bodyJson: unknown = null;
    if (typeof payload === 'string') {
      try {
        bodyJson = JSON.parse(payload);
      } catch {
        bodyJson = payload;
      }
    }
    const status = reply.statusCode;

    // Only persist responses for "successful" or "definitive" outcomes.
    // 5xx remains marked as locked so the merchant can safely retry.
    if (status >= 500) return payload;

    await db
      .updateTable('paycore.idempotency_keys')
      .set({
        response_status: status,
        response_body: bodyJson,
        completed_at: new Date(),
        locked_at: null,
      })
      .where('merchant_id', '=', merchantId)
      .where('key', '=', key)
      .execute();

    return payload;
  });
};

export const idempotencyPlugin = fastifyPlugin(idempotencyPluginAsync, { name: 'psp-new-idempotency' });

export type ProcessResult =
  | { kind: 'fresh' }
  | { kind: 'replay'; status: number; body: unknown }
  | { kind: 'locked' }
  | { kind: 'body_mismatch' };

/** Pure decision function — exported for unit tests. */
export function processExisting(row: CachedRow, requestHash: string, now: Date = new Date()): ProcessResult {
  if (row.request_hash !== requestHash) {
    return { kind: 'body_mismatch' };
  }
  if (row.completed_at !== null && row.response_status !== null) {
    return { kind: 'replay', status: row.response_status, body: row.response_body };
  }
  // Locked or pending. Treat as in-flight unless expired.
  if (row.expires_at.getTime() < now.getTime()) {
    // Stale lock — caller may retry; we still surface as locked so the merchant
    // backs off, and a janitor sweep will remove the row.
    return { kind: 'locked' };
  }
  return { kind: 'locked' };
}
