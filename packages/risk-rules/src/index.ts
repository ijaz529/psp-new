import type { Database } from '@psp-new/db';
import { newId } from '@psp-new/ids';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';

/**
 * A tiny JSON DSL. Each rule has `name`, `if` (condition), `then` (outcome),
 * and optional `score` (added to running risk score on match).
 *
 * Conditions (only the listed forms — no general expressions, no eval):
 *   - `amount_gt`: { amount_gt: number }              // amount in minor units
 *   - `amount_lt`: { amount_lt: number }
 *   - `bin_in`: { bin_in: string[] }                  // first 6 of PAN, exact match
 *   - `cvv_result_in`: { cvv_result_in: string[] }    // 'pass' | 'fail' | 'unknown'
 *   - `velocity`: { velocity: { scope, window_seconds, max_count, max_amount? } }
 *       scope: 'token' (per token id) — Phase 7 ships only this scope
 *
 * Outcomes: 'allow' | 'review' | 'deny'.
 */
export type RuleOutcome = 'allow' | 'review' | 'deny';

export type Condition =
  | { readonly amount_gt: number }
  | { readonly amount_lt: number }
  | { readonly bin_in: ReadonlyArray<string> }
  | { readonly cvv_result_in: ReadonlyArray<string> }
  | {
      readonly velocity: {
        readonly scope: 'token';
        readonly window_seconds: number;
        readonly max_count: number;
        readonly max_amount?: number;
      };
    };

export interface Rule {
  readonly name: string;
  readonly if: Condition;
  readonly then: RuleOutcome;
  readonly score?: number;
}

export interface RuleSet {
  readonly version: string;
  readonly rules: ReadonlyArray<Rule>;
}

export interface EvalInput {
  readonly merchantId: string;
  readonly tokenId: string;
  readonly bin: string;
  readonly amount: number;
  readonly cvvResult?: 'pass' | 'fail' | 'unknown';
}

export interface EvalResult {
  readonly outcome: RuleOutcome;
  readonly score: number;
  readonly triggered: ReadonlyArray<string>;
  readonly evidence: Record<string, unknown>;
}

/** Pure evaluator. Asynchronous because the velocity check needs the DB. */
export async function evaluate(db: Kysely<Database>, ruleSet: RuleSet, input: EvalInput): Promise<EvalResult> {
  const triggered: string[] = [];
  const evidence: Record<string, unknown> = {};
  let score = 0;
  let worst: RuleOutcome = 'allow';

  for (const rule of ruleSet.rules) {
    const hit = await testCondition(db, rule.if, input);
    if (hit.matched) {
      triggered.push(rule.name);
      score += rule.score ?? 100;
      if (rule.then === 'deny') worst = 'deny';
      else if (rule.then === 'review' && worst !== 'deny') worst = 'review';
      Object.assign(evidence, hit.evidence ?? {});
    }
  }

  return { outcome: worst, score, triggered, evidence };
}

interface CondResult {
  readonly matched: boolean;
  readonly evidence?: Record<string, unknown>;
}

async function testCondition(db: Kysely<Database>, cond: Condition, input: EvalInput): Promise<CondResult> {
  if ('amount_gt' in cond) {
    return { matched: input.amount > cond.amount_gt, evidence: { amount: input.amount } };
  }
  if ('amount_lt' in cond) {
    return { matched: input.amount < cond.amount_lt, evidence: { amount: input.amount } };
  }
  if ('bin_in' in cond) {
    return { matched: cond.bin_in.includes(input.bin), evidence: { bin: input.bin } };
  }
  if ('cvv_result_in' in cond) {
    const v = input.cvvResult ?? 'unknown';
    return { matched: cond.cvv_result_in.includes(v), evidence: { cvv_result: v } };
  }
  if ('velocity' in cond) {
    const v = cond.velocity;
    const row = (
      await sql<{ count: number; total: string }>`
      select count, total from paycore.velocity_for_token(${input.merchantId}, ${input.tokenId}, ${v.window_seconds})
    `.execute(db)
    ).rows[0];
    const count = Number(row?.count ?? 0);
    const total = BigInt(row?.total ?? '0');
    const tooMany = count > v.max_count;
    const tooMuch = v.max_amount !== undefined && total > BigInt(v.max_amount);
    return {
      matched: tooMany || tooMuch,
      evidence: { velocity_count: count, velocity_total: total.toString(), window_seconds: v.window_seconds },
    };
  }
  return { matched: false };
}

/** Persist the decision. Returns the inserted row id. */
export async function recordDecision(
  db: Kysely<Database>,
  args: {
    merchantId: string;
    paymentIntentId: string;
    result: EvalResult;
  },
): Promise<string> {
  const id = newId('risk_decision');
  await db
    .insertInto('paycore.risk_decisions')
    .values({
      id,
      merchant_id: args.merchantId,
      payment_intent_id: args.paymentIntentId,
      outcome: args.result.outcome,
      score: Math.min(1000, args.result.score),
      triggered_rules: [...args.result.triggered],
      evidence: args.result.evidence,
      created_at: new Date(),
    })
    .execute();
  return id;
}

/** Default rule-set for Phase 7 onboarding. Merchants can override Phase 8+. */
export const DEFAULT_RULES: RuleSet = {
  version: '2026-05-18',
  rules: [
    { name: 'amount_too_large', if: { amount_gt: 10_000_000 }, then: 'deny', score: 800 }, // 100k USD
    {
      name: 'velocity_per_token_60s_5x',
      if: { velocity: { scope: 'token', window_seconds: 60, max_count: 5 } },
      then: 'review',
      score: 300,
    },
    { name: 'cvv_failed', if: { cvv_result_in: ['fail'] }, then: 'deny', score: 600 },
    { name: 'blocked_bin', if: { bin_in: ['666666'] }, then: 'deny', score: 1000 },
  ],
};
