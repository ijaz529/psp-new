import { type ErrorCategory, type ErrorCode, type ErrorType, getErrorDefinition } from './codes.js';

export interface PspErrorOptions {
  /** Override the default human-readable message. */
  readonly message?: string;
  /** Which input parameter caused this (e.g., "amount"). */
  readonly param?: string;
  /** For card_error: scheme-specific decline reason (e.g., "insufficient_funds"). */
  readonly declineCode?: string;
  /** Internal context — never serialized to the merchant. */
  readonly internal?: Record<string, unknown>;
  /** Underlying cause for the stack trace. */
  readonly cause?: unknown;
}

export interface MerchantFacingError {
  readonly type: ErrorType;
  readonly code: ErrorCode;
  readonly decline_code?: string;
  readonly message: string;
  readonly param?: string;
  readonly request_id?: string;
}

/**
 * The only kind of error this codebase intentionally throws across module
 * boundaries. Anything else is treated as `internal_error` at the HTTP edge.
 */
export class PspError extends Error {
  public readonly code: ErrorCode;
  public readonly type: ErrorType;
  public readonly category: ErrorCategory;
  public readonly httpStatus: number;
  public readonly retryable: boolean;
  public readonly param?: string;
  public readonly declineCode?: string;
  public readonly internal?: Record<string, unknown>;

  constructor(code: ErrorCode, opts: PspErrorOptions = {}) {
    const def = getErrorDefinition(code);
    super(opts.message ?? def.defaultMessage, opts.cause ? { cause: opts.cause } : undefined);
    this.name = 'PspError';
    this.code = code;
    this.type = def.type;
    this.category = def.category;
    this.httpStatus = def.httpStatus;
    this.retryable = def.retryable;
    if (opts.param !== undefined) this.param = opts.param;
    if (opts.declineCode !== undefined) this.declineCode = opts.declineCode;
    if (opts.internal !== undefined) this.internal = opts.internal;
  }

  toMerchantFacing(requestId?: string): MerchantFacingError {
    const out: MerchantFacingError = {
      type: this.type,
      code: this.code,
      message: this.message,
    };
    if (this.declineCode !== undefined) (out as { decline_code: string }).decline_code = this.declineCode;
    if (this.param !== undefined) (out as { param: string }).param = this.param;
    if (requestId !== undefined) (out as { request_id: string }).request_id = requestId;
    return out;
  }

  toWireEnvelope(requestId?: string): { error: MerchantFacingError } {
    return { error: this.toMerchantFacing(requestId) };
  }
}

export function isPspError(value: unknown): value is PspError {
  return value instanceof PspError;
}
