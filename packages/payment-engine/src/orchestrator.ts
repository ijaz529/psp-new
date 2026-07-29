import { randomBytes } from 'node:crypto';
import type { Database } from '@psp-new/db';
import { PspError } from '@psp-new/errors';
import { makeEvent } from '@psp-new/events';
import { type ResourceId, newId } from '@psp-new/ids';
import { type Posting, ensureMerchantAccounts, postJournal, pspAccount, schemeAccount } from '@psp-new/ledger';
import { applyBasisPoints, money } from '@psp-new/money';
import { publish, publishCardholderEvent } from '@psp-new/outbox';
import type { Kysely, Transaction } from 'kysely';
import { transitionPaymentIntent } from './state-machine.js';
import type { CaptureMethod, ConfirmationMethod, PaymentIntentStatus } from './state-machine.js';
import { type ThreeDsRequest, decideThreeDs, makeThreeDsResult } from './three-ds.js';

/** Hardcoded MDR for Phase 3. Phase 6 makes this per-merchant configurable. */
const MDR_BASIS_POINTS = 300;

export interface CreatePaymentIntentInput {
  readonly merchantId: string;
  readonly amount: bigint;
  readonly currency: string;
  readonly captureMethod?: CaptureMethod;
  readonly confirmationMethod?: ConfirmationMethod;
  readonly paymentMethodId?: string;
  readonly customerId?: string;
  readonly metadata?: Record<string, unknown>;
  readonly livemode?: boolean;
  /** Stripe-mirror knob — Phase 4 stores; Phase 7 risk engine reads. */
  readonly requestThreeDSecure?: ThreeDsRequest;
}

export interface PaymentIntentRecord {
  readonly id: ResourceId<'payment_intent'>;
  readonly merchantId: string;
  readonly amount: bigint;
  readonly amountReceived: bigint;
  readonly amountCapturable: bigint;
  readonly currency: string;
  readonly status: PaymentIntentStatus;
  readonly captureMethod: CaptureMethod;
  readonly confirmationMethod: ConfirmationMethod;
  readonly clientSecret: string;
  readonly customerId: string | null;
  readonly paymentMethodId: string | null;
  readonly metadata: Record<string, unknown> | null;
  readonly livemode: boolean;
  readonly created: Date;
  readonly updated: Date;
  readonly lastPaymentError: { code: string; message: string; declineCode?: string } | null;
}

function clientSecret(id: string): string {
  return `${id}_secret_${randomBytes(24).toString('base64url')}`;
}

function rowToRecord(row: Database['paycore.payment_intents']): PaymentIntentRecord {
  return {
    id: row.id as ResourceId<'payment_intent'>,
    merchantId: row.merchant_id,
    amount: row.amount,
    amountReceived: row.amount_received,
    amountCapturable: row.amount_capturable,
    currency: row.currency,
    status: row.status as PaymentIntentStatus,
    captureMethod: row.capture_method as CaptureMethod,
    confirmationMethod: row.confirmation_method as ConfirmationMethod,
    clientSecret: row.client_secret,
    customerId: row.customer_id,
    paymentMethodId: row.payment_method_id,
    metadata: (row.metadata as Record<string, unknown> | null) ?? null,
    livemode: row.livemode,
    created: row.created_at,
    updated: row.updated_at,
    lastPaymentError: row.last_payment_error_code
      ? {
          code: row.last_payment_error_code,
          message: row.last_payment_error_message ?? '',
          ...(row.last_payment_error_decline_code ? { declineCode: row.last_payment_error_decline_code } : {}),
        }
      : null,
  };
}

/** Create a fresh PaymentIntent. Doesn't post any ledger entries — that happens on confirm. */
export async function createPaymentIntent(
  db: Kysely<Database>,
  input: CreatePaymentIntentInput,
): Promise<PaymentIntentRecord> {
  const id = newId('payment_intent');
  const now = new Date();
  const captureMethod = input.captureMethod ?? 'automatic';
  const confirmationMethod = input.confirmationMethod ?? 'automatic';
  const status: PaymentIntentStatus = input.paymentMethodId ? 'requires_confirmation' : 'requires_payment_method';

  await db
    .insertInto('paycore.payment_intents')
    .values({
      id,
      merchant_id: input.merchantId,
      customer_id: input.customerId ?? null,
      payment_method_id: input.paymentMethodId ?? null,
      amount: input.amount,
      amount_received: 0n,
      amount_capturable: 0n,
      currency: input.currency.toUpperCase(),
      status,
      capture_method: captureMethod,
      confirmation_method: confirmationMethod,
      client_secret: clientSecret(id),
      last_payment_error_code: null,
      last_payment_error_message: null,
      last_payment_error_decline_code: null,
      metadata: input.metadata ?? null,
      livemode: input.livemode ?? false,
      next_action: null,
      request_three_d_secure: input.requestThreeDSecure ?? 'automatic',
      created_at: now,
      updated_at: now,
    })
    .execute();

  const row = await db.selectFrom('paycore.payment_intents').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
  return rowToRecord(row);
}

/**
 * Build the postings for a capture of `amount` in `currency` for a merchant
 * paid via `scheme`. Returns a balanced 3-line entry:
 *   Dr scheme_receivable
 *   Cr merchant_settlement_liability
 *   Cr mdr_revenue
 */
export function capturePostings(args: {
  merchantSettlementAccount: ResourceId<'account'>;
  scheme: 'visa' | 'mastercard' | 'amex';
  amount: bigint;
  currency: string;
}): Posting[] {
  const fee = applyBasisPoints(money(args.amount, args.currency), MDR_BASIS_POINTS);
  const merchantNet = args.amount - fee.amount;
  return [
    {
      accountId: schemeAccount('scheme_receivable', args.currency, args.scheme),
      amount: args.amount,
      currency: args.currency,
    },
    { accountId: args.merchantSettlementAccount, amount: -merchantNet, currency: args.currency },
    { accountId: pspAccount('mdr_revenue', args.currency), amount: -fee.amount, currency: args.currency },
  ];
}

