import { createHash } from 'node:crypto';
import { PspError } from '@psp-new/errors';
import type { ServiceAuth } from '@psp-new/service-auth';

export type CardScheme = 'visa' | 'mastercard' | 'amex' | 'unknown';

export type DetokenizeReason = 'authorization' | 'capture' | 'reversal' | 'refund' | 'audit';

export interface TokenizeRequest {
  /** Raw PAN (digits with optional separators). Vault validates length + Luhn. */
  readonly pan: string;
  readonly expMonth?: string;
  readonly expYear?: string;
  readonly merchantId: string;
}

export interface TokenizeResponse {
  readonly token: string;
  readonly bin: string;
  readonly last4: string;
  readonly scheme: CardScheme;
}

export interface DetokenizeRequest {
  readonly token: string;
  readonly merchantId: string;
  readonly reason: DetokenizeReason;
}

export interface DetokenizeResponse {
  readonly pan: string;
  readonly expMonth: string | null;
  readonly expYear: string | null;
}

export interface VaultClient {
  tokenize(req: TokenizeRequest): Promise<TokenizeResponse>;
  detokenize(req: DetokenizeRequest): Promise<DetokenizeResponse>;
}

export interface VaultClientOptions {
  readonly baseUrl: string;
  /** Service-auth signer (shared with the vault). */
  readonly serviceAuth: ServiceAuth;
  /** Caller service id — must match a known sender in the vault. */
  readonly senderId: 'api' | 'acquirer-host' | 'worker';
  readonly timeoutMs?: number;
  /** Inject for tests. Defaults to globalThis.fetch. */
  readonly fetchImpl?: typeof fetch;
}

export class VaultClientError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = 'VaultClientError';
  }
}

export function createVaultClient(opts: VaultClientOptions): VaultClient {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 5_000;

  async function post<TReq, TRes>(path: string, body: TReq): Promise<TRes> {
    const bodyStr = JSON.stringify(body);
    const bodySha256 = createHash('sha256').update(bodyStr).digest('hex');
    const tok = opts.serviceAuth.sign({
      sender: opts.senderId,
      method: 'POST',
      path,
      bodySha256,
    });
    const res = await fetchImpl(`${opts.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-service-auth': tok.header,
      },
      body: bodyStr,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const raw = await res.text();
    let parsed: unknown = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      parsed = raw;
    }
    if (!res.ok) {
      // If the vault returned a PspError-shape envelope, surface its code.
      const env = parsed as { error?: { code?: string; message?: string } } | null;
      const msg = env?.error?.message ?? `vault ${path} returned ${res.status}`;
      throw new VaultClientError(msg, res.status, parsed);
    }
    return parsed as TRes;
  }

  return {
    tokenize: (req) => post<TokenizeRequest, TokenizeResponse>('/internal/v1/tokenize', req),
    detokenize: (req) => post<DetokenizeRequest, DetokenizeResponse>('/internal/v1/detokenize', req),
  };
}

/**
 * Convenience: re-export the BIN-based scheme detection rule so non-vault code
 * (e.g. risk evaluation in Phase 7) can classify a token's BIN without calling
 * the vault. Keep this in sync with `apps/vault/src/lib/scheme.ts`.
 */
export function detectSchemeByBin(bin6: string): CardScheme {
  const digits = bin6.replace(/\D/g, '');
  if (digits.length < 4) return 'unknown';
  if (digits.startsWith('4')) return 'visa';
  if (/^5[1-5]/.test(digits)) return 'mastercard';
  if (/^2(2[2-9]|[3-6]\d|7[01]|720)/.test(digits)) return 'mastercard';
  if (/^3[47]/.test(digits)) return 'amex';
  return 'unknown';
}

/** Re-export so callers needing structured errors don't need a second import. */
export { PspError };
