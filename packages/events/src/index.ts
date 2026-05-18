import { createHmac, timingSafeEqual } from 'node:crypto';
import { type ResourceId, newId } from '@psp-new/ids';

/**
 * Canonical event envelope. Every domain event in the system is shaped like this
 * before it reaches the outbox table or a webhook subscriber. Versioned so we can
 * change `data` shapes without breaking subscribers.
 */
export interface EventEnvelope<TType extends string = string, TData = unknown> {
  readonly id: ResourceId<'event'>;
  readonly type: TType;
  /** ISO 8601 UTC, milliseconds. */
  readonly created: string;
  readonly livemode: boolean;
  /** API version snapshot at the time the event was generated. */
  readonly api_version: string;
  readonly data: { readonly object: TData };
  /** Optional resource id this event is about — used for per-resource ordering. */
  readonly resource_id?: string;
  /** Optional idempotency key of the originating request. */
  readonly request_idempotency_key?: string;
}

export interface NewEventInput<TType extends string, TData> {
  readonly type: TType;
  readonly data: TData;
  readonly livemode?: boolean;
  readonly apiVersion?: string;
  readonly resourceId?: string;
  readonly requestIdempotencyKey?: string;
}

export function makeEvent<TType extends string, TData>(
  input: NewEventInput<TType, TData>,
): EventEnvelope<TType, TData> {
  const env: Mutable<EventEnvelope<TType, TData>> = {
    id: newId('event'),
    type: input.type,
    created: new Date().toISOString(),
    livemode: input.livemode ?? false,
    api_version: input.apiVersion ?? '2026-01-01',
    data: { object: input.data },
  };
  if (input.resourceId !== undefined) env.resource_id = input.resourceId;
  if (input.requestIdempotencyKey !== undefined) env.request_idempotency_key = input.requestIdempotencyKey;
  return env as EventEnvelope<TType, TData>;
}

type Mutable<T> = { -readonly [P in keyof T]: T[P] };

/* -------------------------------------------------------------------------- */
/* Webhook signing — Stripe-style header                                       */
/* -------------------------------------------------------------------------- */

/**
 * Build the `Webhook-Signature` (or your service's chosen header) value.
 *   t=<unix-seconds>,v1=<hmac_sha256_hex>
 *
 * Signed payload = `${t}.${rawBody}` — same shape Stripe uses, so subscribers can
 * borrow Stripe's signature-verification snippets.
 */
export function signWebhook(rawBody: string, secret: string, now?: number): string {
  const t = now ?? Math.floor(Date.now() / 1000);
  const payload = `${t}.${rawBody}`;
  const sig = createHmac('sha256', secret).update(payload).digest('hex');
  return `t=${t},v1=${sig}`;
}

export interface VerifyWebhookOpts {
  readonly rawBody: string;
  readonly header: string;
  readonly secret: string;
  readonly toleranceSeconds?: number;
  readonly now?: number;
}

export function verifyWebhook(opts: VerifyWebhookOpts): { ok: true; t: number } | { ok: false; reason: string } {
  const parts: Record<string, string> = {};
  for (const seg of opts.header.split(',')) {
    const eq = seg.indexOf('=');
    if (eq === -1) continue;
    parts[seg.slice(0, eq).trim()] = seg.slice(eq + 1).trim();
  }
  const t = parts.t ? Number.parseInt(parts.t, 10) : Number.NaN;
  const v1 = parts.v1;
  if (Number.isNaN(t) || !v1) return { ok: false, reason: 'malformed_header' };

  const nowS = opts.now ?? Math.floor(Date.now() / 1000);
  const tolerance = opts.toleranceSeconds ?? 300;
  if (Math.abs(nowS - t) > tolerance) return { ok: false, reason: 'timestamp_outside_tolerance' };

  const expected = createHmac('sha256', opts.secret).update(`${t}.${opts.rawBody}`).digest('hex');
  const a = Buffer.from(v1, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'signature_mismatch' };

  return { ok: true, t };
}
