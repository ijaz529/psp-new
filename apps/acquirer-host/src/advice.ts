import { PspError } from '@psp-new/errors';
import { type Iso8583Message, type Mti, buildMessage } from '@psp-new/iso8583';
import type { Logger } from '@psp-new/logger';
import type { VaultClient } from '@psp-new/vault-client';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { SchemeClient } from './client.js';
import type { StanAllocator } from './stan.js';

/**
 * Phase 10 — capture (0220) and reversal (0420) endpoints.
 *
 * Both reuse the original RRN/STAN from the 0100 auth so the issuer-host
 * (and external stub) can correlate the advice with the open hold via
 * `paycore.card_auth_holds`'s `unique(stan, rrn)` constraint. A new STAN is
 * allocated for the advice message itself; for MVP both ride on DE 11/37
 * directly (real ISO 8583 nests the original ids in DE 90 — see
 * PHASE_10_PLAN.md §Simplifications).
 */

const AdviceBody = z.object({
  payment_intent_id: z.string(),
  merchant_id: z.string(),
  token: z.string().regex(/^tok_/),
  amount_minor: z.number().int().positive(),
  currency_numeric: z.string().regex(/^\d{3}$/),
  /** RRN and STAN echoed from the original 0100/0200 authorization. */
  original_rrn: z.string().length(12),
  original_stan: z.string().length(6),
});

export interface AdviceDeps {
  readonly vault: VaultClient;
  readonly client: SchemeClient;
  readonly stan: StanAllocator;
  readonly logger: Logger;
  readonly terminalId?: string;
  readonly merchantIdForScheme?: string;
}

export function registerCaptureRoute(app: FastifyInstance, deps: AdviceDeps): void {
  registerAdviceRoute(app, deps, '/internal/v1/capture', '0220', '220000', 'capture');
}

export function registerReverseRoute(app: FastifyInstance, deps: AdviceDeps): void {
  registerAdviceRoute(app, deps, '/internal/v1/reverse', '0420', '030000', 'reverse');
}

function registerAdviceRoute(
  app: FastifyInstance,
  deps: AdviceDeps,
  path: string,
  mti: Mti,
  procCode: string,
  label: 'capture' | 'reverse',
): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.post(path, {
    schema: { body: AdviceBody },
    handler: async (req) => {
      const body = req.body as z.infer<typeof AdviceBody>;

      // Detokenize so the scheme-simulator can BIN-route. The issuer-host
      // itself doesn't need DE 2 PAN for capture (it looks up by stan/rrn),
      // but the router in between does.
      const det = await deps.vault.detokenize({
        token: body.token,
        merchantId: body.merchant_id,
        reason: label === 'capture' ? 'capture' : 'reversal',
        // 'reversal' added to DetokenizeReason in Phase 10 (vault-client + vault).
      });
      const pan = det.pan;

      const reqMsg = buildMessage(mti, {
        2: pan,
        3: procCode,
        4: body.amount_minor.toString().padStart(12, '0'),
        7: nowTransmission(),
        11: body.original_stan,
        37: body.original_rrn,
        41: deps.terminalId ?? 'TERM0001',
        42: (deps.merchantIdForScheme ?? body.merchant_id).slice(0, 15).padEnd(15, ' '),
        49: body.currency_numeric,
      });

      let respMsg: Iso8583Message;
      try {
        respMsg = await deps.client.send(reqMsg);
      } catch (err) {
        deps.logger.warn(
          { err: (err as Error).message, stan: body.original_stan, rrn: body.original_rrn, label },
          'scheme send failed',
        );
        throw new PspError('acquirer_timeout', { internal: { label } });
      }

      const rc = (respMsg.fields.get(39) as string | undefined) ?? '96';
      deps.logger.info(
        {
          mti: respMsg.mti,
          rc,
          stan: body.original_stan,
          rrn: body.original_rrn,
          payment_intent_id: body.payment_intent_id,
          label,
        },
        `${label} complete`,
      );

      return {
        approved: rc === '00',
        response_code: rc,
        rrn: body.original_rrn,
        stan: body.original_stan,
      };
    },
  });
}

function nowTransmission(): string {
  const n = new Date();
  return (
    pad2(n.getUTCMonth() + 1) +
    pad2(n.getUTCDate()) +
    pad2(n.getUTCHours()) +
    pad2(n.getUTCMinutes()) +
    pad2(n.getUTCSeconds())
  );
}
function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}
