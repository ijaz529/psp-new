/**
 * Error taxonomy — stable codes. Adding a code is a non-breaking change; removing
 * or renaming one is a breaking change to the public API. The merchant-facing
 * `code` value is contractually part of the API. Treat this file as a versioned
 * artifact.
 *
 * Categories (from PROJECT_BRIEF.md §3 Phase 0):
 *   - content      — 4xx, do not retry, body is wrong
 *   - idempotency  — replay or mismatched body for a previously-used key
 *   - network      — retry-safe transient failure
 *   - provider     — upstream returned a definitive failure (route around)
 *   - system       — indeterminate (5xx) — must be reconciled
 *
 * Wire shape (Stripe-mirror, intentionally):
 *   { "error": { "type": "...", "code": "...", "decline_code"?: "...",
 *               "message": "...", "param"?: "...", "request_id": "..." } }
 */
export type ErrorCategory = 'content' | 'idempotency' | 'network' | 'provider' | 'system';

export type ErrorType =
  | 'api_error'
  | 'authentication_error'
  | 'invalid_request_error'
  | 'idempotency_error'
  | 'rate_limit_error'
  | 'card_error'
  | 'connection_error'
  | 'permission_error';

export interface ErrorDefinition {
  readonly code: string;
  readonly type: ErrorType;
  readonly category: ErrorCategory;
  readonly httpStatus: number;
  readonly retryable: boolean;
  readonly defaultMessage: string;
}

/** Helper to keep the table readable; the `code` field is intentionally redundant for grep-ability. */
function def(d: ErrorDefinition): ErrorDefinition {
  return d;
}

/**
 * The full table. Order matches the brief's grouping (auth → idempotency →
 * content → rate-limit → card/state → webhook → routing → checkout/3ds → system).
 */
