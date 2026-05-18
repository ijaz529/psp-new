import { sql } from 'drizzle-orm';
import { bigint, index, integer, jsonb, pgSchema, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

export const paycoreSchema = pgSchema('paycore');

export const merchants = paycoreSchema.table(
  'merchants',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    env: text('env').notNull(), // 'test' | 'live'
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => ({
    envIdx: index('merchants_env_idx').on(t.env),
  }),
);

export const apiKeys = paycoreSchema.table(
  'api_keys',
  {
    id: text('id').primaryKey(),
    merchantId: text('merchant_id').notNull(),
    kind: text('kind').notNull(), // 'publishable' | 'secret'
    env: text('env').notNull(), // 'test' | 'live'
    prefix: text('prefix').notNull(), // pk_test_... up to first 12 chars, for display
    sha256Hash: text('sha256_hash').notNull(), // only the hash is stored
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'date' }),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => ({
    hashIdx: uniqueIndex('api_keys_sha256_idx').on(t.sha256Hash),
    merchantIdx: index('api_keys_merchant_idx').on(t.merchantId),
  }),
);

export const idempotencyKeys = paycoreSchema.table(
  'idempotency_keys',
  {
    merchantId: text('merchant_id').notNull(),
    key: text('key').notNull(),
    method: text('method').notNull(),
    path: text('path').notNull(),
    requestHash: text('request_hash').notNull(),
    responseStatus: integer('response_status'),
    responseBody: jsonb('response_body'),
    lockedAt: timestamp('locked_at', { withTimezone: true, mode: 'date' }),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => ({
    pk: uniqueIndex('idempotency_keys_pk').on(t.merchantId, t.key),
    expiresIdx: index('idempotency_keys_expires_idx').on(t.expiresAt),
  }),
);

export const outbox = paycoreSchema.table(
  'outbox',
  {
    id: text('id').primaryKey(),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').notNull(),
    headers: jsonb('headers'),
    resourceId: text('resource_id'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    lockedAt: timestamp('locked_at', { withTimezone: true, mode: 'date' }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true, mode: 'date' }),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
  },
  (t) => ({
    undeliveredIdx: index('outbox_undelivered_idx').on(t.deliveredAt, t.createdAt),
    resourceIdx: index('outbox_resource_idx').on(t.resourceId),
  }),
);

/**
 * Schema-level migration tracking table. The migrator inserts a row per applied
 * migration. Used by both `migrate up` (skip applied) and `reset` (truncate).
 */
export const schemaMigrations = paycoreSchema.table('_schema_migrations', {
  filename: text('filename').primaryKey(),
  appliedAt: timestamp('applied_at', { withTimezone: true, mode: 'date' }).notNull().default(sql`now()`),
  checksumSha256: text('checksum_sha256').notNull(),
});

// Cast bigint to silence "unused-import" lint warnings if we don't reference it.
// (Will be used in Phase 1 ledger amount columns.)
void bigint;
