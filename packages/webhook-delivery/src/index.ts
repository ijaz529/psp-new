import { signWebhook } from '@psp-new/events';

export const WEBHOOK_DELIVERY_QUEUE = 'webhook-delivery';

/**
 * Retry schedule per PROJECT_BRIEF.md §3 Phase 3:
 *   1m, 5m, 30m, 2h, 12h, 24h → dead-letter
 *
 * Length = max retry attempts. The Nth retry uses delays[N-1].
 */
export const RETRY_DELAYS_MS: ReadonlyArray<number> = [60_000, 300_000, 1_800_000, 7_200_000, 43_200_000, 86_400_000];

export interface WebhookDeliveryJobData {
  readonly eventId: string;
  readonly endpointId: string;
}

export type DeliveryOutcome =
  | { kind: 'success'; httpStatus: number; responseBody?: string }
  | { kind: 'non_retryable_4xx'; httpStatus: number; responseBody?: string }
  | { kind: 'retryable_5xx'; httpStatus: number; responseBody?: string }
  | { kind: 'network_error'; error: string };

export type RetryDecision =
  | { kind: 'success' }
  | { kind: 'dead_letter'; reason: 'non_retryable_status' | 'exceeded_retries' }
  | { kind: 'retry'; delayMs: number };

/**
 * Pure function: given an attempt outcome + how many prior attempts there were,
 * decide what to do next.
 *
 * `priorAttempts` is the count BEFORE this attempt (so the first attempt has 0
 * priorAttempts). The next retry uses `RETRY_DELAYS_MS[priorAttempts]`.
 */
export function decideRetry(opts: {
  outcome: DeliveryOutcome;
  priorAttempts: number;
}): RetryDecision {
  if (opts.outcome.kind === 'success') return { kind: 'success' };
  if (opts.outcome.kind === 'non_retryable_4xx') {
    return { kind: 'dead_letter', reason: 'non_retryable_status' };
  }
  const next = RETRY_DELAYS_MS[opts.priorAttempts];
  if (next === undefined) return { kind: 'dead_letter', reason: 'exceeded_retries' };
  return { kind: 'retry', delayMs: next };
}

/* -------------------------------------------------------------------------- */
/* deliver() — does the actual HTTP POST                                       */
/* -------------------------------------------------------------------------- */

export interface DeliverOptions {
  readonly url: string;
  readonly secret: string;
  readonly bodyJson: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  /** Inject for tests; defaults to Date.now() / 1000. */
  readonly now?: () => number;
}

export async function deliverWebhook(opts: DeliverOptions): Promise<DeliveryOutcome> {
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const signature = signWebhook(opts.bodyJson, opts.secret, now());

  try {
    const res = await fetchImpl(opts.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'webhook-signature': signature,
        'user-agent': 'strawberry-webhooks/1.0',
      },
      body: opts.bodyJson,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text().catch(() => '');
    if (res.status >= 200 && res.status < 300) {
      return { kind: 'success', httpStatus: res.status, responseBody: text.slice(0, 1024) };
    }
    if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
      // 408 (timeout) and 429 (rate limit) ARE retryable; everything else 4xx isn't.
      return { kind: 'non_retryable_4xx', httpStatus: res.status, responseBody: text.slice(0, 1024) };
    }
    return { kind: 'retryable_5xx', httpStatus: res.status, responseBody: text.slice(0, 1024) };
  } catch (err) {
    return { kind: 'network_error', error: (err as Error).message };
  }
}
