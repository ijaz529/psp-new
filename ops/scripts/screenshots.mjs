#!/usr/bin/env node
/**
 * Phase 45 — capture the README screenshots from the running stack.
 *
 * Run after `make up`, `make migrate`, `node ops/scripts/seed-demo.mjs` and
 * `pnpm --filter @psp-new/worker nightly:once`.
 *
 *   set -a; source .env; set +a; node ops/scripts/screenshots.mjs
 *
 * Needs PORTAL_DEMO_EMAIL + PORTAL_DEMO_PASSWORD in the environment for the
 * portal sign-in. They are never printed and never appear in a capture: the
 * sign-in happens over HTTP and only the resulting session cookie is handed
 * to the browser.
 *
 * Writes PNGs to docs/images/. 1440x900, light mode, cropped to content.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const OUT_DIR = join(REPO_ROOT, 'docs', 'images');

const API = process.env.API_URL ?? 'http://localhost:8080';
const PORTAL = process.env.PORTAL_URL ?? 'http://localhost:3000';
const CHECKOUT = process.env.CHECKOUT_URL ?? 'http://localhost:7001';
const JAEGER = process.env.JAEGER_URL ?? 'http://localhost:16686';

const VIEWPORT = { width: 1440, height: 900 };
const fmt = { ok: '\x1b[32m✓\x1b[0m', warn: '\x1b[33m!\x1b[0m', fail: '\x1b[31m✗\x1b[0m' };

function die(msg) {
  console.error(`${fmt.fail} ${msg}`);
  process.exit(1);
}

/** Sign in over plain HTTP so the credentials never touch the browser. */
async function portalSessionCookie() {
  const email = process.env.PORTAL_DEMO_EMAIL;
  const password = process.env.PORTAL_DEMO_PASSWORD;
  if (!email || !password) {
    die('PORTAL_DEMO_EMAIL + PORTAL_DEMO_PASSWORD required (set -a; source .env; set +a)');
  }
  const res = await fetch(`${PORTAL}/signin`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email, password }).toString(),
    redirect: 'manual',
  });
  if (res.status !== 302) die(`portal sign-in returned ${res.status} (expected 302)`);
  // NB: the admin cookie is strawberry_portal_session (CLAUDE.md calls it
  // strawberry_session); strawberry_cardholder_session is the other one.
  const setCookie = res.headers.get('set-cookie') ?? '';
  const value = setCookie.match(/strawberry_portal_session=([^;]+)/)?.[1];
  if (!value) die('portal sign-in sent no strawberry_portal_session cookie');
  return { name: 'strawberry_portal_session', value, domain: 'localhost', path: '/' };
}

/** A fresh 3DS session so the ACS challenge page has something real to render. */
async function freshThreeDsChallengeUrl() {
  const signUp = await fetch(`${PORTAL}/sign-up`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ name: 'Glasshouse Studio', env: 'test' }).toString(),
  });
  const html = await signUp.text();
  const keys = [...html.matchAll(/<div class="key-box">([^<]+)<\/div>/g)].map((m) => m[1]);
  const pk = keys.find((k) => k.startsWith('pk_test_'));
  const sk = keys.find((k) => k.startsWith('sk_test_'));
  if (!pk || !sk) die('could not parse keys from sign-up for the 3DS capture');

  const headers = (key) => ({
    authorization: `Bearer ${key}`,
    'content-type': 'application/json',
    'idempotency-key': `shot_${Date.now()}_${Math.random().toString(36).slice(2)}`,
  });
  const tok = await (
    await fetch(`${API}/v1/tokens`, {
      method: 'POST',
      headers: headers(pk),
      body: JSON.stringify({ card: { number: '4000000000000010', exp_month: '12', exp_year: '2031', cvc: '123' } }),
    })
  ).json();
  const pm = await (
    await fetch(`${API}/v1/payment_methods`, {
      method: 'POST',
      headers: headers(sk),
      body: JSON.stringify({ type: 'card', card: { token: tok.id } }),
    })
  ).json();
  const pi = await (
    await fetch(`${API}/v1/payment_intents`, {
      method: 'POST',
      headers: headers(sk),
      body: JSON.stringify({ amount: 6400, currency: 'EUR', payment_method: pm.id, confirm: true }),
    })
  ).json();
  if (!pi.next_action?.redirect_url) die(`expected a 3DS redirect, got status ${pi.status}`);
  return { url: pi.next_action.redirect_url, pk, sk };
}

