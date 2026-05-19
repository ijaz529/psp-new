import { PspError } from '@psp-new/errors';
import { type Iso8583Message, buildMessage } from '@psp-new/iso8583';
import type { Logger } from '@psp-new/logger';
import type { VaultClient } from '@psp-new/vault-client';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { SchemeClient } from './client.js';
import type { StanAllocator } from './stan.js';

const AuthorizeBody = z.object({
  payment_intent_id: z.string(),
  merchant_id: z.string(),
  token: z.string().regex(/^tok_/),
  amount_minor: z.number().int().positive(),
  /** ISO 4217 numeric, 3-digit string (e.g. '840' for USD). */
  currency_numeric: z.string().regex(/^\d{3}$/),
  /** Card exp YYMM (DE 14). */
  exp_yymm: z
    .string()
    .regex(/^\d{4}$/)
    .optional(),
  /** 3DS data carried into DE 48.43 — flat encoding for Phase 5. */
  eci: z.string().optional(),
  cavv: z.string().optional(),
  trans_status: z.string().optional(),
  /**
   * Phase 10. 'automatic' → 0200 (combined auth + settle on the issuer's books
   * in one round-trip). 'manual' → 0100 (auth-only; capture follows later via
   * /internal/v1/capture which sends 0220). Defaults to 'automatic' to preserve
   * Phase 5–9 behaviour for callers that haven't been updated.
   */
  capture_method: z.enum(['automatic', 'manual']).optional(),
});

export interface AuthorizeDeps {
  readonly vault: VaultClient;
  readonly client: SchemeClient;
  readonly stan: StanAllocator;
  readonly logger: Logger;
  readonly terminalId?: string;
  readonly merchantIdForScheme?: string;
}

export function registerAuthorizeRoute(app: FastifyInstance, deps: AuthorizeDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.post('/internal/v1/authorize', {
    schema: { body: AuthorizeBody },
    handler: async (req) => {
      const body = req.body as z.infer<typeof AuthorizeBody>;

      // Detokenize the PAN — the ONLY place the acquirer-host sees raw PAN.
      const det = await deps.vault.detokenize({
        token: body.token,
        merchantId: body.merchant_id,
        reason: 'authorization',
      });

      const pan = det.pan;
      const { stan, rrn } = deps.stan.nextRrn();
      const expYymm = body.exp_yymm ?? (det.expMonth && det.expYear ? det.expYear.slice(2) + det.expMonth : '3012');
      const now = new Date();
      const transmission =
        pad2(now.getUTCMonth() + 1) +
        pad2(now.getUTCDate()) +
        pad2(now.getUTCHours()) +
        pad2(now.getUTCMinutes()) +
        pad2(now.getUTCSeconds());

      const authMti = body.capture_method === 'manual' ? '0100' : '0200';
      const reqMsg = buildMessage(authMti, {
        2: pan,
        3: '000000',
        4: body.amount_minor.toString().padStart(12, '0'),
        7: transmission,
        11: stan,
        12: pad2(now.getUTCHours()) + pad2(now.getUTCMinutes()) + pad2(now.getUTCSeconds()),
        13: pad2(now.getUTCMonth() + 1) + pad2(now.getUTCDate()),
        14: expYymm,
        22: '012',
        37: rrn,
        41: deps.terminalId ?? 'TERM0001',
        42: (deps.merchantIdForScheme ?? body.merchant_id).slice(0, 15).padEnd(15, ' '),
        49: body.currency_numeric,
      });

      let respMsg: Iso8583Message;
      try {
        respMsg = await deps.client.send(reqMsg);
      } catch (err) {
        deps.logger.warn({ err: (err as Error).message, stan, rrn }, 'scheme send failed');
        throw new PspError('acquirer_timeout', { internal: { stan, rrn } });
      }

      const rc = (respMsg.fields.get(39) as string | undefined) ?? '96';
      const auth = (respMsg.fields.get(38) as string | undefined) ?? '';

      // Note: do NOT log the PAN here — assertNoPan would catch it. Just RRN/STAN/RC.
      deps.logger.info(
        { mti: respMsg.mti, rc, stan, rrn, payment_intent_id: body.payment_intent_id },
        'authorization complete',
      );

      return {
        approved: rc === '00',
        response_code: rc,
        approval_code: auth || null,
        rrn,
        stan,
      };
    },
  });
}

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}
