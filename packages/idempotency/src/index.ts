import type { Database } from '@psp-new/db';
import { PspError } from '@psp-new/errors';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fastifyPlugin from 'fastify-plugin';
import type { Kysely, Transaction } from 'kysely';
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
    /** Cardholder id (set by upstream cardholder-auth plugin; we read it here). */
    cardholderId?: string;
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

type Principal = { kind: 'merchant'; id: string } | { kind: 'cardholder'; id: string };

const CACHED_COLS = [
  'request_hash',
  'response_status',
  'response_body',
  'locked_at',
  'completed_at',
  'expires_at',
] as const;

async function loadExisting(
  trx: Transaction<Database>,
  principal: Principal,
  key: string,
): Promise<CachedRow | undefined> {
  if (principal.kind === 'cardholder') {
    return (await trx
      .selectFrom('paycore.cardholder_idempotency_keys')
      .select(CACHED_COLS)
      .where('cardholder_id', '=', principal.id)
      .where('key', '=', key)
      .forUpdate()
      .executeTakeFirst()) as CachedRow | undefined;
  }
  return (await trx
    .selectFrom('paycore.idempotency_keys')
    .select(CACHED_COLS)
    .where('merchant_id', '=', principal.id)
    .where('key', '=', key)
    .forUpdate()
    .executeTakeFirst()) as CachedRow | undefined;
}

async function insertFresh(
  trx: Transaction<Database>,
  principal: Principal,
  key: string,
  method: string,
  path: string,
  requestHash: string,
  expiresAt: Date,
): Promise<void> {
  const now = new Date();
  if (principal.kind === 'cardholder') {
    await trx
      .insertInto('paycore.cardholder_idempotency_keys')
      .values({
        cardholder_id: principal.id,
        key,
        method,
        path,
        request_hash: requestHash,
        response_status: null,
        response_body: null,
        locked_at: now,
        completed_at: null,
        expires_at: expiresAt,
        created_at: now,
      })
      .execute();
    return;
  }
  await trx
    .insertInto('paycore.idempotency_keys')
    .values({
      merchant_id: principal.id,
      key,
      method,
      path,
      request_hash: requestHash,
      response_status: null,
      response_body: null,
      locked_at: now,
      completed_at: null,
      expires_at: expiresAt,
      created_at: now,
    })
    .execute();
}

async function writeCompleted(
  db: Kysely<Database>,
  principal: Principal,
  key: string,
  status: number,
  body: unknown,
): Promise<void> {
  const completed = new Date();
  if (principal.kind === 'cardholder') {
    await db
      .updateTable('paycore.cardholder_idempotency_keys')
      .set({ response_status: status, response_body: body, completed_at: completed, locked_at: null })
      .where('cardholder_id', '=', principal.id)
      .where('key', '=', key)
      .execute();
    return;
  }
  await db
    .updateTable('paycore.idempotency_keys')
    .set({ response_status: status, response_body: body, completed_at: completed, locked_at: null })
    .where('merchant_id', '=', principal.id)
    .where('key', '=', key)
    .execute();
}

const idempotencyPluginAsync: FastifyPluginAsync<IdempotencyOptions> = async (fastify, opts) => {
  const db = opts.db;
  const ttl = (opts.ttlSeconds ?? 86_400) * 1000;
  const resolveMerchantId = opts.resolveMerchantId ?? ((req) => req.merchantId);

  const resolvePrincipal = (req: FastifyRequest): Principal | undefined => {
    // Cardholder auth wins if both somehow set (defensive — auth plugins shouldn't overlap).
    if (req.cardholderId) return { kind: 'cardholder', id: req.cardholderId };
    const mid = resolveMerchantId(req);
    if (mid) return { kind: 'merchant', id: mid };
    return undefined;
  };

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

    const principal = resolvePrincipal(req);
    if (!principal) {
      // Idempotency requires auth context. If we don't have it, the auth plugin
      // should have rejected first; treat as internal misconfiguration.
      throw new PspError('internal_error', {
        internal: { reason: 'idempotency plugin found no principal id on request' },
      });
    }

    const requestHash = hashRequestBody(req.body ?? null);

    const result = await db.transaction().execute(async (trx) => {
      const existing = await loadExisting(trx, principal, key);
      if (existing) {
        return processExisting(existing, requestHash);
      }
      await insertFresh(trx, principal, key, method, req.url, requestHash, new Date(Date.now() + ttl));
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

    const principal = resolvePrincipal(req);
    if (!principal) return payload;

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
    // 5xx remains marked as locked so the caller can safely retry.
    if (status >= 500) return payload;

    await writeCompleted(db, principal, key, status, bodyJson);

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
    // Stale lock — caller may retry; we still surface as locked so the caller
    // backs off, and a janitor sweep will remove the row.
    return { kind: 'locked' };
  }
  return { kind: 'locked' };
}
