#!/usr/bin/env tsx
/**
 * Phase 42 — the `make e2e` payment canary (PROJECT_BRIEF §5).
 *
 * Drives the running compose stack from the host: fixture a merchant,
 * tokenize a card through the real vault, run a PaymentIntent through the
 * real ISO 8583 wire (api → acquirer-host → scheme-simulator stub issuer),
 * refund part of it, run one nightly pass (clearing → payouts → scheme
 * settlement), then assert the books:
 *
 *   - the clearing record carries the REAL DE 37 RRN from the auth,
 *   - a payout was paid,
 *   - scheme_receivable[visa, USD] drained to zero,
 *   - and the canary invariant: every currency's journal lines sum to 0.
 *
 * Card 4242 4242 4242 4242: outside the 3DS demo BINs (400000/555555) and
 * the Strawberry issuing ranges, so the simulator's stub issuer approves.
 */

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateApiKey } from '@psp-new/api-keys';
import { createKysely, createPool, dbConfigFromEnv } from '@psp-new/db';
import { newId } from '@psp-new/ids';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');
const API = process.env.API_URL ?? 'http://localhost:8080';

// `make e2e` and bare `pnpm canary` both work: fall back to the repo .env
// for DATABASE_URL when the shell hasn't exported it.
if (!process.env.DATABASE_URL) {
  const envFile = join(REPO_ROOT, '.env');
  if (existsSync(envFile)) {
    const m = readFileSync(envFile, 'utf8').match(/^DATABASE_URL=(.+)$/m);
    if (m?.[1]) process.env.DATABASE_URL = m[1].trim();
  }
}

const steps: Array<{ name: string; detail: string }> = [];
function pass(name: string, detail: string): void {
  steps.push({ name, detail });
  console.log(`  ✓ ${name} — ${detail}`);
}
function fail(name: string, detail: string): never {
  console.error(`  ✗ ${name} — ${detail}`);
  console.error('\nCANARY FAILED');
  process.exit(1);
}

