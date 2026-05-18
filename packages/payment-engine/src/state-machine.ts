/**
 * PaymentIntent state machine — Stripe-mirror.
 *
 *                ┌──────────────────────────┐
 *                │ requires_payment_method  │
 *                └──────────────┬───────────┘
 *                  attach_pm   │
 *                              ▼
 *                ┌──────────────────────────┐
 *                │   requires_confirmation  │
 *                └──────────────┬───────────┘
 *                   confirm    │
 *                  (3DS off in Phase 3)
 *                              ▼
 *                ┌──────────────────────────┐
 *                │       processing         │
 *                └──────────────┬───────────┘
 *                authorization_approved
 *           ┌──────────────────┴───────────────────┐
 *           ▼ (capture_method=automatic)           ▼ (capture_method=manual)
 *      succeeded                            requires_capture
 *                                                  │
 *                                            capture
 *                                                  ▼
 *                                            succeeded
 *
 *   cancel: requires_payment_method | requires_confirmation | requires_action |
 *           requires_capture → canceled
 *   authorization_declined: processing → failed
 *
 * Phase 4 adds `requires_action` for 3DS challenge.
 * Phase 5 replaces the always-approve stub with real ISO 8583.
 */

export type PaymentIntentStatus =
  | 'requires_payment_method'
  | 'requires_confirmation'
  | 'requires_action'
  | 'processing'
  | 'requires_capture'
  | 'succeeded'
  | 'canceled'
  | 'failed';

export type CaptureMethod = 'automatic' | 'manual';
export type ConfirmationMethod = 'automatic' | 'manual';

export type TransitionAction =
  | { kind: 'attach_payment_method' }
  | { kind: 'confirm' }
  | { kind: 'enter_three_ds_challenge' }
  | { kind: 'three_ds_complete'; success: boolean }
  | { kind: 'authorization_approved' }
  | { kind: 'authorization_declined'; declineCode: string; message: string }
  | { kind: 'capture' }
  | { kind: 'cancel' };

export interface TransitionContext {
  readonly capture_method: CaptureMethod;
}

export type TransitionResult = { ok: true; next: PaymentIntentStatus } | { ok: false; reason: string };

export function transitionPaymentIntent(
  from: PaymentIntentStatus,
  action: TransitionAction,
  ctx: TransitionContext,
): TransitionResult {
  // Cancel is universal (except from terminal).
  if (action.kind === 'cancel') {
    if (from === 'succeeded' || from === 'canceled' || from === 'failed') {
      return { ok: false, reason: `cannot cancel from terminal state '${from}'` };
    }
    return { ok: true, next: 'canceled' };
  }

  switch (from) {
    case 'requires_payment_method':
      if (action.kind === 'attach_payment_method') return { ok: true, next: 'requires_confirmation' };
      return invalid(from, action.kind);

    case 'requires_confirmation':
      if (action.kind === 'confirm') return { ok: true, next: 'processing' };
      if (action.kind === 'enter_three_ds_challenge') return { ok: true, next: 'requires_action' };
      return invalid(from, action.kind);

    case 'requires_action':
      if (action.kind === 'three_ds_complete') {
        return action.success ? { ok: true, next: 'processing' } : { ok: true, next: 'failed' };
      }
      return invalid(from, action.kind);

    case 'processing':
      if (action.kind === 'authorization_approved') {
        return { ok: true, next: ctx.capture_method === 'automatic' ? 'succeeded' : 'requires_capture' };
      }
      if (action.kind === 'authorization_declined') return { ok: true, next: 'failed' };
      return invalid(from, action.kind);

    case 'requires_capture':
      if (action.kind === 'capture') return { ok: true, next: 'succeeded' };
      return invalid(from, action.kind);

    case 'succeeded':
    case 'canceled':
    case 'failed':
      return { ok: false, reason: `cannot transition from terminal state '${from}'` };

    default: {
      const _exhaustive: never = from;
      void _exhaustive;
      return { ok: false, reason: `unknown state ${from as string}` };
    }
  }
}

function invalid(from: PaymentIntentStatus, action: TransitionAction['kind']): TransitionResult {
  return { ok: false, reason: `invalid transition: ${action} not valid from '${from}'` };
}
