#!/usr/bin/env node
/**
 * Phase 45 — seed believable demo data for the README screenshots.
 *
 * Everything goes through a real HTTP surface. No SQL inserts:
 *   - merchants via the portal's POST /sign-up (the real sign-up form),
 *   - payments/refunds/disputes via the public REST API,
 *   - the 3DS challenge via the scheme simulator's own ACS page.
 *
 * Run after `make up` + `make migrate`, then
 * `pnpm --filter @psp-new/worker nightly:once` for clearing/settlement/payouts.
 *
 * No deps beyond Node. Prints no API keys.
 */

import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const API = process.env.API_URL ?? 'http://localhost:8080';
const PORTAL = process.env.PORTAL_URL ?? 'http://localhost:3000';

const fmt = { ok: '\x1b[32m✓\x1b[0m', fail: '\x1b[31m✗\x1b[0m' };

function die(msg) {
  console.error(`${fmt.fail} ${msg}`);
  process.exit(1);
}

let idemCounter = 0;
async function api(method, path, key, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      'idempotency-key': `seed_${Date.now()}_${idemCounter++}`,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

/** Create a merchant through the portal sign-up form; pull the keys out of the HTML. */
async function signUpMerchant(name) {
  const res = await fetch(`${PORTAL}/sign-up`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ name, env: 'test' }).toString(),
  });
  const html = await res.text();
  if (res.status !== 200) die(`sign-up for "${name}" returned ${res.status}`);
  const keys = [...html.matchAll(/<div class="key-box">([^<]+)<\/div>/g)].map((m) => m[1]);
  const id = html.match(/<code>(mrch_[A-Z0-9]+)<\/code>/)?.[1];
  const pk = keys.find((k) => k.startsWith('pk_test_'));
  const sk = keys.find((k) => k.startsWith('sk_test_'));
  if (!id || !pk || !sk) die(`could not parse sign-up response for "${name}"`);
  return { id, name, pk, sk };
}

async function payWithCard(m, { pan, amount, currency }) {
  // Hosted-fields path: tokenize with the publishable key, then build the
  // PaymentMethod from the token — the same two calls the iframe makes.
  const tok = await api('POST', '/v1/tokens', m.pk, {
    card: { number: pan, exp_month: '12', exp_year: '2031', cvc: '123' },
  });
  if (tok.status !== 201) die(`tokenize failed (${tok.status}): ${JSON.stringify(tok.json)}`);
  const pm = await api('POST', '/v1/payment_methods', m.sk, {
    type: 'card',
    card: { token: tok.json.id },
  });
  if (pm.status !== 201) die(`payment_method failed (${pm.status}): ${JSON.stringify(pm.json)}`);
  const pi = await api('POST', '/v1/payment_intents', m.sk, {
    amount,
    currency,
    payment_method: pm.json.id,
    confirm: true,
  });
  if (pi.status !== 201) die(`payment_intent failed (${pi.status}): ${JSON.stringify(pi.json)}`);
  return pi.json;
}

