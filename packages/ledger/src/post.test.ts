import { describe, expect, it } from 'vitest';
import { validate as validatePostInput } from './post.js';
import type { PostJournalInput, Posting } from './types.js';

function p(accountId: string, amount: bigint, currency = 'USD'): Posting {
  return { accountId: accountId as Posting['accountId'], amount, currency };
}

function inp(postings: Posting[]): PostJournalInput {
  return {
    externalId: 'ext_test',
    description: 'test',
    occurredAt: new Date('2026-05-18T00:00:00Z'),
    postings,
  };
}

describe('validate(PostJournalInput)', () => {
  it('accepts a minimal balanced 2-line entry', () => {
    expect(() => validatePostInput(inp([p('acct_a', 100n), p('acct_b', -100n)]))).not.toThrow();
  });

  it('accepts a multi-line balanced entry', () => {
    expect(() => validatePostInput(inp([p('acct_a', 1000n), p('acct_b', -970n), p('acct_c', -30n)]))).not.toThrow();
  });

  it('rejects single-posting entries', () => {
    expect(() => validatePostInput(inp([p('acct_a', 100n)]))).toThrowError(/at least 2 postings/);
  });

  it('rejects unbalanced entries', () => {
    expect(() => validatePostInput(inp([p('acct_a', 100n), p('acct_b', -50n)]))).toThrowError(/unbalanced/);
    expect(() => validatePostInput(inp([p('acct_a', 100n), p('acct_b', -100n), p('acct_c', 1n)]))).toThrowError(
      /unbalanced/,
    );
  });

  it('rejects mixed-currency entries', () => {
    expect(() => validatePostInput(inp([p('acct_a', 100n, 'USD'), p('acct_b', -100n, 'EUR')]))).toThrowError(
      /mixes currencies/,
    );
  });

  it('rejects zero-amount postings', () => {
    expect(() => validatePostInput(inp([p('acct_a', 100n), p('acct_b', -100n), p('acct_c', 0n)]))).toThrowError(
      /zero-amount/,
    );
  });

  it('handles very large amounts (BigInt range)', () => {
    const big = 9_999_999_999_999_999n;
    expect(() => validatePostInput(inp([p('acct_a', big), p('acct_b', -big)]))).not.toThrow();
  });
});