/** Mirror image: refund of `amount` reverses the postings (proportional MDR refund). */
export function refundPostings(args: {
  merchantSettlementAccount: ResourceId<'account'>;
  scheme: 'visa' | 'mastercard' | 'amex';
  amount: bigint;
  currency: string;
}): Posting[] {
  const fee = applyBasisPoints(money(args.amount, args.currency), MDR_BASIS_POINTS);
  const merchantNet = args.amount - fee.amount;
  return [
    {
      accountId: schemeAccount('scheme_receivable', args.currency, args.scheme),
      amount: -args.amount,
      currency: args.currency,
    },
    { accountId: args.merchantSettlementAccount, amount: merchantNet, currency: args.currency },
    { accountId: pspAccount('mdr_revenue', args.currency), amount: fee.amount, currency: args.currency },
  ];
}

/* -------------------------------------------------------------------------- */
/* Confirm                                                                     */
/* -------------------------------------------------------------------------- */

export interface ConfirmPaymentIntentInput {
  readonly paymentIntentId: string;
  readonly merchantId: string;
  /** Phase 3 stub: scheme detected from token. We pass it in for simplicity. */
  readonly scheme: 'visa' | 'mastercard' | 'amex';
  /** Card BIN (first 6 digits). Phase 4 drives 3DS policy off this. */
  readonly bin?: string;
  /** Where to redirect the customer for the 3DS challenge. Required when 3DS challenge fires. */
  readonly threeDsRedirectBuilder?: (sessionId: string) => string;
  /** Phase 5: real acquirer call. If absent, falls back to the stub always-approve. */
  readonly authorizer?: Authorizer;
}

export interface AuthorizeRequest {
  readonly paymentIntentId: string;
  readonly merchantId: string;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly scheme: 'visa' | 'mastercard' | 'amex';
  readonly paymentMethodId: string;
  /** Phase 10. Drives 0100 (manual) vs 0200 (automatic) MTI selection at acquirer-host. */
  readonly captureMethod: CaptureMethod;
}

export interface AuthorizeResponse {
  readonly approved: boolean;
  readonly responseCode: string;
  readonly approvalCode: string | null;
  readonly declineCode?: string;
  readonly declineMessage?: string;
  /** Phase 10. RRN + STAN from the underlying 0100/0200 — needed for 0220/0420 lookup. */
  readonly rrn?: string;
  readonly stan?: string;
}

export type Authorizer = (req: AuthorizeRequest) => Promise<AuthorizeResponse>;

/* -------------------------------------------------------------------------- */
/* Phase 10 — Settler (0220 capture) + Reverser (0420 reversal)               */
/* -------------------------------------------------------------------------- */

export interface SettleRequest {
  readonly paymentIntentId: string;
  readonly merchantId: string;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly paymentMethodId: string;
  readonly rrn: string;
  readonly stan: string;
}

export interface SettleResponse {
  readonly approved: boolean;
  readonly responseCode: string;
}

export type Settler = (req: SettleRequest) => Promise<SettleResponse>;

export interface ReverseRequest extends SettleRequest {}
export interface ReverseResponse extends SettleResponse {}
export type Reverser = (req: ReverseRequest) => Promise<ReverseResponse>;

/**
 * Confirm orchestrator. Three paths, all inside one DB transaction:
 *
 *   (a) No 3DS / frictionless 3DS:
 *       requires_confirmation → processing → succeeded (auto-capture) | requires_capture (manual)
 *       Posts journal entry on succeeded.
 *
 *   (b) 3DS challenge required:
 *       requires_confirmation → requires_action
 *       Creates paycore.three_ds_sessions row + sets next_action.redirect_url.
 *       Customer hits the redirect → simulator → POST /v1/_internal/three_ds/callback → completeThreeDs().
 */
export async function confirmPaymentIntent(
  db: Kysely<Database>,
  input: ConfirmPaymentIntentInput,
): Promise<PaymentIntentRecord> {
  return await db.transaction().execute(async (trx) => {
    const row = await loadAndLock(trx, input.paymentIntentId, input.merchantId);
    const captureMethod = row.capture_method as CaptureMethod;

    // 3DS policy decision (Phase 4 — pure function on BIN + scheme + request flag).
    const decision = decideThreeDs({
      bin: input.bin ?? '',
      scheme: input.scheme,
      requestThreeDSecure: row.request_three_d_secure as ThreeDsRequest,
    });

    // Path B — challenge required: transition → requires_action and stop here.
    if (decision.mode === 'challenge') {
      if (!input.threeDsRedirectBuilder) {
        throw new PspError('internal_error', {
          message: 'threeDsRedirectBuilder is required when 3DS challenge fires',
        });
      }
      const t = transitionPaymentIntent(
        row.status as PaymentIntentStatus,
        { kind: 'enter_three_ds_challenge' },
        { capture_method: captureMethod },
      );
      if (!t.ok) throw new PspError('payment_intent_unexpected_state', { message: t.reason });

      const sessionId = newId('three_ds_session');
      const redirectUrl = input.threeDsRedirectBuilder(sessionId);
      const expires = new Date(Date.now() + 15 * 60_000); // 15-minute window

      await trx
        .insertInto('paycore.three_ds_sessions')
        .values({
          id: sessionId,
          merchant_id: row.merchant_id,
          payment_intent_id: row.id,
          token_id: '', // filled in by the api before calling — actually we don't know it here; leave empty for Phase 4 demo
          scheme: input.scheme,
          status: 'pending',
          eci: null,
          cavv: null,
          trans_status: null,
          redirect_url: redirectUrl,
          expires_at: expires,
          completed_at: null,
          created_at: new Date(),
        })
        .execute();

      await trx
        .updateTable('paycore.payment_intents')
        .set({
          status: 'requires_action',
          next_action: { type: 'three_ds_redirect', redirect_url: redirectUrl, three_ds_session_id: sessionId },
          updated_at: new Date(),
        })
        .where('id', '=', row.id)
        .execute();

      const updated = await trx
        .selectFrom('paycore.payment_intents')
        .selectAll()
        .where('id', '=', row.id)
        .executeTakeFirstOrThrow();
      const record = rowToRecord(updated);
      await emitAndPublishEvent(trx, record as unknown as Record<string, unknown>, 'payment_intent.requires_action');
      return record;
    }

    // Path A — no 3DS / frictionless 3DS. Continue inline.
    const t1 = transitionPaymentIntent(
      row.status as PaymentIntentStatus,
      { kind: 'confirm' },
      { capture_method: captureMethod },
    );
    if (!t1.ok) {
      throw new PspError('payment_intent_unexpected_state', {
        message: t1.reason,
        internal: { paymentIntentId: input.paymentIntentId, current: row.status },
      });
    }
    return await runAuthorizeAndPost(trx, row, captureMethod, input.scheme, input.authorizer);
  });
}

