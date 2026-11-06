import type { Database } from '@psp-new/db';
import type { PaymentIntentRecord, RefundRecord } from '@psp-new/payment-engine';
import { bigintToWire, dateToUnix } from './serialize.js';

/* -------------------------------------------------------------------------- */
/* PaymentIntent                                                               */
/* -------------------------------------------------------------------------- */

export interface PaymentIntentWire {
  id: string;
  object: 'payment_intent';
  amount: number;
  amount_received: number;
  amount_capturable: number;
  currency: string;
  status: string;
  capture_method: 'automatic' | 'manual';
  confirmation_method: 'automatic' | 'manual';
  client_secret: string;
  customer: string | null;
  payment_method: string | null;
  metadata: Record<string, unknown> | null;
  last_payment_error: { code: string; message: string; decline_code?: string } | null;
  next_action: { type: 'three_ds_redirect'; redirect_url: string; three_ds_session_id: string } | null;
  livemode: boolean;
  created: number;
}

export function paymentIntentToWire(pi: PaymentIntentRecord): PaymentIntentWire {
  const out: PaymentIntentWire = {
    id: pi.id,
    object: 'payment_intent',
    amount: bigintToWire(pi.amount),
    amount_received: bigintToWire(pi.amountReceived),
    amount_capturable: bigintToWire(pi.amountCapturable),
    currency: pi.currency,
    status: pi.status,
    capture_method: pi.captureMethod,
    confirmation_method: pi.confirmationMethod,
    client_secret: pi.clientSecret,
    customer: pi.customerId,
    payment_method: pi.paymentMethodId,
    metadata: pi.metadata,
    last_payment_error: null,
    next_action: pi.nextAction,
    livemode: pi.livemode,
    created: dateToUnix(pi.created),
  };
  if (pi.lastPaymentError) {
    const lpe: PaymentIntentWire['last_payment_error'] = {
      code: pi.lastPaymentError.code,
      message: pi.lastPaymentError.message,
    };
    if (pi.lastPaymentError.declineCode) lpe.decline_code = pi.lastPaymentError.declineCode;
    out.last_payment_error = lpe;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Refund                                                                      */
/* -------------------------------------------------------------------------- */

export interface RefundWire {
  id: string;
  object: 'refund';
  payment_intent: string;
  amount: number;
  currency: string;
  status: 'succeeded';
  reason: string | null;
  metadata: Record<string, unknown> | null;
  created: number;
}

export function refundToWire(r: RefundRecord): RefundWire {
  return {
    id: r.id,
    object: 'refund',
    payment_intent: r.paymentIntentId,
    amount: bigintToWire(r.amount),
    currency: r.currency,
    status: r.status,
    reason: r.reason ?? null,
    metadata: r.metadata,
    created: dateToUnix(r.created),
  };
}

/* -------------------------------------------------------------------------- */
/* Customer / PaymentMethod (DB row shape)                                     */
/* -------------------------------------------------------------------------- */

export function customerToWire(row: Database['paycore.customers']) {
  return {
    id: row.id,
    object: 'customer' as const,
    email: row.email,
    name: row.name,
    description: row.description,
    metadata: (row.metadata as Record<string, unknown> | null) ?? null,
    created: dateToUnix(row.created_at),
  };
}

export function paymentMethodToWire(row: Database['paycore.payment_methods']) {
  return {
    id: row.id,
    object: 'payment_method' as const,
    type: 'card' as const,
    customer: row.customer_id,
    card: {
      brand: row.scheme,
      last4: row.last4,
      exp_month: row.exp_month,
      exp_year: row.exp_year,
      bin: row.bin,
    },
    created: dateToUnix(row.created_at),
  };
}

export function webhookEndpointToWire(row: Database['paycore.webhook_endpoints'], includeSecret = false) {
  const base = {
    id: row.id,
    object: 'webhook_endpoint' as const,
    url: row.url,
    description: row.description,
    enabled_events: row.enabled_events,
    status: row.status,
    created: dateToUnix(row.created_at),
  };
  return includeSecret ? { ...base, secret: row.signing_secret } : base;
}

export function eventToWire(row: Database['paycore.events']) {
  return {
    id: row.id,
    object: 'event' as const,
    type: row.type,
    api_version: row.api_version,
    data: row.data,
    livemode: row.livemode,
    created: dateToUnix(row.created_at),
  };
}
