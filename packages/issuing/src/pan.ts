import { randomInt } from 'node:crypto';

/**
 * PAN generation for issued cards.
 *
 * A PAN is 16 digits laid out as:
 *   - BIN portion: first 6 digits (scheme + issuer identifier)
 *   - Account portion: next 9 digits (issuer's account-id space)
 *   - Check digit: last digit, Luhn over the 15 preceding
 *
 * Phase 9 products store the first 9 digits as a range
 * (`bin_range_low`..`bin_range_high`) so a product can address up to
 * 1,000 accounts in its slice without overlapping its neighbours.
 *
 * `generatePan({ rangeLow: '411111000', rangeHigh: '411111999' })` returns
 * something like '4111110001234565' where:
 *   - 411111  is the standard 6-digit BIN ("BIN portion")
 *   - 000…999 is picked uniformly at random from the range ("prefix slice")
 *   - 123456  is a uniformly-random 6-digit account suffix
 *   - 5       is the Luhn check digit
 */

export interface GeneratePanInput {
  /** Inclusive lower bound on the first 9 digits, e.g. '411111000'. */
  readonly rangeLow: string;
  /** Inclusive upper bound on the first 9 digits, e.g. '411111999'. */
  readonly rangeHigh: string;
}

const PREFIX_LENGTH = 9;

export function generatePan({ rangeLow, rangeHigh }: GeneratePanInput): string {
  if (rangeLow.length !== PREFIX_LENGTH || rangeHigh.length !== PREFIX_LENGTH) {
    throw new Error(`PAN range bounds must be ${PREFIX_LENGTH} digits`);
  }
  const low = Number.parseInt(rangeLow, 10);
  const high = Number.parseInt(rangeHigh, 10);
  if (!Number.isFinite(low) || !Number.isFinite(high) || low > high) {
    throw new Error('Invalid PAN range');
  }

  // Pick a 9-digit prefix uniformly in [low, high]. randomInt's max is exclusive.
  const prefixNum = randomInt(low, high + 1);
  const prefix = prefixNum.toString().padStart(PREFIX_LENGTH, '0');

  // 6-digit random account suffix → 15 digits total before the check digit.
  const accountSuffix = randomInt(0, 1_000_000).toString().padStart(6, '0');

  const preCheck = prefix + accountSuffix;
  const checkDigit = luhnCheckDigit(preCheck);
  return preCheck + checkDigit;
}

/** Compute the Luhn check digit for an N-digit number (string of digits). */
export function luhnCheckDigit(digits: string): string {
  // Walking right-to-left from the position before the check digit, double
  // every second digit (the rightmost-before-check is doubled). Subtract 9
  // if the doubled value exceeds 9. Sum everything. The check digit makes
  // the grand total a multiple of 10.
  let sum = 0;
  for (let i = digits.length - 1, alt = true; i >= 0; i--, alt = !alt) {
    let v = digits.charCodeAt(i) - 48;
    if (alt) {
      v *= 2;
      if (v > 9) v -= 9;
    }
    sum += v;
  }
  const check = (10 - (sum % 10)) % 10;
  return check.toString();
}

export function isValidLuhn(pan: string): boolean {
  if (!/^\d+$/.test(pan) || pan.length < 2) return false;
  const body = pan.slice(0, -1);
  const expected = luhnCheckDigit(body);
  return expected === pan.slice(-1);
}

/** Whether a candidate PAN falls inside a product's BIN range. */
export function panInRange(pan: string, rangeLow: string, rangeHigh: string): boolean {
  if (pan.length < PREFIX_LENGTH) return false;
  const prefix = pan.slice(0, PREFIX_LENGTH);
  return prefix >= rangeLow && prefix <= rangeHigh;
}