/**
 * Shared "acquirer approves → post capture journal entry → update row" tail.
 * Used by Path A confirm AND by completeThreeDs after the customer authenticates.
 *
 * Phase 5+: pass an `authorizer` that drives a real ISO 8583 exchange via
 * apps/acquirer-host. Without an authorizer, falls back to "always approve"
 * (Phase 3 behaviour, kept for unit tests).
 */
async function runAuthorizeAndPost(
  trx: Transaction<Database>,
  row: Database['paycore.payment_intents'],
  captureMethod: CaptureMethod,
  scheme: 'visa' | 'mastercard' | 'amex',
  authorizer?: Authorizer,
): Promise<PaymentIntentRecord> {
  // Authorization step
  let approved = true;
  let declineCode: string | undefined;
  let declineMessage: string | undefined;
  let responseCode = '00';
  let authRrn: string | null = null;
  let authStan: string | null = null;
  if (authorizer) {
    if (!row.payment_method_id) {
      throw new PspError('parameter_missing', { message: 'payment_method required for authorization' });
    }
    const resp = await authorizer({
      paymentIntentId: row.id,
      merchantId: row.merchant_id,
      amountMinor: row.amount,
      currency: row.currency,
      scheme,
      paymentMethodId: row.payment_method_id,
      captureMethod,
    });
    approved = resp.approved;
    responseCode = resp.responseCode;
    declineCode = resp.declineCode;
    declineMessage = resp.declineMessage;
    authRrn = resp.rrn ?? null;
    authStan = resp.stan ?? null;
  }

  if (!approved) {
    const t = transitionPaymentIntent(
      'processing',
      {
        kind: 'authorization_declined',
        declineCode: declineCode ?? 'card_declined',
        message: declineMessage ?? 'declined',
      },
      { capture_method: captureMethod },
    );
    if (!t.ok) throw new PspError('internal_error', { message: t.reason });
    await trx
      .updateTable('paycore.payment_intents')
      .set({
        status: 'failed',
        next_action: null,
        last_payment_error_code: 'card_declined',
        last_payment_error_decline_code: declineCode ?? null,
        last_payment_error_message: declineMessage ?? `acquirer response ${responseCode}`,
        updated_at: new Date(),
      })
      .where('id', '=', row.id)
      .execute();
    const updated = await trx
      .selectFrom('paycore.payment_intents')
      .selectAll()
      .where('id', '=', row.id)
      .executeTakeFirstOrThrow();
    const record = rowToRecord(updated);
    await emitAndPublishEvent(trx, record as unknown as Record<string, unknown>, 'payment_intent.payment_failed');
    return record;
  }

  const t2 = transitionPaymentIntent(
    'processing',
    { kind: 'authorization_approved' },
    { capture_method: captureMethod },
  );
  if (!t2.ok) throw new PspError('internal_error', { message: t2.reason });
  const nextStatus = t2.next;

  let amountReceived = row.amount_received;
  let amountCapturable = row.amount_capturable;

  if (nextStatus === 'succeeded') {
    const m = await ensureMerchantAccounts(trx, row.merchant_id, row.currency);
    await postJournal(trx, {
      externalId: `capture:${row.id}`,
      description: `capture ${row.amount} ${row.currency} for ${row.id}`,
      occurredAt: new Date(),
      postings: capturePostings({
        merchantSettlementAccount: m.settlementLiability,
        scheme,
        amount: row.amount,
        currency: row.currency,
      }),
    });
    amountReceived = row.amount;
    amountCapturable = 0n;
  } else if (nextStatus === 'requires_capture') {
    amountReceived = 0n;
    amountCapturable = row.amount;
  }

  await trx
    .updateTable('paycore.payment_intents')
    .set({
      status: nextStatus,
      amount_received: amountReceived,
      amount_capturable: amountCapturable,
      next_action: null,
      last_auth_rrn: authRrn,
      last_auth_stan: authStan,
      ...(nextStatus === 'succeeded' ? { captured_at: new Date() } : {}),
      updated_at: new Date(),
    })
    .where('id', '=', row.id)
    .execute();

  const updated = await trx
    .selectFrom('paycore.payment_intents')
    .selectAll()
    .where('id', '=', row.id)
    .executeTakeFirstOrThrow();
  const record = rowToRecord(updated);
  await emitAndPublishEvent(trx, record as unknown as Record<string, unknown>, eventTypeFor(nextStatus));
  return record;
}

