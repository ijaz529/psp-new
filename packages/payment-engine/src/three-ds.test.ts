import { describe, expect, it } from 'vitest';
import { decideThreeDs, makeThreeDsResult } from './three-ds.js';

describe('decideThreeDs', () => {
  it('never → no 3DS regardless of BIN', () => {
    expect(decideThreeDs({ bin: '400000', scheme: 'visa', requestThreeDSecure: 'never' })).toEqual({
      required: false,
      mode: 'none',
    });
  });

  it('any → forces challenge', () => {
    expect(decideThreeDs({ bin: '411111', scheme: 'visa', requestThreeDSecure: 'any' })).toEqual({
      required: true,
      mode: 'challenge',
    });
  });

  it('automatic + 400000 Visa BIN → challenge', () => {
    expect(decideThreeDs({ bin: '400000', scheme: 'visa', requestThreeDSecure: 'automatic' })).toEqual({
      required: true,
      mode: 'challenge',
    });
  });

  it('automatic + 555555 MC BIN → frictionless', () => {
    expect(decideThreeDs({ bin: '555555', scheme: 'mastercard', requestThreeDSecure: 'automatic' })).toEqual({
      required: true,
      mode: 'frictionless',
    });
  });

  it('automatic + plain 411111 BIN → no 3DS', () => {
    expect(decideThreeDs({ bin: '411111', scheme: 'visa', requestThreeDSecure: 'automatic' })).toEqual({
      required: false,
      mode: 'none',
    });
  });
});

describe('makeThreeDsResult', () => {
  it('Visa approve → ECI 05 + transStatus Y', () => {
    const r = makeThreeDsResult({ scheme: 'visa', outcome: 'approve' });
    expect(r.success).toBe(true);
    expect(r.eci).toBe('05');
    expect(r.transStatus).toBe('Y');
    expect(r.cavv).toBeTruthy();
  });
  it('Mastercard approve → ECI 02', () => {
    expect(makeThreeDsResult({ scheme: 'mastercard', outcome: 'approve' }).eci).toBe('02');
  });
  it('decline → success=false, no CAVV', () => {
    const r = makeThreeDsResult({ scheme: 'visa', outcome: 'decline' });
    expect(r.success).toBe(false);
    expect(r.cavv).toBeNull();
    expect(r.transStatus).toBe('N');
  });
  it('attempted → success=true with ECI 06 (Visa) for liability shift', () => {
    const r = makeThreeDsResult({ scheme: 'visa', outcome: 'attempted' });
    expect(r.success).toBe(true);
    expect(r.eci).toBe('06');
  });
});
