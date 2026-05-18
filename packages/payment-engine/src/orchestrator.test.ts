import { describe, expect, it } from 'vitest';
import { capturePostings, refundPostings } from './orchestrator.js';

describe('capturePostings (Phase 3 MDR=3%)', () => {
  it('1000 USD via visa → balanced 3-line: 1000 / -970 / -30', () => {
    const postings = capturePostings({
      merchantSettlementAccount: 'acct_msla' as never,
      scheme: 'visa',
      amount: 1000n,
      currency: 'USD',
    });
    expect(postings).toHaveLength(3);
    const sum = postings.reduce((acc, p) => acc + p.amount, 0n);
    expect(sum).toBe(0n);
    // First line is scheme_receivable debit
    expect(postings[0]?.amount).toBe(1000n);
    // Last line is mdr_revenue at 3% credit
    expect(postings[2]?.amount).toBe(-30n);
  });

  it('amounts that yield fractional MDR are floor-rounded (debit-positive)', () => {
    // 333 cents * 300 bps = 9.99 → floor 9
    const postings = capturePostings({
      merchantSettlementAccount: 'acct_msla' as never,
      scheme: 'visa',
      amount: 333n,
      currency: 'USD',
    });
    const sum = postings.reduce((acc, p) => acc + p.amount, 0n);
    expect(sum).toBe(0n);
    expect(postings[2]?.amount).toBe(-9n);
    expect(postings[1]?.amount).toBe(-(333n - 9n));
  });
});

describe('refundPostings', () => {
  it('exactly mirrors capturePostings sign-wise', () => {
    const args = {
      merchantSettlementAccount: 'acct_msla' as never,
      scheme: 'visa' as const,
      amount: 1000n,
      currency: 'USD',
    };
    const cap = capturePostings(args);
    const ref = refundPostings(args);
    expect(ref).toHaveLength(3);
    const sum = ref.reduce((acc, p) => acc + p.amount, 0n);
    expect(sum).toBe(0n);
    // Each posting is the negation of the matching capture posting.
    for (let i = 0; i < 3; i++) expect(ref[i]?.amount).toBe(-cap[i]!.amount);
  });
});
