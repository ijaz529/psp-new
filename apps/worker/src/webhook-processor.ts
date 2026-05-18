import type { Database } from '@psp-new/db';
import { newId } from '@psp-new/ids';
import type { Logger } from '@psp-new/logger';
import {
  type DeliveryOutcome,
  WEBHOOK_DELIVERY_QUEUE,
  type WebhookDeliveryJobData,
  decideRetry,
  deliverWebhook,
} from '@psp-new/webhook-delivery';
import type { Queue } from 'bullmq';
import type { Kysely } from 'kysely';

export interface WebhookProcessorDeps {
  readonly db: Kysely<Database>;
  readonly queue: Queue<WebhookDeliveryJobData>;
  readonly logger: Logger;
  /** Inject for tests. Defaults to the real deliverWebhook. */
  readonly deliver?: typeof deliverWebhook;
}

/**
 * Process one webhook-delivery job. The function is exported so it can be
 * unit-tested without spinning up BullMQ — pass in mock db/queue/deliver.
 */
export async function processWebhookDeliveryJob(
  deps: WebhookProcessorDeps,
  data: WebhookDeliveryJobData,
): Promise<void> {
  const { eventId, endpointId } = data;
  const event = await deps.db.selectFrom('paycore.events').selectAll().where('id', '=', eventId).executeTakeFirst();
  const endpoint = await deps.db
    .selectFrom('paycore.webhook_endpoints')
    .selectAll()
    .where('id', '=', endpointId)
    .executeTakeFirst();

  if (!event) {
    deps.logger.warn({ eventId }, 'webhook job for missing event — dropping');
    return;
  }
  if (!endpoint || endpoint.status !== 'enabled') {
    deps.logger.warn(
      { endpointId, status: endpoint?.status },
      'webhook job for missing/disabled endpoint — dead-letter',
    );
    await insertDeadLetter(deps.db, eventId, endpointId, 'endpoint_deleted', null, 0);
    return;
  }

  const priorAttempts = await countPriorAttempts(deps.db, eventId, endpointId);
  const bodyJson = JSON.stringify({
    id: event.id,
    type: event.type,
    api_version: event.api_version,
    data: event.data,
    livemode: event.livemode,
    created: Math.floor(event.created_at.getTime() / 1000),
  });

  const deliver = deps.deliver ?? deliverWebhook;
  const outcome = await deliver({ url: endpoint.url, secret: endpoint.signing_secret, bodyJson });

  await insertAttempt(deps.db, eventId, endpointId, priorAttempts + 1, outcome);

  const decision = decideRetry({ outcome, priorAttempts: priorAttempts + 1 });
  if (decision.kind === 'success') {
    deps.logger.info({ event_id: eventId, endpoint_id: endpointId, attempt: priorAttempts + 1 }, 'webhook delivered');
    return;
  }
  if (decision.kind === 'dead_letter') {
    deps.logger.warn({ event_id: eventId, endpoint_id: endpointId, reason: decision.reason }, 'webhook dead-lettered');
    const lastError = outcomeError(outcome);
    await insertDeadLetter(deps.db, eventId, endpointId, decision.reason, lastError, priorAttempts + 1);
    return;
  }
  // retry
  deps.logger.info(
    { event_id: eventId, endpoint_id: endpointId, delay_ms: decision.delayMs },
    'webhook retry scheduled',
  );
  await deps.queue.add(
    'deliver',
    { eventId, endpointId },
    { delay: decision.delayMs, jobId: `${eventId}:${endpointId}:${priorAttempts + 1}` },
  );
}

function outcomeError(outcome: DeliveryOutcome): string {
  if (outcome.kind === 'success') return '';
  if (outcome.kind === 'network_error') return outcome.error;
  return `http ${outcome.httpStatus}`;
}

async function countPriorAttempts(db: Kysely<Database>, eventId: string, endpointId: string): Promise<number> {
  const r = await db
    .selectFrom('paycore.webhook_attempts')
    .select((eb) => eb.fn.countAll<bigint | string>().as('n'))
    .where('event_id', '=', eventId)
    .where('endpoint_id', '=', endpointId)
    .executeTakeFirst();
  const v: bigint | string | undefined = r?.n;
  if (v === undefined) return 0;
  return typeof v === 'bigint' ? Number(v) : Number(v);
}

async function insertAttempt(
  db: Kysely<Database>,
  eventId: string,
  endpointId: string,
  attemptNumber: number,
  outcome: DeliveryOutcome,
): Promise<void> {
  await db
    .insertInto('paycore.webhook_attempts')
    .values({
      id: newId('webhook_attempt'),
      event_id: eventId,
      endpoint_id: endpointId,
      attempt_number: attemptNumber,
      http_status: 'httpStatus' in outcome ? outcome.httpStatus : null,
      response_body: 'responseBody' in outcome ? (outcome.responseBody ?? null) : null,
      error: outcome.kind === 'network_error' ? outcome.error : null,
      delivered_at: outcome.kind === 'success' ? new Date() : null,
      next_retry_at: null,
      created_at: new Date(),
    })
    .execute();
}

async function insertDeadLetter(
  db: Kysely<Database>,
  eventId: string,
  endpointId: string,
  reason: 'exceeded_retries' | 'non_retryable_status' | 'endpoint_deleted',
  lastError: string | null,
  attempts: number,
): Promise<void> {
  await db
    .insertInto('paycore.webhook_dead_letter')
    .values({
      id: newId('webhook_dead_letter'),
      event_id: eventId,
      endpoint_id: endpointId,
      reason,
      last_error: lastError,
      failed_after_attempts: attempts,
      created_at: new Date(),
      retried_at: null,
    })
    .execute();
}

export { WEBHOOK_DELIVERY_QUEUE };