/* -------------------------------------------------------------------------- */
/* completeThreeDs — callback from the simulator after Approve/Decline         */
/* -------------------------------------------------------------------------- */

export interface CompleteThreeDsInput {
  readonly sessionId: string;
  readonly outcome: 'approve' | 'decline' | 'attempted';
  /** Scheme of the underlying PaymentIntent; the callback may know it from the session. */
  readonly scheme?: 'visa' | 'mastercard' | 'amex';
  /** Phase 5: real acquirer call on the success path. */
  readonly authorizer?: Authorizer;
}

/**
 * Finalize a 3DS challenge. Looks up the session, updates it with the ACS
 * result, then either:
 *   - approve / attempted → run the stub acquirer + post capture entry → succeeded
 *   - decline             → transition payment_intent to failed
 *
 * Idempotent: if the session is already completed, returns the current PI without
 * re-posting. (Important because the simulator may retry the callback.)
 */
export async function completeThreeDs(db: Kysely<Database>, input: CompleteThreeDsInput): Promise<PaymentIntentRecord> {
  return await db.transaction().execute(async (trx) => {
    const session = await trx
      .selectFrom('paycore.three_ds_sessions')
      .selectAll()
      .where('id', '=', input.sessionId)
      .forUpdate()
      .executeTakeFirst();
    if (!session) throw new PspError('resource_missing', { message: '3DS session not found' });

    const pi = await trx
      .selectFrom('paycore.payment_intents')
      .selectAll()
      .where('id', '=', session.payment_intent_id)
      .forUpdate()
      .executeTakeFirstOrThrow();

    // Already terminal — return current state (idempotent callback).
    if (
      pi.status === 'succeeded' ||
      pi.status === 'failed' ||
      pi.status === 'canceled' ||
      pi.status === 'requires_capture'
    ) {
      return rowToRecord(pi);
    }
    if (pi.status !== 'requires_action') {
      throw new PspError('payment_intent_unexpected_state', { message: `expected requires_action, got ${pi.status}` });
    }

    if (session.status !== 'pending') {
      // Replay protection — session was already completed; do nothing.
      return rowToRecord(pi);
    }
    if (session.expires_at.getTime() < Date.now()) {
      await trx
        .updateTable('paycore.three_ds_sessions')
        .set({ status: 'expired', completed_at: new Date() })
        .where('id', '=', session.id)
        .execute();
      // PI transitions to failed on expiry.
      const t = transitionPaymentIntent(
        pi.status as PaymentIntentStatus,
        { kind: 'three_ds_complete', success: false },
        { capture_method: pi.capture_method as CaptureMethod },
      );
      if (!t.ok) throw new PspError('internal_error', { message: t.reason });
      await trx
        .updateTable('paycore.payment_intents')
        .set({
          status: 'failed',
          updated_at: new Date(),
          last_payment_error_code: 'three_ds_authentication_failed',
          last_payment_error_message: 'session expired',
        })
        .where('id', '=', pi.id)
        .execute();
      const updated = await trx
        .selectFrom('paycore.payment_intents')
        .selectAll()
        .where('id', '=', pi.id)
        .executeTakeFirstOrThrow();
      const record = rowToRecord(updated);
      await emitAndPublishEvent(trx, record as unknown as Record<string, unknown>, 'payment_intent.payment_failed');
      return record;
    }

    const scheme: 'visa' | 'mastercard' | 'amex' =
      (input.scheme ?? (session.scheme as 'visa' | 'mastercard' | 'amex')) || 'visa';
    const result = makeThreeDsResult({ scheme, outcome: input.outcome });

    await trx
      .updateTable('paycore.three_ds_sessions')
      .set({
        status: result.success ? 'approved' : 'declined',
        eci: result.eci,
        cavv: result.cavv,
        trans_status: result.transStatus,
        completed_at: new Date(),
      })
      .where('id', '=', session.id)
      .execute();

    // Transition: three_ds_complete → processing (success) | failed (decline)
    const t = transitionPaymentIntent(
      pi.status as PaymentIntentStatus,
      { kind: 'three_ds_complete', success: result.success },
      { capture_method: pi.capture_method as CaptureMethod },
    );
    if (!t.ok) throw new PspError('internal_error', { message: t.reason });

    if (!result.success) {
      await trx
        .updateTable('paycore.payment_intents')
        .set({
          status: 'failed',
          next_action: null,
          last_payment_error_code: 'three_ds_authentication_failed',
          last_payment_error_message: '3DS authentication declined',
          updated_at: new Date(),
        })
        .where('id', '=', pi.id)
        .execute();
      const updated = await trx
        .selectFrom('paycore.payment_intents')
        .selectAll()
        .where('id', '=', pi.id)
        .executeTakeFirstOrThrow();
      const record = rowToRecord(updated);
      await emitAndPublishEvent(trx, record as unknown as Record<string, unknown>, 'payment_intent.payment_failed');
      return record;
    }

    // Success — run the acquirer (Phase 5) + post capture journal entry.
    // The state machine left us at 'processing'; runAuthorizeAndPost continues from there.
    return await runAuthorizeAndPost(trx, pi, pi.capture_method as CaptureMethod, scheme, input.authorizer);
  });
}

/* -------------------------------------------------------------------------- */
/* Capture                                                                     */
/* -------------------------------------------------------------------------- */

