import type { Database } from '@psp-new/db';
import type { Logger } from '@psp-new/logger';
import type { Kysely } from 'kysely';

/**
 * Phase 38 — janitor sweep for expired idempotency keys.
 *
 * The idempotency plugin never deletes: completed rows replay for as long
 * as they exist, and a crashed request leaves a locked row that
 * `processExisting` reports as in-flight forever. The TTL on `expires_at`
 * only becomes real when something removes expired rows — this job is the
 * "janitor sweep" the plugin's comment promises.
 *
 * Two plain DELETEs (merchant + cardholder tables), no batching — MVP row
 * volumes don't warrant subquery batch loops. Idempotent by construction:
 * a second run finds nothing to delete.
 */

export interface JanitorDeps {
  readonly db: Kysely<Database>;
  readonly logger: Logger;
}

export interface JanitorResult {
  readonly merchantDeleted: number;
  readonly cardholderDeleted: number;
}

export async function sweepExpiredIdempotencyKeys(deps: JanitorDeps, asOf: Date = new Date()): Promise<JanitorResult> {
  const merchant = await deps.db
    .deleteFrom('paycore.idempotency_keys')
    .where('expires_at', '<', asOf)
    .executeTakeFirst();
  const cardholder = await deps.db
    .deleteFrom('paycore.cardholder_idempotency_keys')
    .where('expires_at', '<', asOf)
    .executeTakeFirst();

  const result: JanitorResult = {
    merchantDeleted: Number(merchant.numDeletedRows),
    cardholderDeleted: Number(cardholder.numDeletedRows),
  };
  if (result.merchantDeleted > 0 || result.cardholderDeleted > 0) {
    deps.logger.info(result, 'idempotency janitor: expired keys deleted');
  }
  return result;
}
