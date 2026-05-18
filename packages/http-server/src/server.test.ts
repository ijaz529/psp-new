import { PspError } from '@psp-new/errors';
import { nullLogger } from '@psp-new/logger';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createHttpServer } from './server.js';

async function makeApp() {
  return createHttpServer({ serviceName: 'http-server-test', logger: nullLogger() });
}

describe('createHttpServer', () => {
  it('healthz returns ok + service name', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.service).toBe('http-server-test');
    await app.close();
  });

  it('readyz returns ready with no checks', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ready');
    await app.close();
  });

  it('readyz returns 503 when a check fails', async () => {
    const app = await createHttpServer({
      serviceName: 'http-server-test',
      logger: nullLogger(),
      readinessChecks: [{ name: 'db', check: async () => false }],
    });
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(503);
    expect(res.json().checks.db).toBe(false);
    await app.close();
  });

  it('metrics endpoint exposes prom-client text format', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.body).toContain('psp_http_requests_total');
  });

  it('every response carries an X-Request-Id', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.headers['x-request-id']).toMatch(/^req_[0-9A-HJKMNP-TV-Z]{26}$/);
    await app.close();
  });

  it('PspError becomes Stripe-shape envelope', async () => {
    const app = await makeApp();
    app.get('/boom', async () => {
      throw new PspError('card_declined', {
        message: 'Your card has insufficient funds.',
        declineCode: 'insufficient_funds',
        param: 'payment_method',
      });
    });
    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(402);
    const body = res.json();
    expect(body.error.code).toBe('card_declined');
    expect(body.error.decline_code).toBe('insufficient_funds');
    expect(body.error.param).toBe('payment_method');
    expect(body.error.request_id).toMatch(/^req_/);
    await app.close();
  });

  it('unknown error becomes internal_error 500 with stable shape', async () => {
    const app = await makeApp();
    app.get('/oops', async () => {
      throw new Error('something exploded internally');
    });
    const res = await app.inject({ method: 'GET', url: '/oops' });
    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body.error.code).toBe('internal_error');
    expect(body.error.type).toBe('api_error');
    expect(body.error.request_id).toMatch(/^req_/);
    expect(JSON.stringify(body)).not.toContain('something exploded internally');
    await app.close();
  });

  it('zod validation failure produces a parameter_invalid envelope', async () => {
    const app = await makeApp();
    const typed = app.withTypeProvider<import('fastify-type-provider-zod').ZodTypeProvider>();
    typed.post('/echo', {
      schema: { body: z.object({ amount: z.number().int().positive() }) },
      handler: async (req) => ({ ok: true, amount: (req.body as { amount: number }).amount }),
    });
    const res = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'unused-here' },
      payload: { amount: -1 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('parameter_invalid');
    await app.close();
  });

  it('rejects malformed PayCore-Version header', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { 'paycore-version': 'banana' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('unsupported_api_version');
    await app.close();
  });

  it('accepts well-formed PayCore-Version date and echoes it', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { 'paycore-version': '2026-01-01' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['paycore-version']).toBe('2026-01-01');
    await app.close();
  });
});