export interface CapturePaymentIntentInput {
  readonly paymentIntentId: string;
  readonly merchantId: string;
  readonly scheme: 'visa' | 'mastercard' | 'amex';
  /** Phase 10. When present + PI has last_auth_rrn/stan, send 0220 before posting capture journal. */
  readonly settler?: Settler;
  /**
   * Phase 16. Stripe-compat: optional partial-capture amount. Must be ≤ amount_capturable.
   * Omit to capture the full remaining amount_capturable (Phase 10 behavior preserved).
   */
  readonly amountToCapture?: bigint;
}

export async function capturePaymentIntent(
  db: Kysely<Database>,
  input: CapturePaymentIntentInput,
): Promise<PaymentIntentRecord> {
  // Phase 10 — settle on the wire BEFORE opening the transaction, so an
  // acquirer decline doesn't leave a half-applied state on rollback. The
  // capture journal must still be posted in a transaction once the wire
  // settlement succeeds.
  const preRow = await db
    .selectFrom('paycore.payment_intents')
    .select(['last_auth_rrn', 'last_auth_stan', 'payment_method_id', 'amount', 'amount_capturable', 'currency'])
    .where('id', '=', input.paymentIntentId)
    .where('merchant_id', '=', input.merchantId)
    .executeTakeFirst();
  if (!preRow) throw new PspError('resource_missing');

  // Phase 16: partial-capture validation. Default to full remaining.
  const capturable = preRow.amount_capturable;
  const captureAmount = input.amountToCapture ?? capturable;
  if (captureAmount <= 0n) {
    throw new PspError('parameter_invalid', {
      message: 'amount_to_capture must be positive',
      param: 'amount_to_capture',
    });
  }
  if (captureAmount > capturable) {
    throw new PspError('amount_too_large', {
      message: `amount_to_capture ${captureAmount} exceeds amount_capturable ${capturable}`,
      param: 'amount_to_capture',
    });
  }

  if (input.settler && preRow.last_auth_rrn && preRow.last_auth_stan && preRow.payment_method_id) {
    const resp = await input.settler({
      paymentIntentId: input.paymentIntentId,
      merchantId: input.merchantId,
      amountMinor: captureAmount,
      currency: preRow.currency,
      paymentMethodId: preRow.payment_method_id,
      rrn: preRow.last_auth_rrn,
      stan: preRow.last_auth_stan,
    });
    if (!resp.approved) {
      throw new PspError('acquirer_declined', {
        message: `capture declined RC ${resp.responseCode}`,
        internal: { responseCode: resp.responseCode },
      });
    }
  }

  return await db.transaction().execute(async (trx) => {
    const row = await loadAndLock(trx, input.paymentIntentId, input.merchantId);
    // Phase 16: the state machine transition only happens on the FINAL capture
    // (i.e. when this capture would zero out amount_capturable). For partial
    // captures that leave a remainder, we stay in `requires_capture` and just
    // update the running totals.
    const newAmountReceived = row.amount_received + captureAmount;
    const newAmountCapturable = row.amount_capturable - captureAmount;
    const isFinal = newAmountCapturable === 0n;

    if (isFinal) {
      const t = transitionPaymentIntent(
        row.status as PaymentIntentStatus,
        { kind: 'capture' },
        { capture_method: row.capture_method as CaptureMethod },
      );
      if (!t.ok) {
        throw new PspError('payment_intent_unexpected_state', { message: t.reason });
      }
    } else if (row.status !== 'requires_capture') {
      // Partial capture only makes sense from requires_capture. Anything else
      // is a state-machine error we want surfaced explicitly.
      throw new PspError('payment_intent_unexpected_state', {
        message: `partial capture invalid from state '${row.status}'`,
      });
    }

    const m = await ensureMerchantAccounts(trx, row.merchant_id, row.currency);
    // Phase 16: per-capture externalId uses the pre-capture amount_received as
    // a deterministic, unique suffix. Each partial capture has a unique
    // "amount captured so far" pre-state, so two captures can never share the
    // same suffix. A safe retry of the same partial within an idempotency
    // window lands on the same suffix and hits the unique constraint cleanly.
    await postJournal(trx, {
      externalId: `capture:${row.id}:${row.amount_received}`,
      description: `capture ${captureAmount} ${row.currency} for ${row.id} (after ${row.amount_received})`,
      occurredAt: new Date(),
      postings: capturePostings({
        merchantSettlementAccount: m.settlementLiability,
        scheme: input.scheme,
        amount: captureAmount,
        currency: row.currency,
      }),
    });
    await trx
      .updateTable('paycore.payment_intents')
      .set({
        ...(isFinal ? { status: 'succeeded' as const, captured_at: new Date() } : {}),
        amount_received: newAmountReceived,
        amount_capturable: newAmountCapturable,
        updated_at: new Date(),
      })
      .where('id', '=', row.id)
      .execute();
    const updated = await trx
      .selectFrom('paycore.payment_intents')
      .selectAll()
      .where('id', '=', row.id)
      .executeTakeFirstOrThrow();
    const record = rowToRecord(updated);
    await emitAndPublishEvent(trx, record as unknown as Record<string, unknown>, 'payment_intent.succeeded');
    return record;
  });
}

/* -------------------------------------------------------------------------- */
/* Cancel                                                                      */
/* -------------------------------------------------------------------------- */

export interface CancelPaymentIntentInput {
  readonly paymentIntentId: string;
  readonly merchantId: string;
  /** Phase 10. When PI is `requires_capture` and has last_auth_rrn/stan, send 0420 before transitioning. */
  readonly reverser?: Reverser;
}

