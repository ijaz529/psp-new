import type { Posting } from './types.js';

export interface ReconcileResult {
  readonly unmatchedInternal: ReadonlyArray<Posting>;
  readonly unmatchedExternal: ReadonlyArray<Posting>;
}

/**
 * Two-bag set-difference reconciliation. Given two sets of postings (internal
 * ledger lines vs external scheme/bank file), return the lines that don't have
 * a counterpart in the other set.
 *
 * Match key: `(accountId, amount, currency)`. Multiplicity matters — if you
 * have two identical postings on the internal side and only one external,
 * one stays unmatched.
 *
 * This is a pure function; the caller decides what to do with the unmatched
 * sets (open a manual-review queue, write an `unallocated_settlements` entry,
 * etc.).
 */
export function reconcile(internal: ReadonlyArray<Posting>, external: ReadonlyArray<Posting>): ReconcileResult {
  const bag = new Map<string, Posting[]>();
  for (const p of internal) {
    const k = keyOf(p);
    let arr = bag.get(k);
    if (!arr) {
      arr = [];
      bag.set(k, arr);
    }
    arr.push(p);
  }

  const unmatchedExternal: Posting[] = [];
  for (const p of external) {
    const arr = bag.get(keyOf(p));
    if (arr && arr.length > 0) arr.pop();
    else unmatchedExternal.push(p);
  }

  const unmatchedInternal: Posting[] = [];
  for (const arr of bag.values()) unmatchedInternal.push(...arr);

  return { unmatchedInternal, unmatchedExternal };
}

function keyOf(p: Posting): string {
  return `${p.accountId}|${p.amount}|${p.currency}`;
}
