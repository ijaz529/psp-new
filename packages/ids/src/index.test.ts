import { describe, expect, it } from 'vitest';
import { RESOURCE_PREFIXES, isResourceId, isUlid, newId, parseResourceId } from './index.js';

describe('ids', () => {
  it('newId returns a prefixed sortable id for every kind', () => {
    for (const kind of Object.keys(RESOURCE_PREFIXES) as Array<keyof typeof RESOURCE_PREFIXES>) {
      const id = newId(kind);
      expect(id.startsWith(`${RESOURCE_PREFIXES[kind]}_`)).toBe(true);
      const ulidPart = id.slice(RESOURCE_PREFIXES[kind].length + 1);
      expect(isUlid(ulidPart)).toBe(true);
    }
  });

  it('newId values are unique across N=10_000 invocations', () => {
    const set = new Set<string>();
    for (let i = 0; i < 10_000; i++) set.add(newId('payment_intent'));
    expect(set.size).toBe(10_000);
  });

  it('newId values are monotonically sortable (per-resource event ordering)', () => {
    const ids: string[] = [];
    for (let i = 0; i < 500; i++) ids.push(newId('event'));
    // Monotonic ULID factory guarantees each subsequent ID > previous, even
    // within the same millisecond. No rearrangements allowed.
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]! > ids[i - 1]!).toBe(true);
    }
  });

  it('isResourceId correctly type-guards', () => {
    const id = newId('charge');
    expect(isResourceId(id, 'charge')).toBe(true);
    expect(isResourceId(id, 'refund')).toBe(false);
    expect(isResourceId('not_an_id', 'charge')).toBe(false);
    expect(isResourceId(null, 'charge')).toBe(false);
    expect(isResourceId(undefined, 'charge')).toBe(false);
    expect(isResourceId(123, 'charge')).toBe(false);
  });

  it('parseResourceId round-trips', () => {
    const id = newId('refund');
    const parsed = parseResourceId(id);
    expect(parsed).not.toBeNull();
    expect(parsed?.kind).toBe('refund');
    expect(isUlid(parsed!.ulid)).toBe(true);
  });

  it('parseResourceId returns null on malformed inputs', () => {
    expect(parseResourceId('garbage')).toBeNull();
    expect(parseResourceId('pi_notvalidulid')).toBeNull();
    expect(parseResourceId('unknownprefix_01HXY00000000000000000000Z')).toBeNull();
  });
});