export async function cancelPaymentIntent(
  db: Kysely<Database>,
  input: CancelPaymentIntentInput,
): Promise<PaymentIntentRecord> {
  // Phase 10 — if there is an open authorization to reverse, do that on the
  // wire BEFORE opening the txn so a decline doesn't strand a half-applied state.
  const preRow = await db
    .selectFrom('paycore.payment_intents')
    .select([
      'status',
      'last_auth_rrn',
      'last_auth_stan',
      'payment_method_id',
      'amount',
      'amount_capturable',
      'currency',
    ])
    .where('id', '=', input.paymentIntentId)
    .where('merchant_id', '=', input.merchantId)
    .executeTakeFirst();
  if (!preRow) throw new PspError('resource_missing');

  if (
    input.reverser &&
    preRow.status === 'requires_capture' &&
    preRow.last_auth_rrn &&
    preRow.last_auth_stan &&
    preRow.payment_method_id &&
    preRow.amount_capturable > 0n
  ) {
    // Phase 16: reverse the UNCAPTURED remainder. After partial captures
    // amount_capturable is < amount; sending the full amount would over-reverse
    // and the issuer-host would already be handling partials, so we send
    // exactly amount_capturable.
    const resp = await input.reverser({
      paymentIntentId: input.paymentIntentId,
      merchantId: input.merchantId,
      amountMinor: preRow.amount_capturable,
      currency: preRow.currency,
      paymentMethodId: preRow.payment_method_id,
      rrn: preRow.last_auth_rrn,
      stan: preRow.last_auth_stan,
    });
    if (!resp.approved) {
      throw new PspError('acquirer_declined', {
        message: `reversal declined RC ${resp.responseCode}`,
        internal: { responseCode: resp.responseCode },
      });
    }
  }

  return await db.transaction().execute(async (trx) => {
    const row = await loadAndLock(trx, input.paymentIntentId, input.merchantId);
    const t = transitionPaymentIntent(
      row.status as PaymentIntentStatus,
      { kind: 'cancel' },
      {
        capture_method: row.capture_method as CaptureMethod,
      },
    );
    if (!t.ok) {
      throw new PspError('payment_intent_unexpected_state', { message: t.reason });
    }
    await trx
      .updateTable('paycore.payment_intents')
      .set({ status: 'canceled', amount_capturable: 0n, updated_at: new Date() })
      .where('id', '=', row.id)
      .execute();
    const updated = await trx
      .selectFrom('paycore.payment_intents')
      .selectAll()
      .where('id', '=', row.id)
      .executeTakeFirstOrThrow();
    const record = rowToRecord(updated);
    await emitAndPublishEvent(trx, record as unknown as Record<string, unknown>, 'payment_intent.canceled');
    return record;
  });
}

/* -------------------------------------------------------------------------- */
/* Refund                                                                      */
/* -------------------------------------------------------------------------- */

export interface CreateRefundInput {
  readonly merchantId: string;
  readonly paymentIntentId: string;
  readonly amount: bigint;
  readonly reason?: 'requested_by_customer' | 'duplicate' | 'fraudulent' | 'expired_uncaptured_charge';
  readonly scheme: 'visa' | 'mastercard' | 'amex';
  readonly metadata?: Record<string, unknown>;
}

export interface RefundRecord {
  readonly id: ResourceId<'refund'>;
  readonly paymentIntentId: string;
  readonly amount: bigint;
  readonly currency: string;
  readonly status: 'succeeded';
  readonly reason: CreateRefundInput['reason'] | null;
  readonly created: Date;
  readonly metadata: Record<string, unknown> | null;
}

export async function createRefund(db: Kysely<Database>, input: CreateRefundInput): Promise<RefundRecord> {
  return await db.transaction().execute(async (trx) => {
    const pi = await loadAndLock(trx, input.paymentIntentId, input.merchantId);
    if (pi.status !== 'succeeded') {
      throw new PspError('payment_intent_unexpected_state', {
        message: `cannot refund a payment_intent in status '${pi.status}'`,
        internal: { current: pi.status },
      });
    }
    // Sum existing refund amounts; ensure new total <= amount_received.
    const existing = await trx
      .selectFrom('paycore.refunds')
      .select((eb) => eb.fn.sum<bigint | string | null>('amount').as('total'))
      .where('payment_intent_id', '=', pi.id)
      .executeTakeFirst();
    const refundedSoFar = toBigInt(existing?.total ?? 0n);
    if (refundedSoFar + input.amount > pi.amount_received) {
      throw new PspError('refund_exceeds_capture', {
        message: `refund (${input.amount}) plus prior refunds (${refundedSoFar}) exceeds captured amount (${pi.amount_received})`,
      });
    }
    const m = await ensureMerchantAccounts(trx, pi.merchant_id, pi.currency);
    const refundId = newId('refund');
    const journalEntryId = `je:refund:${refundId}`;
    const r = await postJournal(trx, {
      externalId: journalEntryId,
      description: `refund ${input.amount} ${pi.currency} for ${pi.id}`,
      occurredAt: new Date(),
      postings: refundPostings({
        merchantSettlementAccount: m.settlementLiability,
        scheme: input.scheme,
        amount: input.amount,
        currency: pi.currency,
      }),
    });
    const now = new Date();
    await trx
      .insertInto('paycore.refunds')
      .values({
        id: refundId,
        merchant_id: pi.merchant_id,
        payment_intent_id: pi.id,
        amount: input.amount,
        currency: pi.currency,
        status: 'succeeded',
        reason: input.reason ?? null,
        journal_entry_id: r.id,
        metadata: input.metadata ?? null,
        created_at: now,
      })
      .execute();

    // Reduce the PaymentIntent's amount_received to reflect the refund.
    await trx
      .updateTable('paycore.payment_intents')
      .set({ amount_received: pi.amount_received - input.amount, updated_at: now })
      .where('id', '=', pi.id)
      .execute();

    const refund: RefundRecord = {
      id: refundId,
      paymentIntentId: pi.id,
      amount: input.amount,
      currency: pi.currency,
      status: 'succeeded',
      reason: input.reason ?? null,
      created: now,
      metadata: input.metadata ?? null,
    };
    await emitAndPublishEvent(
      trx,
      refund as unknown as Record<string, unknown>,
      'refund.succeeded',
      refundId,
      pi.merchant_id,
      pi.livemode,
    );
    return refund;
  });
}