export const ERROR_DEFINITIONS = [
  // --- Authentication (5) ---
  def({
    code: 'api_key_missing',
    type: 'authentication_error',
    category: 'content',
    httpStatus: 401,
    retryable: false,
    defaultMessage: 'Authorization header is missing.',
  }),
  def({
    code: 'api_key_invalid',
    type: 'authentication_error',
    category: 'content',
    httpStatus: 401,
    retryable: false,
    defaultMessage: 'The API key provided is invalid.',
  }),
  def({
    code: 'api_key_revoked',
    type: 'authentication_error',
    category: 'content',
    httpStatus: 401,
    retryable: false,
    defaultMessage: 'The API key has been revoked.',
  }),
  def({
    code: 'signature_invalid',
    type: 'authentication_error',
    category: 'content',
    httpStatus: 401,
    retryable: false,
    defaultMessage: 'Request signature is invalid.',
  }),
  def({
    code: 'request_too_old',
    type: 'authentication_error',
    category: 'content',
    httpStatus: 401,
    retryable: false,
    defaultMessage: 'Request timestamp is outside the allowed clock skew window.',
  }),

  // --- Permissions (1) ---
  def({
    code: 'permission_denied',
    type: 'permission_error',
    category: 'content',
    httpStatus: 403,
    retryable: false,
    defaultMessage: 'The API key does not have permission for this resource.',
  }),

  // --- Idempotency (4) ---
  def({
    code: 'idempotency_key_missing',
    type: 'invalid_request_error',
    category: 'content',
    httpStatus: 400,
    retryable: false,
    defaultMessage: 'An Idempotency-Key header is required for this endpoint.',
  }),
  def({
    code: 'idempotency_key_invalid',
    type: 'invalid_request_error',
    category: 'content',
    httpStatus: 400,
    retryable: false,
    defaultMessage: 'Idempotency-Key must be 1-255 characters of [A-Za-z0-9_-].',
  }),
  def({
    code: 'idempotency_key_in_use',
    type: 'idempotency_error',
    category: 'idempotency',
    httpStatus: 409,
    retryable: true,
    defaultMessage: 'A request with this Idempotency-Key is already in progress. Retry shortly.',
  }),
  def({
    code: 'idempotency_key_reused_with_different_body',
    type: 'idempotency_error',
    category: 'idempotency',
    httpStatus: 422,
    retryable: false,
    defaultMessage: 'This Idempotency-Key has been used with a different request body.',
  }),

  // --- Content / validation (10) ---
  def({
    code: 'parameter_missing',
    type: 'invalid_request_error',
    category: 'content',
    httpStatus: 400,
    retryable: false,
    defaultMessage: 'A required parameter is missing.',
  }),
  def({
    code: 'parameter_invalid',
    type: 'invalid_request_error',
    category: 'content',
    httpStatus: 400,
    retryable: false,
    defaultMessage: 'A parameter has an invalid value.',
  }),
  def({
    code: 'parameter_unknown',
    type: 'invalid_request_error',
    category: 'content',
    httpStatus: 400,
    retryable: false,
    defaultMessage: 'A parameter was provided that is not recognized.',
  }),
  def({
    code: 'amount_too_small',
    type: 'invalid_request_error',
    category: 'content',
    httpStatus: 400,
    retryable: false,
    defaultMessage: 'Amount is below the minimum for this currency.',
  }),
  def({
    code: 'amount_too_large',
    type: 'invalid_request_error',
    category: 'content',
    httpStatus: 400,
    retryable: false,
    defaultMessage: 'Amount exceeds the maximum for this currency.',
  }),
  def({
    code: 'currency_unsupported',
    type: 'invalid_request_error',
    category: 'content',
    httpStatus: 400,
    retryable: false,
    defaultMessage: 'Currency is not supported.',
  }),
  def({
    code: 'currency_mismatch',
    type: 'invalid_request_error',
    category: 'content',
    httpStatus: 400,
    retryable: false,
    defaultMessage: 'Currency mismatch between resources.',
  }),
  def({
    code: 'resource_missing',
    type: 'invalid_request_error',
    category: 'content',
    httpStatus: 404,
    retryable: false,
    defaultMessage: 'No such resource.',
  }),
  def({
    code: 'merchant_not_found',
    type: 'invalid_request_error',
    category: 'content',
    httpStatus: 404,
    retryable: false,
    defaultMessage: 'Merchant not found.',
  }),
  def({
    code: 'unsupported_api_version',
    type: 'invalid_request_error',
    category: 'content',
    httpStatus: 400,
    retryable: false,
    defaultMessage: 'The PayCore-Version header value is not supported.',
  }),

  // --- Rate limit (1) ---
  def({
    code: 'rate_limited',
    type: 'rate_limit_error',
    category: 'content',
    httpStatus: 429,
    retryable: true,
    defaultMessage: 'Too many requests. Slow down or contact support to raise your limit.',
  }),

  // --- State machine (3) ---
  def({
    code: 'payment_intent_unexpected_state',
    type: 'invalid_request_error',
    category: 'content',
    httpStatus: 409,
    retryable: false,
    defaultMessage: 'PaymentIntent is not in a state that allows this operation.',
  }),
  def({
    code: 'refund_exceeds_capture',
    type: 'invalid_request_error',
    category: 'content',
    httpStatus: 409,
    retryable: false,
    defaultMessage: 'Refund amount exceeds the captured amount.',
  }),
  def({
    code: 'capture_exceeds_authorization',
    type: 'invalid_request_error',
    category: 'content',
    httpStatus: 409,
    retryable: false,
    defaultMessage: 'Capture amount exceeds the authorized amount.',
  }),

  // --- Card / scheme (5, with decline_code sub-axis) ---
  def({
    code: 'card_declined',
    type: 'card_error',
    category: 'provider',
    httpStatus: 402,
    retryable: false,
    defaultMessage: 'The card was declined.',
  }),
  def({
    code: 'expired_card',
    type: 'card_error',
    category: 'provider',
    httpStatus: 402,
    retryable: false,
    defaultMessage: 'The card has expired.',
  }),
  def({
    code: 'incorrect_cvc',
    type: 'card_error',
    category: 'provider',
    httpStatus: 402,
    retryable: false,
    defaultMessage: 'The CVC provided is incorrect.',
  }),
  def({
    code: 'processing_error',
    type: 'card_error',
    category: 'provider',
    httpStatus: 402,
    retryable: true,
    defaultMessage: 'An error occurred while processing the card. Try again shortly.',
  }),
  def({
    code: 'card_not_supported',
    type: 'card_error',
    category: 'provider',
    httpStatus: 402,
    retryable: false,
    defaultMessage: 'The card type is not supported.',
  }),

  // --- Webhook (3) ---
  def({
    code: 'webhook_signature_invalid',
    type: 'authentication_error',
    category: 'content',
    httpStatus: 400,
    retryable: false,
    defaultMessage: 'Webhook signature verification failed.',
  }),
  def({
    code: 'webhook_endpoint_unreachable',
    type: 'connection_error',
    category: 'network',
    httpStatus: 502,
    retryable: true,
    defaultMessage: 'Webhook endpoint was unreachable.',
  }),
  def({
    code: 'webhook_endpoint_4xx',
    type: 'connection_error',
    category: 'provider',
    httpStatus: 502,
    retryable: false,
    defaultMessage: 'Webhook endpoint responded with a non-retryable status.',
  }),

  // --- Routing / scheme (3) ---
  def({
    code: 'scheme_not_supported',
    type: 'invalid_request_error',
    category: 'provider',
    httpStatus: 422,
    retryable: false,
    defaultMessage: 'No acquirer route exists for this card scheme.',
  }),
  def({
    code: 'acquirer_timeout',
    type: 'connection_error',
    category: 'network',
    httpStatus: 504,
    retryable: true,
    defaultMessage: 'The acquirer did not respond in time. An automatic reversal has been sent.',
  }),
  def({
    code: 'scheme_unavailable',
    type: 'connection_error',
    category: 'network',
    httpStatus: 503,
    retryable: true,
    defaultMessage: 'The card scheme is currently unavailable.',
  }),

  // --- Checkout / 3DS (3) ---
  def({
    code: 'three_ds_authentication_failed',
    type: 'card_error',
    category: 'provider',
    httpStatus: 402,
    retryable: false,
    defaultMessage: '3DS authentication failed.',
  }),
  def({
    code: 'three_ds_required',
    type: 'invalid_request_error',
    category: 'content',
    httpStatus: 402,
    retryable: false,
    defaultMessage: '3DS authentication is required for this transaction.',
  }),
  def({
    code: 'hosted_fields_token_expired',
    type: 'invalid_request_error',
    category: 'content',
    httpStatus: 400,
    retryable: false,
    defaultMessage: 'The hosted-fields tokenization session has expired.',
  }),

  // --- System (4) ---
  def({
    code: 'internal_error',
    type: 'api_error',
    category: 'system',
    httpStatus: 500,
    retryable: false,
    defaultMessage: 'An internal error occurred. The request_id has been logged.',
  }),
  def({
    code: 'database_error',
    type: 'api_error',
    category: 'system',
    httpStatus: 500,
    retryable: false,
    defaultMessage: 'A database error occurred.',
  }),
  def({
    code: 'outbox_publish_failed',
    type: 'api_error',
    category: 'system',
    httpStatus: 500,
    retryable: false,
    defaultMessage: 'Failed to publish a domain event. The request_id has been logged.',
  }),
  def({
    code: 'vault_unreachable',
    type: 'connection_error',
    category: 'network',
    httpStatus: 502,
    retryable: true,
    defaultMessage: 'The tokenization vault is currently unreachable.',
  }),
] as const;

export type ErrorCode = (typeof ERROR_DEFINITIONS)[number]['code'];

const BY_CODE: ReadonlyMap<string, ErrorDefinition> = new Map(ERROR_DEFINITIONS.map((d) => [d.code, d]));

export function getErrorDefinition(code: ErrorCode): ErrorDefinition {
  const d = BY_CODE.get(code);
  // Type guarantees existence; this is a defensive check so the unit test catches drift.
  if (!d) throw new Error(`Unknown error code: ${code}`);
  return d;
}

export function isKnownErrorCode(code: string): code is ErrorCode {
  return BY_CODE.has(code);
}
