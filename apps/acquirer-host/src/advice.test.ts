import { type Iso8583Message, buildMessage } from '@psp-new/iso8583';
import { createLogger } from '@psp-new/logger';
import type { DetokenizeRequest, DetokenizeResponse, VaultClient } from '@psp-new/vault-client';
import Fastify, { type FastifyInstance } from 'fastify';
import { type ZodTypeProvider, serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerCaptureRoute, registerReverseRoute } from './advice.js';
import type { SchemeClient } from './client.js';
import { createStanAllocator } from './stan.js';

/**
 * Fake SchemeClient — captures the outbound message so the assertions can
 * check MTI selection and field echoing without spinning up TCP.
 */
function fakeClient(approve = true): {
  client: SchemeClient;
  last: () => Iso8583Message | null;
} {
  let last: Iso8583Message | null = null;
  return {
    client: {
      send: async (req) => {
        last = req;
        return buildMessage(req.mti === '0220' ? '0230' : '0430', {
          11: (req.fields.get(11) as string) ?? '000000',
          37: (req.fields.get(37) as string) ?? '000000000000',
          39: approve ? '00' : '05',
        });
      },
      close: () => {},
      isConnected: () => true,
    },
    last: () => last,
  };
}

function fakeVault(): VaultClient {
  return {
    tokenize: async () => ({ token: 'tok_x', bin: '411111', last4: '1111', scheme: 'visa' }),
    detokenize: async (_req: DetokenizeRequest): Promise<DetokenizeResponse> => ({
      pan: '4111111111111111',
      expMonth: '12',
      expYear: '2030',
    }),
  };
}

async function buildApp(client: SchemeClient): Promise<FastifyInstance> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.withTypeProvider<ZodTypeProvider>();
  const logger = createLogger({ service: 'advice-test', level: 'warn' });
  const deps = { vault: fakeVault(), client, stan: createStanAllocator(), logger };
  registerCaptureRoute(app, deps);
  registerReverseRoute(app, deps);
  await app.ready();
  return app;
}

describe('acquirer-host capture/reverse advice', () => {
  let app: FastifyInstance;
  let fake: ReturnType<typeof fakeClient>;

  beforeAll(async () => {
    fake = fakeClient(true);
    app = await buildApp(fake.client);
  });

  afterAll(async () => {
    await app.close();
  });

  it('POST /internal/v1/capture builds 0220 and echoes original DE 11/37', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/internal/v1/capture',
      payload: {
        payment_intent_id: 'pi_x',
        merchant_id: 'mrch_x',
        token: 'tok_x',
        amount_minor: 1500,
        currency_numeric: '840',
        original_rrn: '000000010220',
        original_stan: '100220',
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.approved).toBe(true);
    expect(body.response_code).toBe('00');
    expect(body.rrn).toBe('000000010220');
    expect(body.stan).toBe('100220');

    const sent = fake.last();
    expect(sent?.mti).toBe('0220');
    expect(sent?.fields.get(3)).toBe('220000');
    expect(sent?.fields.get(11)).toBe('100220');
    expect(sent?.fields.get(37)).toBe('000000010220');
    expect(sent?.fields.get(4)).toBe('000000001500');
  });

  it('POST /internal/v1/reverse builds 0420 and echoes original DE 11/37', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/internal/v1/reverse',
      payload: {
        payment_intent_id: 'pi_y',
        merchant_id: 'mrch_y',
        token: 'tok_x',
        amount_minor: 800,
        currency_numeric: '840',
        original_rrn: '000000010420',
        original_stan: '100420',
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.approved).toBe(true);
    expect(body.response_code).toBe('00');

    const sent = fake.last();
    expect(sent?.mti).toBe('0420');
    expect(sent?.fields.get(3)).toBe('030000');
    expect(sent?.fields.get(11)).toBe('100420');
    expect(sent?.fields.get(37)).toBe('000000010420');
  });
});