/** The richest trace Jaeger holds that spans api -> vault -> acquirer-host. */
async function bestTraceId() {
  const res = await fetch(`${JAEGER}/api/traces?service=api&operation=POST&limit=30`).catch(() => null);
  if (!res?.ok) return null;
  const { data } = await res.json();
  let best = null;
  for (const t of data ?? []) {
    const services = new Set(Object.values(t.processes ?? {}).map((p) => p.serviceName));
    const score = services.size * 1000 + (t.spans?.length ?? 0);
    if (!best || score > best.score) best = { score, id: t.traceID, services: [...services] };
  }
  return best;
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const cookie = await portalSessionCookie();
  const threeDs = await freshThreeDsChallengeUrl();
  const trace = await bestTraceId();

  const browser = await chromium.launch();
  // 1x: 1440px native is already more than GitHub renders a README image at,
  // and 2x pushed every PNG past the 300 KB budget.
  const ctx = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    colorScheme: 'light',
  });
  await ctx.addCookies([cookie]);
  const page = await ctx.newPage();

  /** Shoot one page: `selector` crops to an element, `clip` to a rectangle. */
  async function shoot(name, url, { selector, clip, fullPage = false, before } = {}) {
    await page.goto(url, { waitUntil: 'networkidle' });
    if (before) await before(page);
    const target = selector ? page.locator(selector).first() : page;
    await target.screenshot({
      path: join(OUT_DIR, `${name}.png`),
      ...(selector ? {} : { fullPage, ...(clip ? { clip } : {}) }),
    });
    console.log(`${fmt.ok} ${name}.png`);
  }

  // 1. Portal dashboard — the hero.
  await shoot('portal-dashboard', `${PORTAL}/dashboard`, { selector: 'body' });

  // 2. Merchants list — the only page that shows merchant names.
  await shoot('portal-merchants', `${PORTAL}/merchants`, { selector: 'body' });

  // 3. Payouts.
  await shoot('portal-payouts', `${PORTAL}/payouts`, { selector: 'body' });

  // 4. Disputes.
  await shoot('portal-disputes', `${PORTAL}/disputes`, { selector: 'body' });

  // 5. Card detail — issuing side: per-card ledger, controls, auth holds.
  const cardId = process.env.SHOT_CARD_ID;
  if (cardId) {
    await shoot('portal-card-detail', `${PORTAL}/cards/${cardId}`, { selector: 'body' });
  } else {
    console.log(`${fmt.warn} skipped portal-card-detail.png — set SHOT_CARD_ID`);
  }

  // 6. Hosted-fields checkout, paid for real with the typed card.
  await shoot('checkout-hosted-fields', `${CHECKOUT}/demo.html`, {
    selector: 'body',
    before: async (p) => {
      await p.fill('#pk', threeDs.pk);
      await p.fill('#sk', threeDs.sk);
      await p.fill('#amount', '4500');
      await p.fill('#currency', 'EUR');
      await p.click('#setup');
      const iframe = p.frameLocator('#card-element iframe');
      await iframe.locator('#number').fill('4242 4242 4242 4242');
      await iframe.locator('#exp').fill('12 / 2030');
      await p.click('#pay');
      await p.locator('#result').filter({ hasText: 'succeeded' }).waitFor({ timeout: 20_000 });
      // Nothing credential-shaped goes into a committed image: blank the key
      // boxes and mask the PaymentIntent's client_secret in the result JSON.
      await p.fill('#pk', 'pk_test_…');
      await p.fill('#sk', '••••••••••••••••');
      await p.evaluate(() => {
        const el = document.querySelector('#result');
        if (el) el.textContent = el.textContent.replace(/(_secret_)[^"]+/, '$1…');
      });
    },
  });

  // 7. The simulated ACS challenge page.
  await shoot('three-ds-challenge', threeDs.url, { selector: 'body' });

  // 8. One payment's trace. The scheme simulator is not instrumented, so the
  //    trace stops at acquirer-host.
  if (trace) {
    await shoot('jaeger-trace', `${JAEGER}/trace/${trace.id}`, {
      // Jaeger paints the span list in the top ~460px and leaves the rest of
      // the viewport blank; crop rather than ship the whitespace.
      clip: { x: 0, y: 0, width: VIEWPORT.width, height: 460 },
      before: async (p) => {
        await p.waitForTimeout(2500);
      },
    });
    console.log(`   trace ${trace.id} — services: ${trace.services.join(', ')}`);
  } else {
    console.log(`${fmt.warn} skipped jaeger-trace.png — Jaeger unreachable or has no traces`);
  }

  await browser.close();

  // Record what the captures were taken from, for the DONE doc.
  await writeFile(
    join(OUT_DIR, 'CAPTURED.txt'),
    `captured ${new Date().toISOString()} at ${VIEWPORT.width}x${VIEWPORT.height} @1x, light mode\n` +
      `trace: ${trace?.id ?? 'none'} (${trace?.services.join(', ') ?? '-'})\n`,
    'utf8',
  );
  console.log('\nwrote docs/images/');
}

main().catch((err) => die(`capture crashed: ${err?.stack ?? err}`));
