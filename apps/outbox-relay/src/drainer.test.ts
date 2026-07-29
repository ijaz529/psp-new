import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Database, createKysely, createPool, dbConfigFromEnv, migrateUp } from '@psp-new/db';
import { newId } from '@psp-new/ids';
import { createLogger } from '@psp-new/logger';
import type { WebhookDeliveryJobData } from '@psp-new/webhook-delivery';
import type { Queue } from 'bullmq';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drainOnce, endpointMatchesEvent } from './drainer.js';

/**
 * Phase 26 — outbox drainer routes by cardholder_id when set.
 * HAS_DB-gated integration test using an in-memory queue stub.
 */
const HAS_DB = !!process.env.DATABASE_URL;
const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', '..', '..', 'packages', 'db', 'migrations');

interface EnqueuedJob {
  name: string;
  data: WebhookDeliveryJobData;
  opts: { jobId?: string };
}

function makeQueueStub(): { queue: Queue<WebhookDeliveryJobData>; jobs: EnqueuedJob[] } {
  const jobs: EnqueuedJob[] = [];
  const queue = {
    add: async (name: string, data: WebhookDeliveryJobData, opts: { jobId?: string } = {}) => {
      jobs.push({ name, data, opts });
      return { id: opts.jobId } as unknown;
    },
  } as unknown as Queue<WebhookDeliveryJobData>;
  return { queue, jobs };
}

describe.skipIf(!HAS_DB)('outbox drainer — cardholder routing', () => {
  let pool: ReturnType<typeof createPool>;
  let db: Kysely<Database>;
  const logger = createLogger({ service: 'drainer-test', level: 'warn' });

  beforeAll(async () => {
    pool = createPool({ ...dbConfigFromEnv(), applicationName: 'drainer-test' });
    db = createKysely(pool);
    await migrateUp(pool, MIGRATIONS_DIR);
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
  });

  it('fans out a cardholder-headered outbox row to that cardholder’s enabled endpoint', async () => {
    const cardholderId = newId('cardholder');
    await db
      .insertInto('paycore.cardholders')
      .values({
        id: cardholderId,
        email: `${cardholderId}@example.test`,
        full_name: 'Drainer Test',
        phone: null,
        status: 'active',
        created_at: new Date(),
      })
      .execute();

    const endpointId = newId('webhook_endpoint');
    await db
      .insertInto('paycore.webhook_endpoints')
      .values({
        id: endpointId,
        merchant_id: null,
        cardholder_id: cardholderId,
        url: 'https://example.test/wh',
        description: null,
        enabled_events: ['*'],
        signing_secret: 'whsec_test',
        status: 'enabled',
        created_at: new Date(),
        disabled_at: null,
      })
      .execute();

    const eventId = newId('event');
    const outboxId = newId('outbox_event');
    await db
      .insertInto('paycore.outbox')
      .values({
        id: outboxId,
        event_type: 'card.frozen',
        payload: { id: eventId, type: 'card.frozen' },
        headers: { cardholder_id: cardholderId },
        resource_id: null,
        created_at: new Date(),
        locked_at: null,
        delivered_at: null,
        attempts: 0,
        last_error: null,
      })
      .execute();

    const { queue, jobs } = makeQueueStub();
    const count = await drainOnce({ db, queue, logger, batchSize: 10 });

    expect(count).toBeGreaterThanOrEqual(1);
    const myJob = jobs.find((j) => j.data.endpointId === endpointId && j.data.eventId === eventId);
    expect(myJob).toBeDefined();

    const after = await db
      .selectFrom('paycore.outbox')
      .select('delivered_at')
      .where('id', '=', outboxId)
      .executeTakeFirst();
    expect(after?.delivered_at).not.toBeNull();
  });
});

describe('endpointMatchesEvent — pure routing rules (Phase 40)', () => {
  it('unscoped endpoint matches by event type', () => {
    expect(endpointMatchesEvent({ enabledEvents: ['*'], cardId: null }, { type: 'card.frozen' })).toBe(true);
    expect(endpointMatchesEvent({ enabledEvents: ['card.frozen'], cardId: null }, { type: 'card.frozen' })).toBe(true);
    expect(
      endpointMatchesEvent({ enabledEvents: ['card.frozen'], cardId: null }, { type: 'card_load.succeeded' }),
    ).toBe(false);
  });

  it('unscoped endpoint matches events with or without a card id', () => {
    expect(
      endpointMatchesEvent({ enabledEvents: ['*'], cardId: null }, { type: 'card.frozen', cardId: 'card_a' }),
    ).toBe(true);
  });

  it('card-scoped endpoint matches only its own card', () => {
    const scoped = { enabledEvents: ['*'], cardId: 'card_a' };
    expect(endpointMatchesEvent(scoped, { type: 'card.frozen', cardId: 'card_a' })).toBe(true);
    expect(endpointMatchesEvent(scoped, { type: 'card.frozen', cardId: 'card_b' })).toBe(false);
  });

  it('card-scoped endpoint never matches an event without a card id', () => {
    expect(endpointMatchesEvent({ enabledEvents: ['*'], cardId: 'card_a' }, { type: 'cardholder.updated' })).toBe(
      false,
    );
  });

  it('type filter still applies to card-scoped endpoints', () => {
    expect(
      endpointMatchesEvent(
        { enabledEvents: ['card.frozen'], cardId: 'card_a' },
        { type: 'card_load.succeeded', cardId: 'card_a' },
      ),
    ).toBe(false);
  });
});
