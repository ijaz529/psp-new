import { createHash } from 'node:crypto';

/**
 * Canonicalize a JSON-like value: sort object keys recursively, then stringify.
 * Used so `{a:1,b:2}` and `{b:2,a:1}` hash identically.
 *
 * Restrictions:
 *  - undefined values inside arrays become null (JSON.stringify behavior)
 *  - bigint values are converted to `${n}n` strings so the hash is stable
 *  - Date is stringified to ISO 8601
 *  - Map/Set/symbols: not supported (we never serialize those at the API edge)
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (typeof v === 'bigint') return `${v}n`;
    if (v instanceof Date) return v.toISOString();
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.keys(v as Record<string, unknown>)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = (v as Record<string, unknown>)[k];
          return acc;
        }, {});
    }
    return v;
  });
}

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export function hashRequestBody(body: unknown): string {
  return sha256(canonicalize(body));
}
