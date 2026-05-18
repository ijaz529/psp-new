#!/usr/bin/env node
/**
 * Phase 0 smoke test. Assumes `make up-full` is running.
 *
 *  1. Hit /healthz on every public-facing service.
 *  2. Hit POST /v1/_dev/echo on api with an Idempotency-Key; confirm request_id surfaces.
 *  3. Replay the same key; confirm `idempotency-replay: true` header.
 *  4. Re-use the key with a different body; confirm 422 idempotency_key_reused_with_different_body.
 *  5. Confirm /metrics on api exposes psp_canary_healthz_requests_total.
 *  6. Confirm Jaeger and Prometheus respond.
 *
 * Fails fast on the first failed assertion. No deps beyond Node.
 */

const PROBES = [
  { name: 'api', url: 'http://localhost:8080/healthz' },
  { name: 'scheme-simulator-http', url: 'http://localhost:9002/healthz' },
  { name: 'jaeger-ui', url: 'http://localhost:16686/api/services', soft: true },
  { name: 'prometheus', url: 'http://localhost:9090/-/ready', soft: true },
  { name: 'grafana', url: 'http://localhost:3001/api/health', soft: true },
];

const fmt = { ok: '\x1b[32m✓\x1b[0m', fail: '\x1b[31m✗\x1b[0m', warn: '\x1b[33m!\x1b[0m' };

async function get(url, headers = {}) {
  const res = await fetch(url, { headers });
  return { status: res.status, body: await res.text(), headers: Object.fromEntries(res.headers) };
}

async function postJson(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.text(), headers: Object.fromEntries(res.headers) };
}

function expect(cond, msg) {
  if (!cond) {
    console.error(`${fmt.fail} ${msg}`);
    process.exit(1);
  }
  console.log(`${fmt.ok} ${msg}`);
}

async function main() {
  console.log('--- probes ---');
  for (const p of PROBES) {
    try {
      const r = await get(p.url);
      if (r.status >= 200 && r.status < 400) {
        console.log(`${fmt.ok} ${p.name} (${r.status})`);
      } else if (p.soft) {
        console.log(`${fmt.warn} ${p.name} (${r.status}) — soft probe`);
      } else {
        console.error(`${fmt.fail} ${p.name} (${r.status})`);
        process.exit(1);
      }
    } catch (e) {
      if (p.soft) {
        console.log(`${fmt.warn} ${p.name} unreachable — soft probe`);
      } else {
        console.error(`${fmt.fail} ${p.name} unreachable: ${e.message}`);
        process.exit(1);
      }
    }
  }

  console.log('\n--- idempotency demo ---');
  const key = `idem_${Math.random().toString(36).slice(2, 10)}`;
  const headers = { 'idempotency-key': key };

  const a = await postJson('http://localhost:8080/v1/_dev/echo', { message: 'hello' }, headers);
  expect(a.status === 201, `first POST returns 201 (got ${a.status})`);
  const body = JSON.parse(a.body);
  expect(body.received === 'hello', 'echoes the message');
  expect(body.request_id?.startsWith('req_'), `request_id starts with req_ (got ${body.request_id})`);
  expect(a.headers['x-request-id']?.startsWith('req_'), 'X-Request-Id present');

  const b = await postJson('http://localhost:8080/v1/_dev/echo', { message: 'hello' }, headers);
  expect(b.status === 201, `replay returns same 201 (got ${b.status})`);
  expect(b.headers['idempotency-replay'] === 'true', 'Idempotency-Replay: true header on replay');

  const c = await postJson('http://localhost:8080/v1/_dev/echo', { message: 'different' }, headers);
  expect(c.status === 422, `body-mismatch returns 422 (got ${c.status})`);
  const cerr = JSON.parse(c.body);
  expect(cerr.error?.code === 'idempotency_key_reused_with_different_body', 'correct error.code');

  console.log('\n--- metrics ---');
  const m = await get('http://localhost:8080/metrics');
  expect(m.status === 200, 'metrics endpoint 200');
  expect(m.body.includes('psp_canary_healthz_requests_total'), 'canary counter exposed');
  expect(m.body.includes('psp_http_requests_total'), 'RED counter exposed');

  console.log('\n--- error envelope ---');
  const e = await postJson(
    'http://localhost:8080/v1/_dev/echo',
    { message: '' },
    { 'idempotency-key': 'idem_validate' },
  );
  expect(e.status === 400, `validation failure returns 400 (got ${e.status})`);
  const eerr = JSON.parse(e.body);
  expect(eerr.error?.code === 'parameter_invalid', 'parameter_invalid envelope');

  console.log('\nsmoke ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
