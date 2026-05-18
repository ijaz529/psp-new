/**
 * Authorization-control engine. Pure function, no I/O. The caller (issuer-host)
 * is responsible for loading the card, computing balances, and summing today's
 * holds, then handing those values in.
 *
 * Decline codes follow ISO 8583 DE 39:
 *   05 — Do not honor          (frozen / cancelled card)
 *   51 — Insufficient funds    (available < requested)
 *   61 — Exceeds withdrawal limit (over daily limit)
 *   57 — Transaction not permitted to cardholder (MCC blocked)
 */

export type CardStatus = 'active' | 'frozen' | 'cancelled';

export interface CardForAuth {
  readonly status: CardStatus;
  readonly currency: string;
  readonly controls: CardControls;
}

/** Merged product.default_controls + card.controls overlay. */
export interface CardControls {
  /** Daily spend ceiling, minor units. 0 = unlimited. */
  readonly dailyLimit?: number;
  /** Block these MCC codes — DE 18 matching exact 4-digit string. */
  readonly mccBlocklist?: ReadonlyArray<string>;
}

export interface AuthRequest {
  /** Requested amount, minor units. */
  readonly amount: number;
  readonly currency: string;
  readonly mcc?: string | null;
}

export interface AccountSnapshot {
  /** Available balance (funded − holds) in minor units. */
  readonly available: number;
  /** Sum of authorization holds opened today, in minor units. */
  readonly todayHoldsSum: number;
}

export type AuthDecision =
  | { readonly outcome: 'approve' }
  | { readonly outcome: 'decline'; readonly rc: '05' | '51' | '61' | '57'; readonly reason: string };

export function evaluateAuthControls(card: CardForAuth, request: AuthRequest, balances: AccountSnapshot): AuthDecision {
  // 1. Status — frozen/cancelled cards never authorise.
  if (card.status !== 'active') {
    return { outcome: 'decline', rc: '05', reason: `card status ${card.status}` };
  }

  // 2. Currency match — issuing today is single-currency per card.
  if (card.currency !== request.currency) {
    return {
      outcome: 'decline',
      rc: '05',
      reason: `currency mismatch: card ${card.currency} vs request ${request.currency}`,
    };
  }

  // 3. MCC blocklist (DE 18).
  if (request.mcc && card.controls.mccBlocklist?.includes(request.mcc)) {
    return { outcome: 'decline', rc: '57', reason: `MCC ${request.mcc} is blocked` };
  }

  // 4. Insufficient funds.
  if (balances.available < request.amount) {
    return {
      outcome: 'decline',
      rc: '51',
      reason: `available ${balances.available} < requested ${request.amount}`,
    };
  }

  // 5. Daily limit.
  const dailyLimit = card.controls.dailyLimit ?? 0;
  if (dailyLimit > 0 && balances.todayHoldsSum + request.amount > dailyLimit) {
    return {
      outcome: 'decline',
      rc: '61',
      reason: `daily limit ${dailyLimit} exceeded: ${balances.todayHoldsSum} + ${request.amount}`,
    };
  }

  return { outcome: 'approve' };
}

/** Merge product defaults under a card's per-card overlay. */
export function mergeControls(
  productDefaults: Partial<CardControls> | null | undefined,
  cardOverlay: Partial<CardControls> | null | undefined,
): CardControls {
  const defaults = productDefaults ?? {};
  const overlay = cardOverlay ?? {};
  const dailyLimit = overlay.dailyLimit ?? defaults.dailyLimit;
  const mccBlocklist =
    overlay.mccBlocklist && overlay.mccBlocklist.length > 0 ? overlay.mccBlocklist : defaults.mccBlocklist;
  return {
    ...(dailyLimit !== undefined ? { dailyLimit } : {}),
    ...(mccBlocklist !== undefined ? { mccBlocklist } : {}),
  };
}
