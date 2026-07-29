import type { Database } from '@psp-new/db';
import type { Logger } from '@psp-new/logger';
import { WEBHOOK_DELIVERY_QUEUE, type WebhookDeliveryJobData } from '@psp-new/webhook-delivery';
import type { Queue } from 'bullmq';
import { type Kysely, sql } from 'kysely';

const SKIP_LOCKED = sql`SKIP LOCKED`;

export interface DrainOptions {
  readonly db: Kysely<Database>;
  readonly queue: Queue<WebhookDeliveryJobData>;
  readonly logger: Logger;
  readonly batchSize?: number;
}

/**
 * One drain pass. Claims a batch of undelivered outbox rows with
 * `FOR UPDATE SKIP LOCKED`, finds matching webhook_endpoints, enqueues a
 * job per (event, endpoint), marks the outbox row delivered.
 *
 * Returns the number of outbox rows processed (regardless of how many jobs
 * were enqueued — an event with no subscribers still counts).
 */
/**
 * Phase 40 — pure routing rules for one (endpoint, event) pair:
 *   - event type must be enabled (`*` or exact match);
 *   - an unscoped endpoint (cardId null) matches any event;
 *   - a card-scoped endpoint matches only events carrying the same
 *     card id — events without one never reach a scoped endpoint.
 */
export function endpointMatchesEvent(
  endpoint: { enabledEvents: ReadonlyArray<string>; cardId: string | null },
  event: { type: string; cardId?: string },
): boolean {
  if (!endpoint.enabledEvents.includes('*') && !endpoint.enabledEvents.includes(event.type)) return false;
  if (endpoint.cardId === null) return true;
  return event.cardId === endpoint.cardId;
}

export async function drainOnce(opts: DrainOptions): Promise<number> {
  const claimed = await opts.db.transaction().execute(async (trx) => {
    const rows = await trx
      .selectFrom('paycore.outbox')
      .selectAll()
      .where('delivered_at', 'is', null)
      .where('locked_at', 'is', null)
      .orderBy('created_at', 'asc')
      .limit(opts.batchSize ?? 50)
      .forUpdate()
      .modifyEnd(SKIP_LOCKED)
      .execute();
    if (rows.length === 0) return [];
    await trx
      .updateTable('paycore.outbox')
      .set({ locked_at: new Date() })
      .where(
        'id',
        'in',
        rows.map((r) => r.id),
      )
      .execute();
    return rows;
  });

  for (const row of claimed) {
    try {
      const envelope = row.payload as { id?: string; type?: string };
      const headers = (row.headers as { merchant_id?: string; cardholder_id?: string; card_id?: string } | null) ?? {};
      const ownerKey: { kind: 'merchant' | 'cardholder'; id: string } | null = headers.merchant_id
        ? { kind: 'merchant', id: headers.merchant_id }
        : headers.cardholder_id
          ? { kind: 'cardholder', id: headers.cardholder_id }
          : null;

      if (!ownerKey || !envelope?.id || !envelope?.type) {
        await opts.db
          .updateTable('paycore.outbox')
          .set({ delivered_at: new Date(), locked_at: null, last_error: 'missing owner / envelope' })
          .where('id', '=', row.id)
          .execute();
        continue;
      }

      const endpoints = await opts.db
        .selectFrom('paycore.webhook_endpoints')
        .select(['id', 'enabled_events', 'card_id'])
        .where(ownerKey.kind === 'merchant' ? 'merchant_id' : 'cardholder_id', '=', ownerKey.id)
        .where('status', '=', 'enabled')
        .execute();
      const matching = endpoints.filter((ep) =>
        endpointMatchesEvent(
          { enabledEvents: ep.enabled_events, cardId: ep.card_id },
          { type: envelope.type as string, ...(headers.card_id ? { cardId: headers.card_id } : {}) },
        ),
      );

      for (const ep of matching) {
        await opts.queue.add(
          'deliver',
          { eventId: envelope.id, endpointId: ep.id },
          { jobId: `${envelope.id}:${ep.id}` },
        );
      }

      await opts.db
        .updateTable('paycore.outbox')
        .set({ delivered_at: new Date(), locked_at: null })
        .where('id', '=', row.id)
        .execute();

      opts.logger.debug(
        { outbox_id: row.id, event_id: envelope.id, type: envelope.type, fanout: matching.length },
        'outbox row drained',
      );
    } catch (err) {
      opts.logger.error({ err, outbox_id: row.id }, 'drain failed for row');
      await opts.db
        .updateTable('paycore.outbox')
        .set({ locked_at: null, attempts: sql`attempts + 1`, last_error: (err as Error).message })
        .where('id', '=', row.id)
        .execute();
    }
  }
  return claimed.length;
}

void WEBHOOK_DELIVERY_QUEUE; // re-exported for callers
