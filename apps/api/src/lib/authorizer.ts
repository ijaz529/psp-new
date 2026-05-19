import { createHash } from 'node:crypto';
import type { Database } from '@psp-new/db';
import { getCurrency } from '@psp-new/money';
import type {
  AuthorizeRequest,
  AuthorizeResponse,
  Authorizer,
  ReverseRequest,
  ReverseResponse,
  Reverser,
  SettleRequest,
  SettleResponse,
  Settler,
} from '@psp-new/payment-engine';
import type { ServiceAuth } from '@psp-new/service-auth';
import type { Kysely } from 'kysely';

/**
 * Build an Authorizer that calls apps/acquirer-host over HTTP with service-auth
 * signing. The acquirer-host then drives the ISO 8583 exchange with the
 * scheme-simulator. Decline mapping → PaymentIntent `last_payment_error`.
 *
 * Phase 5 maps the most common ISO 8583 RCs (`00`, `05`, `51`, `54`, `1A`).
 * Phase 7 risk engine will surface scheme-specific decline taxonomies.
 */
export interface AuthorizerFactoryOptions {
  readonly db: Kysely<Database>;
  readonly serviceAuth: ServiceAuth;
  readonly acquirerHostUrl: string;
  readonly fetchImpl?: typeof fetch;
}

const DECLINE_MESSAGES: ReadonlyMap<string, { code: string; message: string }> = new Map([
  ['00', { code: 'approved', message: 'approved' }],
  ['05', { code: 'do_not_honor', message: 'do not honor' }],
  ['51', { code: 'insufficient_funds', message: 'insufficient funds' }],
  ['54', { code: 'expired_card', message: 'expired card' }],
  ['1A', { code: 'authentication_required', message: 'authentication required (soft decline)' }],
  ['43', { code: 'lost_card', message: 'card reported lost or stolen' }],
  ['96', { code: 'processing_error', message: 'system malfunction' }],
]);

export function buildAcquirerAuthorizer(opts: AuthorizerFactoryOptions): Authorizer {
  const fetchImpl = opts.fetchImpl ?? fetch;

  return async (req: AuthorizeRequest): Promise<AuthorizeResponse> => {
    // Look up the token id from the payment_method.
    const pm = await opts.db
      .selectFrom('paycore.payment_methods')
      .select(['token_id'])
      .where('id', '=', req.paymentMethodId)
      .executeTakeFirst();
    if (!pm) {
      return {
        approved: false,
        responseCode: '14',
        approvalCode: null,
        declineCode: 'unknown_card',
        declineMessage: 'no payment_method found for authorization',
      };
    }
    const cur = getCurrency(req.currency);
    if (!cur) {
      return {
        approved: false,
        responseCode: '12',
        approvalCode: null,
        declineCode: 'currency_unsupported',
        declineMessage: `unsupported currency ${req.currency}`,
      };
    }

    const body = {
      payment_intent_id: req.paymentIntentId,
      merchant_id: req.merchantId,
      token: pm.token_id,
      amount_minor: Number(req.amountMinor),
      currency_numeric: cur.numeric,
      capture_method: req.captureMethod,
    };
    const bodyJson = JSON.stringify(body);
    const path = '/internal/v1/authorize';
    const tok = opts.serviceAuth.sign({
      sender: 'api',
      method: 'POST',
      path,
      bodySha256: createHash('sha256').update(bodyJson).digest('hex'),
    });

    let res: Response;
    try {
      res = await fetchImpl(`${opts.acquirerHostUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-service-auth': tok.header },
        body: bodyJson,
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      return {
        approved: false,
        responseCode: '91',
        approvalCode: null,
        declineCode: 'processing_error',
        declineMessage: `acquirer unreachable: ${(err as Error).message}`,
      };
    }
    if (!res.ok) {
      return {
        approved: false,
        responseCode: '96',
        approvalCode: null,
        declineCode: 'processing_error',
        declineMessage: `acquirer-host returned ${res.status}`,
      };
    }
    const json = (await res.json()) as {
      approved: boolean;
      response_code: string;
      approval_code: string | null;
      rrn?: string;
      stan?: string;
    };
    const mapping = DECLINE_MESSAGES.get(json.response_code) ?? {
      code: 'card_declined',
      message: `decline code ${json.response_code}`,
    };
    if (json.approved) {
      return {
        approved: true,
        responseCode: json.response_code,
        approvalCode: json.approval_code,
        ...(json.rrn ? { rrn: json.rrn } : {}),
        ...(json.stan ? { stan: json.stan } : {}),
      };
    }
    return {
      approved: false,
      responseCode: json.response_code,
      approvalCode: json.approval_code,
      declineCode: mapping.code,
      declineMessage: mapping.message,
    };
  };
}

/* -------------------------------------------------------------------------- */
/* Phase 10 — Settler (0220) + Reverser (0420) clients                        */
/* -------------------------------------------------------------------------- */

export function buildAcquirerSettler(opts: AuthorizerFactoryOptions): Settler {
  return buildAdviceClient(opts, '/internal/v1/capture') as Settler;
}

export function buildAcquirerReverser(opts: AuthorizerFactoryOptions): Reverser {
  return buildAdviceClient(opts, '/internal/v1/reverse') as Reverser;
}

function buildAdviceClient(
  opts: AuthorizerFactoryOptions,
  path: '/internal/v1/capture' | '/internal/v1/reverse',
): (req: SettleRequest | ReverseRequest) => Promise<SettleResponse | ReverseResponse> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  return async (req) => {
    const pm = await opts.db
      .selectFrom('paycore.payment_methods')
      .select(['token_id'])
      .where('id', '=', req.paymentMethodId)
      .executeTakeFirst();
    if (!pm) {
      return { approved: false, responseCode: '14' };
    }
    const cur = getCurrency(req.currency);
    if (!cur) {
      return { approved: false, responseCode: '12' };
    }

    const body = {
      payment_intent_id: req.paymentIntentId,
      merchant_id: req.merchantId,
      token: pm.token_id,
      amount_minor: Number(req.amountMinor),
      currency_numeric: cur.numeric,
      original_rrn: req.rrn,
      original_stan: req.stan,
    };
    const bodyJson = JSON.stringify(body);
    const tok = opts.serviceAuth.sign({
      sender: 'api',
      method: 'POST',
      path,
      bodySha256: createHash('sha256').update(bodyJson).digest('hex'),
    });
    let res: Response;
    try {
      res = await fetchImpl(`${opts.acquirerHostUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-service-auth': tok.header },
        body: bodyJson,
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      return { approved: false, responseCode: '91' };
    }
    if (!res.ok) {
      return { approved: false, responseCode: '96' };
    }
    const json = (await res.json()) as { approved: boolean; response_code: string };
    return { approved: json.approved, responseCode: json.response_code };
  };
}
