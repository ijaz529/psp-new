import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES, type RuleSet, evaluate } from './index.js';

// Pure-condition tests don't hit velocity, so we can use a no-op fake db.
const FAKE_DB = {} as never;

describe('evaluate', () => {
  it('amount_gt triggers deny', async () => {
    const rs: RuleSet = { version: 'x', rules: [{ name: 'big', if: { amount_gt: 1000 }, then: 'deny' }] };
    const r = await evaluate(FAKE_DB, rs, { merchantId: 'm', tokenId: 't', bin: '411111', amount: 5000 });
    expect(r.outcome).toBe('deny');
    expect(r.triggered).toEqual(['big']);
  });

  it('bin_in match → matched', async () => {
    const rs: RuleSet = { version: 'x', rules: [{ name: 'block', if: { bin_in: ['666666'] }, then: 'deny' }] };
    const r = await evaluate(FAKE_DB, rs, { merchantId: 'm', tokenId: 't', bin: '666666', amount: 100 });
    expect(r.outcome).toBe('deny');
  });

  it('no match → allow', async () => {
    const rs: RuleSet = { version: 'x', rules: [{ name: 'block', if: { bin_in: ['666666'] }, then: 'deny' }] };
    const r = await evaluate(FAKE_DB, rs, { merchantId: 'm', tokenId: 't', bin: '411111', amount: 100 });
    expect(r.outcome).toBe('allow');
    expect(r.triggered).toEqual([]);
  });

  it('review beats allow but loses to deny', async () => {
    const rs: RuleSet = {
      version: 'x',
      rules: [
        { name: 'review_small', if: { amount_gt: 10 }, then: 'review' },
        { name: 'deny_big', if: { amount_gt: 1000 }, then: 'deny' },
      ],
    };
    expect((await evaluate(FAKE_DB, rs, { merchantId: 'm', tokenId: 't', bin: '4', amount: 50 })).outcome).toBe(
      'review',
    );
    expect((await evaluate(FAKE_DB, rs, { merchantId: 'm', tokenId: 't', bin: '4', amount: 5000 })).outcome).toBe(
      'deny',
    );
  });

  it('cvv_result_in', async () => {
    const rs: RuleSet = { version: 'x', rules: [{ name: 'bad_cvv', if: { cvv_result_in: ['fail'] }, then: 'deny' }] };
    expect(
      (await evaluate(FAKE_DB, rs, { merchantId: 'm', tokenId: 't', bin: '4', amount: 1, cvvResult: 'fail' })).outcome,
    ).toBe('deny');
    expect(
      (await evaluate(FAKE_DB, rs, { merchantId: 'm', tokenId: 't', bin: '4', amount: 1, cvvResult: 'pass' })).outcome,
    ).toBe('allow');
  });

  // DEFAULT_RULES exposure check — without the velocity rule (it hits DB).
  const noVelocity: RuleSet = {
    version: DEFAULT_RULES.version,
    rules: DEFAULT_RULES.rules.filter((r) => !('velocity' in r.if)),
  };

  it('DEFAULT_RULES (sans velocity) allows a normal transaction', async () => {
    const r = await evaluate(FAKE_DB, noVelocity, { merchantId: 'm', tokenId: 't', bin: '411111', amount: 1000 });
    expect(r.outcome).toBe('allow');
  });

  it('DEFAULT_RULES (sans velocity) denies a 20M-cent transaction (amount_too_large)', async () => {
    const r = await evaluate(FAKE_DB, noVelocity, { merchantId: 'm', tokenId: 't', bin: '411111', amount: 20_000_000 });
    expect(r.outcome).toBe('deny');
  });
});