/** Click "Approve" on the simulator's ACS page, which calls back into the api. */
async function approveThreeDs(pi) {
  const url = pi.next_action?.redirect_url;
  if (!url) die(`payment ${pi.id} is ${pi.status} but carries no next_action.redirect_url`);
  const sessionId = pi.next_action.three_ds_session_id;
  const origin = new URL(url).origin;
  const res = await fetch(`${origin}/3ds/complete/${encodeURIComponent(sessionId)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ outcome: 'approve' }).toString(),
  });
  if (!res.ok) die(`3DS complete returned ${res.status}`);
}

const SUCCEEDS = '4242424242424242';
const THREE_DS = '4000000000000010';

/**
 * Issuing side. Cardholders and cards have no REST surface — the operator
 * CLIs are the real path — so shell out, then fund the card over the API.
 */
async function seedIssuing(funder) {
  const run = (args) =>
    execFileSync('pnpm', ['--silent', ...args], { cwd: REPO_ROOT, encoding: 'utf8', env: process.env });

  const cardholderId = run(['cardholder:create', '--email', 'mira.osei@example.com', '--name', 'Mira Osei']).match(
    /ch_[A-Z0-9]+/,
  )?.[0];
  if (!cardholderId) die('cardholder:create printed no ch_ id');

  const cardId = run(['card:issue', '--cardholder', cardholderId, '--product', 'prod_strawberry_visa_usd']).match(
    /card_[A-Z0-9]+/,
  )?.[0];
  if (!cardId) die('card:issue printed no card_ id');
  console.log(`${fmt.ok} card ${cardId} issued to Mira Osei`);

  // Fund it through POST /v1/cards/:id/load — the real route, which writes a
  // card_loads row and runs the acquiring leg. (The card:load CLI posts a
  // journal entry only, so the portal's "Recent loads" stays empty.)
  const tok = await api('POST', '/v1/tokens', funder.pk, {
    card: { number: SUCCEEDS, exp_month: '12', exp_year: '2031', cvc: '123' },
  });
  const pm = await api('POST', '/v1/payment_methods', funder.sk, {
    type: 'card',
    card: { token: tok.json.id },
  });
  const load = await api('POST', `/v1/cards/${cardId}/load`, funder.sk, {
    amount: 25000,
    currency: 'USD',
    payment_method: pm.json.id,
  });
  if (load.status !== 201) die(`card load failed (${load.status}): ${JSON.stringify(load.json)}`);
  console.log(`${fmt.ok} card load ${load.json.id} — 250.00 USD, ${load.json.status}`);
  return { cardholderId, cardId };
}

async function main() {
  const health = await fetch(`${API}/v1/healthz`).catch(() => null);
  if (!health?.ok) die(`api not reachable at ${API} — run make up first`);

  const merchants = [];
  for (const name of ['Northwind Books', 'Harbour Cycles', 'Lumen Analytics']) {
    const m = await signUpMerchant(name);
    merchants.push(m);
    console.log(`${fmt.ok} merchant ${m.name} — ${m.id}`);
  }
  const [northwind, harbour, lumen] = merchants;

  // Nine payments across the three merchants, EUR and USD.
  const plan = [
    { m: northwind, pan: SUCCEEDS, amount: 4500, currency: 'EUR' },
    { m: northwind, pan: SUCCEEDS, amount: 12900, currency: 'EUR' },
    { m: northwind, pan: SUCCEEDS, amount: 2250, currency: 'USD' },
    { m: harbour, pan: SUCCEEDS, amount: 89900, currency: 'EUR' },
    { m: harbour, pan: SUCCEEDS, amount: 34500, currency: 'USD' },
    { m: harbour, pan: SUCCEEDS, amount: 7600, currency: 'EUR' },
    { m: lumen, pan: SUCCEEDS, amount: 19900, currency: 'USD' },
    { m: lumen, pan: SUCCEEDS, amount: 64000, currency: 'USD' },
    { m: lumen, pan: THREE_DS, amount: 15000, currency: 'EUR' },
  ];

  const paid = [];
  for (const step of plan) {
    const pi = await payWithCard(step.m, step);
    if (pi.status === 'requires_action') {
      await approveThreeDs(pi);
      // The ACS callback into the api is a separate request, so poll rather
      // than read once — a single GET races it and reports requires_action.
      let after = pi;
      for (let i = 0; i < 20 && after.status === 'requires_action'; i++) {
        await new Promise((r) => setTimeout(r, 250));
        after = (await api('GET', `/v1/payment_intents/${pi.id}`, step.m.sk)).json;
      }
      console.log(
        `${fmt.ok} ${step.m.name} ${step.amount} ${step.currency} — 3DS challenge approved → ${after.status}`,
      );
      paid.push({ ...step, pi: after });
      continue;
    }
    console.log(`${fmt.ok} ${step.m.name} ${step.amount} ${step.currency} — ${pi.status}`);
    paid.push({ ...step, pi });
  }

  // One partial refund.
  const toRefund = paid.find((p) => p.m === harbour && p.amount === 89900);
  const refund = await api('POST', '/v1/refunds', toRefund.m.sk, {
    payment_intent: toRefund.pi.id,
    amount: 15000,
    reason: 'requested_by_customer',
  });
  if (refund.status !== 201) die(`refund failed (${refund.status}): ${JSON.stringify(refund.json)}`);
  console.log(`${fmt.ok} refund ${refund.json.id} — 15000 ${toRefund.currency} of ${toRefund.pi.id}`);

  // One dispute: Visa 13.1, merchandise/services not received.
  const toDispute = paid.find((p) => p.m === northwind && p.amount === 12900);
  const dispute = await api('POST', '/v1/disputes', toDispute.m.sk, {
    payment_intent: toDispute.pi.id,
    scheme: 'visa',
    reason_code: 'visa_13.1',
    amount: toDispute.amount,
    currency: toDispute.currency,
  });
  if (dispute.status !== 201) die(`dispute failed (${dispute.status}): ${JSON.stringify(dispute.json)}`);
  console.log(`${fmt.ok} dispute ${dispute.json.id} — visa_13.1, state ${dispute.json.state}`);

  const issuing = await seedIssuing(lumen);

  console.log(
    `\nseeded ${merchants.length} merchants, ${paid.length} payments, 1 refund, 1 dispute, ` +
      `1 issued card (${issuing.cardId}).\n` +
      'next: pnpm --filter @psp-new/worker nightly:once',
  );
}

main().catch((err) => die(`seed crashed: ${err?.stack ?? err}`));
