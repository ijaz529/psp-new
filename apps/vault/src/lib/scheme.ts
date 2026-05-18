import type { CardScheme } from '@psp-new/vault-client';

/**
 * Detect the card scheme from BIN. Keep in sync with
 * `@psp-new/vault-client#detectSchemeByBin`.
 */
export function detectScheme(pan: string): CardScheme {
  const d = pan.replace(/\D/g, '');
  if (d.length < 4) return 'unknown';
  if (d.startsWith('4')) return 'visa';
  if (/^5[1-5]/.test(d)) return 'mastercard';
  if (/^2(2[2-9]|[3-6]\d|7[01]|720)/.test(d)) return 'mastercard';
  if (/^3[47]/.test(d)) return 'amex';
  return 'unknown';
}