async function api(
  method: string,
  path: string,
  key: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      'idempotency-key': `canary_${randomUUID()}`,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function main(): Promise<void> {
  console.log('e2e canary — full payment → ledger → clearing → settlement → payout\n');

  // 1. Stack is up.
  const health = await fetch(`${API}/v1/healthz`).catch(() => null);
  if (!health?.ok) fail('api healthz', `api not reachable at ${API} — run make up first`);
  pass('api healthz', API);

  const pool = createPool({ ...dbConfigFromEnv(), applicationName: 'e2e-canary' });
  const db = createKysely(pool);

  // The nightly jobs are once-per-day idempotent: one clearing file per
  // (scheme, currency, date), one scheme_settle journal per day. On a re-run
  // within the same UTC day those steps are no-ops for transactions created
  // after the first pass, so the canary records the pre-run state and skips
  // (honestly) the assertions a same-day re-run cannot satisfy.
  const today = new Date();
  const todayStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const preExistingFile = await db
    .selectFrom('paycore.clearing_files')
    .select('id')
    .where('scheme', '=', 'visa')
    .where('currency', '=', 'USD')
    .where('file_date', '>=', todayStart)
    .executeTakeFirst();
  const settleDayKey = `${today.getUTCFullYear()}${String(today.getUTCMonth() + 1).padStart(2, '0')}${String(today.getUTCDate()).padStart(2, '0')}`;
  const preExistingSettle = await db
    .selectFrom('ledger.journal_entries')
    .select('id')
    .where('external_id', '=', `scheme_settle:${settleDayKey}:visa:USD`)
    .executeTakeFirst();

  // 2. Fresh merchant + keys, straight into the DB (no CLI output parsing).
  const merchantId = newId('merchant');
  const sk = generateApiKey({ kind: 'secret', env: 'test' });
  const pk = generateApiKey({ kind: 'publishable', env: 'test' });
  await db
    .insertInto('paycore.merchants')
    .values({
      id: merchantId,
      name: `Canary ${new Date().toISOString().slice(0, 10)}`,
      env: 'test',
      allowed_origins: [],
      reserve_basis_points: 0,
      payout_schedule: 'daily',
      kyb_status: 'approved',
      kyb_data: null,
      created_at: new Date(),
    })
    .execute();
  await db
    .insertInto('paycore.api_keys')
    .values(
      [sk, pk].map((k) => ({
        id: k.id,
        merchant_id: merchantId,
        kind: k.kind,
        env: 'test' as const,
        prefix: k.prefix,
        sha256_hash: k.sha256Hash,
        created_at: new Date(),
        last_used_at: null,
        revoked_at: null,
      })),
    )
    .execute();
  pass('merchant fixture', merchantId);

  // 3. Tokenize through the real vault (publishable key).
  const tok = await api('POST', '/v1/tokens', pk.raw, {
    card: { number: '4242424242424242', exp_month: '12', exp_year: '2031', cvc: '123' },
  });
  if (tok.status !== 201) fail('vault tokenize', `expected 201, got ${tok.status}: ${JSON.stringify(tok.json)}`);
  pass('vault tokenize', `${tok.json.id} (${tok.json.scheme} …${tok.json.last4})`);

  // 4. Payment method — raw-card path (the route tokenizes server-side via
  // the same vault; pm-from-token is reserved for the hosted-fields flow).
  const pm = await api('POST', '/v1/payment_methods', sk.raw, {
    type: 'card',
    card: { number: '4242424242424242', exp_month: '12', exp_year: '2031', cvc: '123' },
  });
  if (pm.status !== 201) fail('payment_method', `expected 201, got ${pm.status}: ${JSON.stringify(pm.json)}`);
  pass('payment_method', String(pm.json.id));

  // 5. PaymentIntent, confirmed — the real ISO 8583 leg.
  const pi = await api('POST', '/v1/payment_intents', sk.raw, {
    amount: 10000,
    currency: 'USD',
    payment_method: pm.json.id,
    confirm: true,
  });
  if (pi.status !== 201 || pi.json.status !== 'succeeded') {
    fail('payment_intent', `expected 201 succeeded, got ${pi.status} ${pi.json.status}: ${JSON.stringify(pi.json)}`);
  }
  const piId = String(pi.json.id);
  const piRow = await db
    .selectFrom('paycore.payment_intents')
    .select(['last_auth_rrn', 'last_auth_stan', 'captured_at'])
    .where('id', '=', piId)
    .executeTakeFirstOrThrow();
  if (!piRow.last_auth_rrn || !piRow.last_auth_stan) {
    fail('iso8583 wire', 'last_auth_rrn/stan are NULL — the auth never crossed the acquirer wire');
  }
  pass('payment_intent', `${piId} succeeded, RRN ${piRow.last_auth_rrn} STAN ${piRow.last_auth_stan}`);

  // 6. Partial refund.
  const refund = await api('POST', '/v1/refunds', sk.raw, { payment_intent: piId, amount: 2500 });
  if (refund.status !== 201) fail('refund', `expected 201, got ${refund.status}: ${JSON.stringify(refund.json)}`);
  const afterRefund = await db
    .selectFrom('paycore.payment_intents')
    .select('amount_received')
    .where('id', '=', piId)
    .executeTakeFirstOrThrow();
  if (afterRefund.amount_received !== 7500n) {
    fail('refund', `amount_received expected 7500, got ${afterRefund.amount_received}`);
  }
  pass('refund', `${refund.json.id} for 2500, amount_received now 7500`);

  // 7. One nightly pass: clearing files → payouts → scheme settlement.
  execFileSync('pnpm', ['--filter', '@psp-new/worker', 'nightly:once'], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'inherit', 'inherit'],
    env: process.env,
  });
  pass('nightly-once', 'clearing + payouts + scheme settlement ran');

  // 8. Clearing record carries the REAL RRN (Phase 34, live).
  const cr = await db
    .selectFrom('paycore.clearing_records')
    .innerJoin('paycore.clearing_files', 'paycore.clearing_files.id', 'paycore.clearing_records.clearing_file_id')
    .select(['paycore.clearing_records.rrn as rrn', 'paycore.clearing_files.path as path'])
    .where('paycore.clearing_records.payment_intent_id', '=', piId)
    .executeTakeFirst();
  if (!cr) {
    if (preExistingFile) {
      pass('clearing record', 'skipped — today’s file already emitted before this run (daily idempotency)');
    } else {
      fail('clearing record', `no clearing_records row for ${piId}`);
    }
  } else {
    if (cr.rrn !== piRow.last_auth_rrn) {
      fail('clearing record', `file RRN ${cr.rrn} != auth RRN ${piRow.last_auth_rrn}`);
    }
    if (!existsSync(cr.path)) fail('clearing file', `${cr.path} not on disk`);
    pass('clearing record', `RRN ${cr.rrn} in ${cr.path.split('/').slice(-1)[0]}`);
  }

  // 9. Payout paid.
  const payout = await db
    .selectFrom('paycore.payouts')
    .select(['id', 'amount', 'status'])
    .where('merchant_id', '=', merchantId)
    .executeTakeFirst();
  if (!payout || payout.status !== 'paid') {
    fail('payout', payout ? `status ${payout.status}` : 'no payout row for the canary merchant');
  }
  if (payout.amount <= 0n) fail('payout', `non-positive amount ${payout.amount}`);
  // Phase 43: the payout must equal what the books owed — 10000 captured less
  // 300 MDR, less the 2500 refund net of its 75 MDR rebate = 7275. Before
  // Phase 43 this paid 5000 (refunds double-netted, MDR ignored).
  if (payout.amount !== 7275n) {
    fail('payout', `expected 7275 (capture 9700 − refund 2425), got ${payout.amount}`);
  }
  pass('payout', `${payout.id} paid ${payout.amount} = settlement liability`);

  // 10. Scheme receivable drained by settlement.
  const recv = await db
    .selectFrom('ledger.journal_lines')
    .innerJoin('ledger.accounts', 'ledger.accounts.id', 'ledger.journal_lines.account_id')
    .select((eb) => eb.fn.sum<bigint | string | null>('ledger.journal_lines.amount').as('total'))
    .where('ledger.accounts.code', '=', 'scheme_receivable')
    .where('ledger.accounts.currency', '=', 'USD')
    .executeTakeFirst();
  const recvTotal = BigInt(recv?.total ?? 0n);
  if (recvTotal !== 0n) {
    if (preExistingSettle) {
      pass('scheme settlement', `skipped — today's scheme_settle journal predates this run (residual ${recvTotal})`);
    } else {
      fail('scheme settlement', `scheme_receivable USD lines sum to ${recvTotal}, expected 0`);
    }
  } else {
    pass('scheme settlement', 'scheme_receivable USD drained to 0');
  }

  // 11. THE canary invariant: double-entry or it didn't happen.
  const sums = await db
    .selectFrom('ledger.journal_lines')
    .select((eb) => ['currency', eb.fn.sum<bigint | string | null>('amount').as('total')])
    .groupBy('currency')
    .execute();
  for (const s of sums) {
    if (BigInt(s.total ?? 0n) !== 0n) fail('ledger zero-sum', `${s.currency} sums to ${s.total}`);
  }
  pass('ledger zero-sum', `${sums.map((s) => s.currency).join(', ') || 'no currencies'} all sum to 0`);

  await pool.end();
  console.log(`\nCANARY PASSED — ${steps.length} steps green`);
}

main().catch((err: unknown) => {
  console.error('canary crashed', err);
  process.exit(1);
});
