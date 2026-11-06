import { expect, test } from '@playwright/test';

/**
 * Smoke test for the hosted-fields iframe. Requires a running compose stack
 * AND a pre-created merchant (use `pnpm merchant:create`). Pass the keys via
 * env: PK_TEST and SK_TEST.
 *
 * The test:
 *   1. Loads the demo page.
 *   2. Fills the credentials form.
 *   3. Mounts the hosted-fields iframe.
 *   4. Types a test PAN inside the iframe (cross-frame interaction).
 *   5. Clicks Pay.
 *   6. Asserts the result block shows either status: 'succeeded' or
 *      status: 'requires_action' (depending on which BIN was used).
 */
test.skip(!process.env.PK_TEST || !process.env.SK_TEST, 'PK_TEST + SK_TEST env required');

test('hosted-fields → /v1/tokens → payment_intent succeeded (no 3DS BIN)', async ({ page }) => {
  await page.goto('/demo.html');
  await page.fill('#pk', process.env.PK_TEST!);
  await page.fill('#sk', process.env.SK_TEST!);
  await page.click('#setup');

  // The iframe is now mounted inside #card-element.
  const iframe = page.frameLocator('#card-element iframe');
  await iframe.locator('#number').fill('4242 4242 4242 4242');
  await iframe.locator('#exp').fill('12 / 2030');

  await page.click('#pay');

  // Result panel must contain a JSON blob with status 'succeeded'.
  // BIN 424242 has no 3DS and sits outside the Strawberry issuing ranges, so
  // the simulator's stub issuer approves and capture happens synchronously.
  // (411111 was used here until Phase 45: since Phase 9 it routes to
  // issuer-host and declines unless such a card has actually been issued.)
  await expect(page.locator('#result')).toContainText(/"status"\s*:\s*"succeeded"/);
});
