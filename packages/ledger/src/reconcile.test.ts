import { describe, expect, it } from 'vitest';
import { reconcile } from './reconcile.js';
import type { Posting } from './types.js';

function p(accountId: string, amount: bigint, currency = 'USD'): Posting {
  return { accountId: accountId as Posting['accountId'], amount, currency };
}

describe('reconcile', () => {
  it('returns empty unmatched sets when both sides are equal', () => {
    const internal = [p('a', 100n), p('b', -100n)];
    const external = [p('b', -100n), p('a', 100n)];
    const r = reconcile(internal, external);
    expect(r.unmatchedInternal).toEqual([]);
    expect(r.unmatchedExternal).toEqual([]);
  });

  it('reports unmatched internal when external is missing a counterpart', () => {
    const internal = [p('a', 100n), p('b', -100n), p('c', 50n)];
    const external = [p('a', 100n), p('b', -100n)];
    const r = reconcile(internal, external);
    expect(r.unmatchedInternal).toEqual([p('c', 50n)]);
    expect(r.unmatchedExternal).toEqual([]);
  });

  it('reports unmatched external when internal is missing', () => {
    const internal = [p('a', 100n)];
    const external = [p('a', 100n), p('b', 999n)];
    const r = reconcile(internal, external);
    expect(r.unmatchedInternal).toEqual([]);
    expect(r.unmatchedExternal).toEqual([p('b', 999n)]);
  });

  it('respects multiplicity — two identical internals match two identical externals', () => {
    const internal = [p('a', 100n), p('a', 100n)];
    const external = [p('a', 100n), p('a', 100n)];
    const r = reconcile(internal, external);
    expect(r.unmatchedInternal).toEqual([]);
    expect(r.unmatchedExternal).toEqual([]);
  });

  it('respects multiplicity — two internals, one external leaves one unmatched', () => {
    const internal = [p('a', 100n), p('a', 100n)];
    const external = [p('a', 100n)];
    const r = reconcile(internal, external);
    expect(r.unmatchedInternal).toEqual([p('a', 100n)]);
    expect(r.unmatchedExternal).toEqual([]);
  });

  it('treats different currencies as different keys', () => {
    const internal = [p('a', 100n, 'USD')];
    const external = [p('a', 100n, 'EUR')];
    const r = reconcile(internal, external);
    expect(r.unmatchedInternal).toEqual([p('a', 100n, 'USD')]);
    expect(r.unmatchedExternal).toEqual([p('a', 100n, 'EUR')]);
  });

  it('treats different signs as different keys (debit ≠ credit)', () => {
    const internal = [p('a', 100n)];
    const external = [p('a', -100n)];
    const r = reconcile(internal, external);
    expect(r.unmatchedInternal).toEqual([p('a', 100n)]);
    expect(r.unmatchedExternal).toEqual([p('a', -100n)]);
  });

  it('empty inputs → empty outputs', () => {
    const r = reconcile([], []);
    expect(r.unmatchedInternal).toEqual([]);
    expect(r.unmatchedExternal).toEqual([]);
  });
});
