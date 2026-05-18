import { describe, expect, it } from 'vitest';
import { ERROR_DEFINITIONS, PspError, getErrorDefinition, isKnownErrorCode, isPspError } from './index.js';

describe('error codes table', () => {
  it('has unique codes', () => {
    const codes = new Set(ERROR_DEFINITIONS.map((d) => d.code));
    expect(codes.size).toBe(ERROR_DEFINITIONS.length);
  });

  it('isKnownErrorCode discriminates', () => {
    expect(isKnownErrorCode('card_declined')).toBe(true);
    expect(isKnownErrorCode('not_a_real_code')).toBe(false);
  });

  it('getErrorDefinition returns the entry', () => {
    const d = getErrorDefinition('idempotency_key_in_use');
    expect(d.httpStatus).toBe(409);
    expect(d.category).toBe('idempotency');
    expect(d.retryable).toBe(true);
  });

  it('every entry has plausible httpStatus (4xx/5xx)', () => {
    for (const d of ERROR_DEFINITIONS) {
      expect(d.httpStatus).toBeGreaterThanOrEqual(400);
      expect(d.httpStatus).toBeLessThan(600);
    }
  });

  it('ships at least 35 codes (PROJECT_BRIEF §F)', () => {
    expect(ERROR_DEFINITIONS.length).toBeGreaterThanOrEqual(35);
  });
});

describe('PspError', () => {
  it('default message from codes table', () => {
    const e = new PspError('card_declined');
    expect(e.message).toBe('The card was declined.');
    expect(e.httpStatus).toBe(402);
    expect(e.type).toBe('card_error');
    expect(e.category).toBe('provider');
  });

  it('overrides apply', () => {
    const e = new PspError('card_declined', {
      message: 'Your card has insufficient funds.',
      declineCode: 'insufficient_funds',
      param: 'payment_method',
      internal: { iso8583_rc: '51' },
    });
    expect(e.message).toBe('Your card has insufficient funds.');
    expect(e.declineCode).toBe('insufficient_funds');
    expect(e.param).toBe('payment_method');
  });

  it('toWireEnvelope shapes Stripe-style', () => {
    const e = new PspError('card_declined', {
      message: 'Your card has insufficient funds.',
      declineCode: 'insufficient_funds',
      param: 'payment_method',
    });
    expect(e.toWireEnvelope('req_01ABC')).toEqual({
      error: {
        type: 'card_error',
        code: 'card_declined',
        decline_code: 'insufficient_funds',
        message: 'Your card has insufficient funds.',
        param: 'payment_method',
        request_id: 'req_01ABC',
      },
    });
  });

  it('toWireEnvelope omits undefined fields cleanly', () => {
    const e = new PspError('internal_error');
    const out = e.toWireEnvelope('req_xyz');
    expect(out.error).not.toHaveProperty('decline_code');
    expect(out.error).not.toHaveProperty('param');
    expect(out.error.request_id).toBe('req_xyz');
  });

  it('internal context is NOT in the merchant envelope', () => {
    const e = new PspError('database_error', { internal: { table: 'payment_intents', cause: 'deadlock' } });
    const out = e.toWireEnvelope('req_xyz');
    expect(JSON.stringify(out)).not.toContain('table');
    expect(JSON.stringify(out)).not.toContain('deadlock');
  });

  it('isPspError discriminates', () => {
    expect(isPspError(new PspError('internal_error'))).toBe(true);
    expect(isPspError(new Error('not a psp error'))).toBe(false);
    expect(isPspError('string')).toBe(false);
    expect(isPspError(null)).toBe(false);
  });
});
