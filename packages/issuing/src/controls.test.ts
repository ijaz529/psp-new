import { describe, expect, it } from 'vitest';
import {
  type AccountSnapshot,
  type AuthRequest,
  type CardForAuth,
  evaluateAuthControls,
  mergeControls,
} from './controls.js';

const activeCard: CardForAuth = {
  status: 'active',
  currency: 'USD',
  controls: { dailyLimit: 10_000, mccBlocklist: ['5912', '7995'] },
};
const balances1k: AccountSnapshot = { available: 100_000, todayHoldsSum: 0 };
const baseReq: AuthRequest = { amount: 1_000, currency: 'USD', mcc: '5411' };

describe('evaluateAuthControls', () => {
  it('approves a happy-path auth', () => {
    expect(evaluateAuthControls(activeCard, baseReq, balances1k)).toEqual({ outcome: 'approve' });
  });

  it('declines a frozen card with RC 05', () => {
    const d = evaluateAuthControls({ ...activeCard, status: 'frozen' }, baseReq, balances1k);
    expect(d).toMatchObject({ outcome: 'decline', rc: '05' });
  });

  it('declines a cancelled card with RC 05', () => {
    const d = evaluateAuthControls({ ...activeCard, status: 'cancelled' }, baseReq, balances1k);
    expect(d).toMatchObject({ outcome: 'decline', rc: '05' });
  });

  it('declines a currency mismatch with RC 05', () => {
    const d = evaluateAuthControls(activeCard, { ...baseReq, currency: 'EUR' }, balances1k);
    expect(d).toMatchObject({ outcome: 'decline', rc: '05' });
  });

  it('declines insufficient funds with RC 51', () => {
    const d = evaluateAuthControls(activeCard, { ...baseReq, amount: 200_000 }, balances1k);
    expect(d).toMatchObject({ outcome: 'decline', rc: '51' });
  });

  it('declines over daily limit with RC 61', () => {
    const d = evaluateAuthControls(
      activeCard,
      { ...baseReq, amount: 5_000 },
      { available: 100_000, todayHoldsSum: 6_000 },
    );
    expect(d).toMatchObject({ outcome: 'decline', rc: '61' });
  });

  it('declines a blocked MCC with RC 57', () => {
    const d = evaluateAuthControls(activeCard, { ...baseReq, mcc: '5912' }, balances1k);
    expect(d).toMatchObject({ outcome: 'decline', rc: '57' });
  });

  it('skips MCC check when MCC is null', () => {
    expect(evaluateAuthControls(activeCard, { ...baseReq, mcc: null }, balances1k)).toEqual({ outcome: 'approve' });
  });

  it('treats dailyLimit=0 as unlimited', () => {
    const noLimit = { ...activeCard, controls: { dailyLimit: 0, mccBlocklist: [] } };
    expect(
      evaluateAuthControls(noLimit, { ...baseReq, amount: 50_000 }, { available: 100_000, todayHoldsSum: 50_000 }),
    ).toEqual({ outcome: 'approve' });
  });

  // Ordering matters — status is the most damning, then currency, then MCC,
  // then balance, then limit. This protects against accidental refactors.
  it('declines on status before checking balance', () => {
    const d = evaluateAuthControls(
      { ...activeCard, status: 'frozen' },
      { ...baseReq, amount: 1_000_000_000 },
      balances1k,
    );
    expect(d).toMatchObject({ outcome: 'decline', rc: '05' });
  });
});

describe('mergeControls', () => {
  it('uses overlay daily limit when set', () => {
    expect(mergeControls({ dailyLimit: 100, mccBlocklist: [] }, { dailyLimit: 50 })).toEqual({
      dailyLimit: 50,
      mccBlocklist: [],
    });
  });
  it('falls back to defaults when overlay is empty', () => {
    expect(mergeControls({ dailyLimit: 100, mccBlocklist: ['5912'] }, {})).toEqual({
      dailyLimit: 100,
      mccBlocklist: ['5912'],
    });
  });
  it('overlay mcc list overrides when non-empty', () => {
    expect(mergeControls({ mccBlocklist: ['5912'] }, { mccBlocklist: ['7995'] })).toEqual({
      dailyLimit: undefined,
      mccBlocklist: ['7995'],
    });
  });
});
