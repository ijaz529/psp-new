import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Internal service-to-service auth. Stubs mTLS — when we adopt real mTLS the
 * `verifyServiceToken` interface stays the same but the implementation reads
 * the peer cert SAN instead of an HMAC.
 *
 * Token format (Stripe-webhook-style):
 *   t=<unix-seconds>,s=<sender>,v1=<hmac_b64url>
 *
 * The signed payload is:
 *   <sender>.<unix-seconds>.<method>.<path>.<body-sha256-hex>
 *
 * The body hash is required for state-changing endpoints. For idempotent GETs
 * the caller passes an empty body hash (`""`); the signature still binds the
 * method + path so replay across endpoints is rejected.
 */
export interface SignArgs {
  /** Caller service id, e.g. 'api', 'worker'. */
  readonly sender: string;
  /** Request method, uppercase. */
  readonly method: string;
  /** Request path including query, lowercased. */
  readonly path: string;
  /** sha256 hex of the request body, or '' for empty body. */
  readonly bodySha256: string;
  /** Unix seconds; injectable for tests. */
  readonly now?: number;
}

export interface SignedToken {
  /** Header value to send as `X-Service-Auth`. */
  readonly header: string;
}

export interface VerifyArgs extends Omit<SignArgs, 'sender' | 'now'> {
  readonly header: string;
  /** Allowed clock skew in seconds (default 300). */
  readonly skewSeconds?: number;
  /** Now in unix seconds (injectable for tests). */
  readonly now?: number;
}

export interface VerifyResult {
  readonly sender: string;
  readonly issuedAt: number;
}

export class ServiceAuthError extends Error {
  constructor(
    message: string,
    public readonly reason:
      | 'malformed_header'
      | 'missing_secret'
      | 'unknown_sender'
      | 'signature_invalid'
      | 'request_too_old',
  ) {
    super(message);
    this.name = 'ServiceAuthError';
  }
}

function payloadString(args: {
  sender: string;
  now: number;
  method: string;
  path: string;
  bodySha256: string;
}): string {
  return `${args.sender}.${args.now}.${args.method.toUpperCase()}.${args.path.toLowerCase()}.${args.bodySha256}`;
}

function hmacB64url(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export interface ServiceAuth {
  sign(args: SignArgs): SignedToken;
  verify(args: VerifyArgs): VerifyResult;
}

/**
 * Build a ServiceAuth from a sender-id -> shared-secret map. Both ends of every
 * link share the secret; symmetric is fine inside the cluster because none of
 * these services are exposed to merchants.
 */
export function createServiceAuth(opts: { secretsBySender: ReadonlyMap<string, string> }): ServiceAuth {
  return {
    sign({ sender, method, path, bodySha256, now }) {
      const secret = opts.secretsBySender.get(sender);
      if (!secret) throw new ServiceAuthError(`no secret for sender '${sender}'`, 'missing_secret');
      const t = now ?? Math.floor(Date.now() / 1000);
      const sig = hmacB64url(secret, payloadString({ sender, now: t, method, path, bodySha256 }));
      return { header: `t=${t},s=${sender},v1=${sig}` };
    },

    verify({ header, method, path, bodySha256, skewSeconds, now }) {
      const parts: Record<string, string> = {};
      for (const seg of header.split(',')) {
        const eq = seg.indexOf('=');
        if (eq === -1) continue;
        parts[seg.slice(0, eq).trim()] = seg.slice(eq + 1).trim();
      }
      const t = parts.t ? Number.parseInt(parts.t, 10) : Number.NaN;
      const sender = parts.s;
      const sig = parts.v1;
      if (!sender || !sig || Number.isNaN(t)) {
        throw new ServiceAuthError('malformed X-Service-Auth header', 'malformed_header');
      }

      const secret = opts.secretsBySender.get(sender);
      if (!secret) throw new ServiceAuthError(`unknown sender '${sender}'`, 'unknown_sender');

      const nowS = now ?? Math.floor(Date.now() / 1000);
      const skew = skewSeconds ?? 300;
      if (Math.abs(nowS - t) > skew) {
        throw new ServiceAuthError(`request timestamp outside skew (${nowS - t}s)`, 'request_too_old');
      }

      const expected = hmacB64url(secret, payloadString({ sender, now: t, method, path, bodySha256 }));
      const a = Buffer.from(sig, 'base64url');
      const b = Buffer.from(expected, 'base64url');
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        throw new ServiceAuthError('signature mismatch', 'signature_invalid');
      }

      return { sender, issuedAt: t };
    },
  };
}