/* -------------------------------------------------------------------------- */
/* internal helpers                                                            */
/* -------------------------------------------------------------------------- */

async function loadAndLock(
  trx: Transaction<Database>,
  paymentIntentId: string,
  merchantId: string,
): Promise<Database['paycore.payment_intents']> {
  const row = await trx
    .selectFrom('paycore.payment_intents')
    .selectAll()
    .where('id', '=', paymentIntentId)
    .where('merchant_id', '=', merchantId)
    .forUpdate()
    .executeTakeFirst();
  if (!row) throw new PspError('resource_missing', { message: `payment_intent ${paymentIntentId} not found` });
  return row;
}

function eventTypeFor(status: PaymentIntentStatus): string {
  switch (status) {
    case 'succeeded':
      return 'payment_intent.succeeded';
    case 'requires_capture':
      return 'payment_intent.amount_capturable_updated';
    case 'failed':
      return 'payment_intent.payment_failed';
    case 'canceled':
      return 'payment_intent.canceled';
    case 'processing':
      return 'payment_intent.processing';
    case 'requires_action':
      return 'payment_intent.requires_action';
    default:
      return 'payment_intent.updated';
  }
}

/**
 * Event/outbox payloads land in jsonb columns; pg cannot serialize BigInt
 * (int8 columns parse to BigInt via configurePgTypes). Convert to Number,
 * matching the wire convention (apps/api bigintToWire).
 */
function jsonSafe(data: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify(data, (_key, value) => (typeof value === 'bigint' ? Number(value) : value)),
  ) as Record<string, unknown>;
}

async function emitAndPublishEvent(
  trx: Transaction<Database>,
  data: Record<string, unknown>,
  type: string,
  resourceIdOverride?: string,
  merchantIdOverride?: string,
  livemodeOverride?: boolean,
): Promise<void> {
  const merchantId = (merchantIdOverride ?? (data as { merchantId?: string }).merchantId) as string;
  const resourceId = resourceIdOverride ?? (data as { id?: string }).id ?? null;
  const livemode = livemodeOverride ?? (data as { livemode?: boolean }).livemode ?? false;
  const envelope = makeEvent({
    type,
    data: jsonSafe(data),
    livemode,
    apiVersion: '2026-01-01',
    ...(resourceId ? { resourceId } : {}),
  });
  await trx
    .insertInto('paycore.events')
    .values({
      id: envelope.id,
      merchant_id: merchantId,
      type,
      api_version: envelope.api_version,
      resource_id: resourceId,
      data: envelope.data as unknown,
      livemode: envelope.livemode,
      created_at: new Date(envelope.created),
    })
    .execute();
  await publish(trx, {
    eventType: type,
    payload: envelope,
    ...(resourceId ? { resourceId } : {}),
    headers: { merchant_id: merchantId },
  });
}

function toBigInt(v: unknown): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(v);
  if (typeof v === 'string') return BigInt(v);
  return 0n;
}

/* -------------------------------------------------------------------------- */
/* Phase 11 — loadCard                                                        */
/*                                                                            */
/* Top up a Strawberry-issued card by charging an external Visa via the      */
/* acquiring path. Wire-only fidelity: real 0200 through the existing        */
/* Authorizer; on RC 00 the posted journal mirrors the `card:load` CLI       */
/* exactly — `cardholder_funded +X`, `issuer_funded_pool -X`. The acquiring  */
/* books are deliberately untouched (PHASE_11_PLAN.md §Decisions locked).    */
/* -------------------------------------------------------------------------- */

export interface LoadCardInput {
  readonly cardId: string;
  readonly merchantId: string;
  readonly paymentMethodId: string;
  readonly amountMinor: bigint;
  readonly currency: string;
  /** Phase 5+ Authorizer port. Same one buildAcquirerAuthorizer returns. */
  readonly authorizer: Authorizer;
}

export interface CardLoadRecord {
  readonly id: ResourceId<'card_load'>;
  readonly cardId: string;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly status: 'succeeded' | 'failed';
  readonly responseCode: string;
  readonly rrn: string | null;
  readonly stan: string | null;
  readonly failureCode: string | null;
  readonly failureMessage: string | null;
  readonly created: Date;
}

