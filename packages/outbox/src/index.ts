import type { Database } from '@psp-new/db';
import { type ResourceId, newId } from '@psp-new/ids';
import type { Kysely, Transaction } from 'kysely';

export interface OutboxPublishInput {
  readonly eventType: string;
  readonly payload: unknown;
  /** Optional per-resource id (drives outbox_resource_idx for per-resource ordering). */
  readonly resourceId?: string;
  /** Arbitrary headers to forward to subscribers (e.g. trace_id). */
  readonly headers?: Record<string, unknown>;
}

export interface OutboxRecord {
  readonly id: ResourceId<'outbox_event'>;
  readonly eventType: string;
  readonly createdAt: Date;
}

/**
 * Publish an event to the outbox INSIDE an existing transaction. This is the
 * canonical pattern for "atomic state change + event"; never call this outside
 * a transaction wrapping the business write.
 *
 * Returns the inserted row metadata so the caller can correlate logs / traces.
 */
export async function publish(
  trx: Transaction<Database> | Kysely<Database>,
  input: OutboxPublishInput,
): Promise<OutboxRecord> {
  const id = newId('outbox_event');
  const now = new Date();
  await trx
    .insertInto('paycore.outbox')
    .values({
      id,
      event_type: input.eventType,
      payload: input.payload as unknown,
      headers: input.headers ?? null,
      resource_id: input.resourceId ?? null,
      created_at: now,
      locked_at: null,
      delivered_at: null,
      attempts: 0,
      last_error: null,
    })
    .execute();
  return { id, eventType: input.eventType, createdAt: now };
}

/**
 * Drainer-side: claim a batch of undelivered events with `FOR UPDATE SKIP LOCKED`.
 * Returns the rows; the caller is responsible for marking them delivered/failed.
 * Phase 0 only ships the query shape; the drainer worker lives in apps/outbox-relay.
 */
export interface ClaimedEvent {
  readonly id: string;
  readonly eventType: string;
  readonly payload: unknown;
  readonly headers: unknown;
  readonly resourceId: string | null;
  readonly attempts: number;
}

export async function claimBatch(db: Kysely<Database>, batchSize: number): Promise<ClaimedEvent[]> {
  const rows = await db.transaction().execute(async (trx) => {
    const claimed = await trx
      .selectFrom('paycore.outbox')
      .select(['id', 'event_type', 'payload', 'headers', 'resource_id', 'attempts'])
      .where('delivered_at', 'is', null)
      .where('locked_at', 'is', null)
      .orderBy('created_at', 'asc')
      .limit(batchSize)
      .forUpdate()
      .modifyEnd(SKIP_LOCKED)
      .execute();
    if (claimed.length === 0) return [];
    await trx
      .updateTable('paycore.outbox')
      .set({ locked_at: new Date() })
      .where(
        'id',
        'in',
        claimed.map((r) => r.id),
      )
      .execute();
    return claimed;
  });
  return rows.map((r) => ({
    id: r.id,
    eventType: r.event_type,
    payload: r.payload,
    headers: r.headers,
    resourceId: r.resource_id,
    attempts: r.attempts,
  }));
}

// Kysely 0.27 has no first-class SKIP LOCKED; this is the documented escape hatch.
import { type RawBuilder, sql } from 'kysely';
const SKIP_LOCKED: RawBuilder<unknown> = sql`SKIP LOCKED`;

export async function markDelivered(db: Kysely<Database>, id: string): Promise<void> {
  await db
    .updateTable('paycore.outbox')
    .set({ delivered_at: new Date(), last_error: null })
    .where('id', '=', id)
    .execute();
}

export async function markFailed(db: Kysely<Database>, id: string, error: string): Promise<void> {
  await db
    .updateTable('paycore.outbox')
    .set({ locked_at: null, attempts: sql`attempts + 1`, last_error: error })
    .where('id', '=', id)
    .execute();
}
