import { describe, expect, it } from 'vitest';
import { type PaymentIntentStatus, type TransitionAction, transitionPaymentIntent } from './state-machine.js';

const AUTO = { capture_method: 'automatic' } as const;
const MANUAL = { capture_method: 'manual' } as const;

describe('transitionPaymentIntent — happy paths', () => {
  it('attach + confirm + auth-approved → succeeded (auto-capture)', () => {
    let s: PaymentIntentStatus = 'requires_payment_method';
    s = step(s, { kind: 'attach_payment_method' }, AUTO);
    expect(s).toBe('requires_confirmation');
    s = step(s, { kind: 'confirm' }, AUTO);
    expect(s).toBe('processing');
    s = step(s, { kind: 'authorization_approved' }, AUTO);
    expect(s).toBe('succeeded');
  });

  it('manual capture leaves auth in requires_capture', () => {
    let s: PaymentIntentStatus = 'requires_confirmation';
    s = step(s, { kind: 'confirm' }, MANUAL);
    s = step(s, { kind: 'authorization_approved' }, MANUAL);
    expect(s).toBe('requires_capture');
    s = step(s, { kind: 'capture' }, MANUAL);
    expect(s).toBe('succeeded');
  });

  it('3DS success path: requires_action → processing → succeeded', () => {
    let s: PaymentIntentStatus = 'requires_action';
    s = step(s, { kind: 'three_ds_complete', success: true }, AUTO);
    expect(s).toBe('processing');
    s = step(s, { kind: 'authorization_approved' }, AUTO);
    expect(s).toBe('succeeded');
  });

  it('3DS failure → failed', () => {
    expect(step('requires_action', { kind: 'three_ds_complete', success: false }, AUTO)).toBe('failed');
  });

  it('3DS entry: requires_confirmation → requires_action (via enter_three_ds_challenge)', () => {
    expect(step('requires_confirmation', { kind: 'enter_three_ds_challenge' }, AUTO)).toBe('requires_action');
  });

  it('decline → failed', () => {
    expect(
      step('processing', { kind: 'authorization_declined', declineCode: 'insufficient_funds', message: 'x' }, AUTO),
    ).toBe('failed');
  });
});

describe('cancel', () => {
  it('cancels every non-terminal state', () => {
    for (const s of [
      'requires_payment_method',
      'requires_confirmation',
      'requires_action',
      'processing',
      'requires_capture',
    ] as PaymentIntentStatus[]) {
      expect(step(s, { kind: 'cancel' }, AUTO)).toBe('canceled');
    }
  });
  it('refuses to cancel terminal states', () => {
    for (const s of ['succeeded', 'canceled', 'failed'] as PaymentIntentStatus[]) {
      const r = transitionPaymentIntent(s, { kind: 'cancel' }, AUTO);
      expect(r.ok).toBe(false);
    }
  });
});

describe('rejected transitions', () => {
  it('cannot confirm from requires_payment_method', () => {
    const r = transitionPaymentIntent('requires_payment_method', { kind: 'confirm' }, AUTO);
    expect(r.ok).toBe(false);
  });
  it('cannot capture from processing', () => {
    const r = transitionPaymentIntent('processing', { kind: 'capture' }, AUTO);
    expect(r.ok).toBe(false);
  });
  it('cannot transition out of terminal states', () => {
    for (const s of ['succeeded', 'canceled', 'failed'] as PaymentIntentStatus[]) {
      const actions: TransitionAction[] = [
        { kind: 'confirm' },
        { kind: 'capture' },
        { kind: 'attach_payment_method' },
        { kind: 'authorization_approved' },
      ];
      for (const a of actions) expect(transitionPaymentIntent(s, a, AUTO).ok).toBe(false);
    }
  });
});

function step(
  from: PaymentIntentStatus,
  action: TransitionAction,
  ctx: { capture_method: 'automatic' | 'manual' },
): PaymentIntentStatus {
  const r = transitionPaymentIntent(from, action, ctx);
  if (!r.ok) throw new Error(`unexpected fail: ${r.reason}`);
  return r.next;
}