export async function loadCard(db: Kysely<Database>, input: LoadCardInput): Promise<CardLoadRecord> {
  // 1. Validate card.
  const card = await db
    .selectFrom('paycore.cards')
    .innerJoin('paycore.card_products', 'paycore.card_products.id', 'paycore.cards.product_id')
    .select([
      'paycore.cards.id as id',
      'paycore.cards.status as status',
      'paycore.cards.funded_account_id as funded_account_id',
      'paycore.cards.cardholder_id as cardholder_id',
      'paycore.card_products.currency as product_currency',
    ])
    .where('paycore.cards.id', '=', input.cardId)
    .executeTakeFirst();
  if (!card) throw new PspError('resource_missing', { message: `card ${input.cardId} not found` });
  if (card.status !== 'active') {
    throw new PspError('card_funding_not_allowed', {
      message: `card ${input.cardId} is ${card.status}`,
      internal: { cardStatus: card.status },
    });
  }
  if (card.product_currency !== input.currency) {
    throw new PspError('currency_unsupported', {
      message: `card currency is ${card.product_currency}, load requested ${input.currency}`,
    });
  }

  // 2. Validate payment_method. Must belong to the calling merchant and be a
  // real vault-tokenized external card. Strawberry-issued PANs are not
  // represented in paycore.payment_methods, so the lookup itself enforces
  // the "external card only" rule.
  const pm = await db
    .selectFrom('paycore.payment_methods')
    .select(['id'])
    .where('id', '=', input.paymentMethodId)
    .where('merchant_id', '=', input.merchantId)
    .executeTakeFirst();
  if (!pm) {
    throw new PspError('resource_missing', { message: `payment_method ${input.paymentMethodId} not found` });
  }

  // 3. Authorize on the wire. 'automatic' capture → 0200 (combined auth+settle).
  const loadId = newId('card_load');
  const auth = await input.authorizer({
    paymentIntentId: loadId, // acquirer-host uses this for log correlation only
    merchantId: input.merchantId,
    amountMinor: input.amountMinor,
    currency: input.currency,
    scheme: 'visa',
    paymentMethodId: input.paymentMethodId,
    captureMethod: 'automatic',
  });

  // 4a. Decline path — record the attempt, no journal.
  if (!auth.approved) {
    const row = await db
      .insertInto('paycore.card_loads')
      .values({
        id: loadId,
        card_id: input.cardId,
        payment_method_id: input.paymentMethodId,
        amount: input.amountMinor,
        currency: input.currency,
        status: 'failed',
        response_code: auth.responseCode,
        rrn: auth.rrn ?? null,
        stan: auth.stan ?? null,
        failure_code: auth.declineCode ?? 'card_declined',
        failure_message: auth.declineMessage ?? `acquirer response ${auth.responseCode}`,
        journal_entry_id: null,
        created_at: new Date(),
      })
      .returning(['id', 'created_at'])
      .executeTakeFirstOrThrow();
    return cardLoadRowToRecord({
      ...row,
      card_id: input.cardId,
      amount: input.amountMinor,
      currency: input.currency,
      status: 'failed',
      response_code: auth.responseCode,
      rrn: auth.rrn ?? null,
      stan: auth.stan ?? null,
      failure_code: auth.declineCode ?? 'card_declined',
      failure_message: auth.declineMessage ?? `acquirer response ${auth.responseCode}`,
    });
  }

  // 4b. Approve path — single txn: insert row + post journal.
  return await db.transaction().execute(async (trx) => {
    const fundingPoolId = await resolveIssuerFundingPool(trx, input.currency);
    const entry = await postJournal(trx, {
      externalId: `card_load:${loadId}`,
      description: `card load ${input.cardId} ${input.currency} ${input.amountMinor}`,
      occurredAt: new Date(),
      postings: [
        {
          accountId: card.funded_account_id as ResourceId<'account'>,
          amount: input.amountMinor,
          currency: input.currency,
        },
        {
          accountId: fundingPoolId as ResourceId<'account'>,
          amount: -input.amountMinor,
          currency: input.currency,
        },
      ],
    });
    await trx
      .insertInto('paycore.card_loads')
      .values({
        id: loadId,
        card_id: input.cardId,
        payment_method_id: input.paymentMethodId,
        amount: input.amountMinor,
        currency: input.currency,
        status: 'succeeded',
        response_code: auth.responseCode,
        rrn: auth.rrn ?? null,
        stan: auth.stan ?? null,
        failure_code: null,
        failure_message: null,
        journal_entry_id: entry.id,
        created_at: new Date(),
      })
      .execute();

    await publishCardholderEvent(trx, {
      cardholderId: card.cardholder_id,
      type: 'card_load.succeeded',
      resourceId: loadId,
      data: {
        id: loadId,
        object: 'card_load',
        card: input.cardId,
        amount: Number(input.amountMinor),
        currency: input.currency,
        status: 'succeeded',
        response_code: auth.responseCode,
        rrn: auth.rrn ?? null,
        stan: auth.stan ?? null,
      },
    });

    return cardLoadRowToRecord({
      id: loadId,
      card_id: input.cardId,
      amount: input.amountMinor,
      currency: input.currency,
      status: 'succeeded',
      response_code: auth.responseCode,
      rrn: auth.rrn ?? null,
      stan: auth.stan ?? null,
      failure_code: null,
      failure_message: null,
      created_at: new Date(),
    });
  });
}

async function resolveIssuerFundingPool(trx: Transaction<Database>, currency: string): Promise<string> {
  const row = await trx
    .selectFrom('ledger.accounts')
    .select(['id'])
    .where('code', '=', 'issuer_funded_pool')
    .where('currency', '=', currency)
    .where('owner_kind', '=', 'psp')
    .executeTakeFirst();
  if (!row) throw new PspError('internal_error', { message: `no issuer_funded_pool seeded for ${currency}` });
  return row.id;
}

interface CardLoadRowShape {
  id: string;
  card_id: string;
  amount: bigint;
  currency: string;
  status: 'succeeded' | 'failed';
  response_code: string;
  rrn: string | null;
  stan: string | null;
  failure_code: string | null;
  failure_message: string | null;
  created_at: Date;
}

function cardLoadRowToRecord(row: CardLoadRowShape): CardLoadRecord {
  return {
    id: row.id as ResourceId<'card_load'>,
    cardId: row.card_id,
    amountMinor: row.amount,
    currency: row.currency,
    status: row.status,
    responseCode: row.response_code,
    rrn: row.rrn,
    stan: row.stan,
    failureCode: row.failure_code,
    failureMessage: row.failure_message,
    created: row.created_at,
  };
}
