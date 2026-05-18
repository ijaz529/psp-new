/**
 * PCI redaction primitives. Two layers, both applied:
 *
 *   Layer 1 — Pino `redact` paths: field-name-based, exact paths and shallow wildcards.
 *             Cheap, deterministic, covers the "we know it lives at req.body.card.number".
 *
 *   Layer 2 — Recursive value scanner: walks every string in every log record and
 *             masks PAN-shaped numeric runs, regardless of what field they live in.
 *             Catches the "we logged the whole upstream response and a PAN was nested
 *             three layers deep in a field we didn't anticipate" case.
 *
 * Both layers run on every log call. Cost is ~1–5µs per record; we accept it.
 */

/**
 * Field paths that get [REDACTED] before serialization. Append-only.
 *
 * Pino's `*.foo` does NOT match a top-level `foo` field — it matches one level
 * deep. We list both forms explicitly so top-level and nested PCI fields are
 * both redacted by layer 1.
 */
const _PAN_FIELDS = [
  'pan',
  'PAN',
  'cardNumber',
  'card_number',
  'number',
  'primaryAccountNumber',
  'primary_account_number',
];
const _CVV_FIELDS = [
  'cvv',
  'cvc',
  'cvv2',
  'cvc2',
  'cardSecurityCode',
  'card_security_code',
  'securityCode',
  'security_code',
];
const _TRACK_FIELDS = [
  'track1',
  'track2',
  'track_1',
  'track_2',
  'track2Equivalent',
  'track_2_equivalent',
  'fullTrack',
  'full_track',
];
const _PIN_FIELDS = ['pin', 'pinBlock', 'pin_block'];
const _EXPIRY_FIELDS = [
  'expiry',
  'expirationDate',
  'expiration_date',
  'expiryYear',
  'expiry_year',
  'expMonth',
  'expYear',
];
const _SECRET_FIELDS = [
  'authorization',
  'apiKey',
  'api_key',
  'secretKey',
  'secret_key',
  'password',
  'privateKey',
  'private_key',
  'bearerToken',
  'bearer_token',
];

function bothForms(field: string): [string, string] {
  return [field, `*.${field}`];
}

export const PINO_REDACT_PATHS: ReadonlyArray<string> = [
  // Card primary account number — every variant we've seen
  ..._PAN_FIELDS.flatMap(bothForms),
  // CVV / CVC / CVV2 / CardSecurityCode
  ..._CVV_FIELDS.flatMap(bothForms),
  // Tracks (PCI category 1 data)
  ..._TRACK_FIELDS.flatMap(bothForms),
  // PIN / PIN block
  ..._PIN_FIELDS.flatMap(bothForms),
  // Expiry — combined with PAN this is PCI cardholder data
  ..._EXPIRY_FIELDS.flatMap(bothForms),
  // Auth headers + secrets (both top-level and nested in req.headers)
  ..._SECRET_FIELDS.flatMap(bothForms),
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
];

/**
 * Matches likely PAN runs in arbitrary text. A PAN is 12–19 digits, optionally
 * separated by single spaces or hyphens. We keep first 6 (BIN) + last 4 visible
 * to preserve debuggability, mask the middle.
 *
 * False positives: long numeric IDs, phone numbers ≥12 digits, order numbers.
 * Acceptable cost; for fields where we want full numerics we mark them so or
 * skip the scanner. The cost of a false-positive mask (debugging friction) is
 * far smaller than a true-negative (PAN in logs).
 */
const PAN_REGEX = /(?<![A-Za-z0-9])(\d[ -]?){11,18}\d(?![A-Za-z0-9])/g;

export function maskPanInString(input: string): string {
  return input.replace(PAN_REGEX, (match) => {
    const digits = match.replace(/[ -]/g, '');
    if (digits.length < 12 || digits.length > 19) return match;
    const bin = digits.slice(0, 6);
    const last4 = digits.slice(-4);
    return `${bin}******${last4}`;
  });
}

/**
 * Walk a log-record-shaped value (object / array / primitive) and rewrite every
 * string through {@link maskPanInString}. Mutates the input copy in place to
 * avoid an extra deep clone — Pino has already finished with the object.
 *
 * Cycles are protected via a WeakSet so a self-referential bindings object
 * doesn't loop forever.
 */
export function maskPanDeep(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return maskPanInString(value);
  if (typeof value !== 'object') return value;
  if (seen.has(value as object)) return value;
  seen.add(value as object);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) value[i] = maskPanDeep(value[i], seen);
    return value;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    (value as Record<string, unknown>)[k] = maskPanDeep(v, seen);
  }
  return value;
}

/**
 * Test helper. Stringifies the argument and throws if a 12–19 digit run that
 * looks like a real PAN survives.
 *
 * Heuristic:
 *   1. Find 12–19 digit runs enclosed by non-alphanumeric chars on BOTH sides
 *      (or string boundaries). This rejects ULID-like contexts where the digits
 *      are surrounded by base32 letters.
 *   2. Reject runs whose first digit is 0 (real PANs never start with 0).
 *   3. Reject runs that fail the Luhn check (real PANs always pass Luhn).
 *
 * False positives below this threshold (e.g. a 13-digit unix-ms timestamp that
 * happens to pass Luhn — vanishingly rare) are acceptable: the cost is a test
 * failure that turns out to be benign; the security cost of a missed PAN is
 * unbounded.
 */
export function assertNoPan(value: unknown, label = 'value'): void {
  const raw = JSON.stringify(value);
  if (raw === undefined) return;
  // Strip known timestamp-shaped numeric fields so Pino metadata (`time`,
  // `timestamp`, `created_at`, etc.) doesn't generate Luhn-collision false
  // positives. A real PAN in one of these fields would be a contract violation
  // upstream; we accept the trade-off.
  const json = raw.replace(/"(time|timestamp|created|updated|expires?_at|created_at|updated_at)"\s*:\s*\d+/g, '""');
  const re = /(?<![A-Za-z0-9])(\d[\s-]?){11,18}\d(?![A-Za-z0-9])/g;
  for (const m of json.matchAll(re)) {
    const digits = m[0].replace(/[\s-]/g, '');
    if (digits[0] === '0') continue;
    if (!passesLuhn(digits)) continue;
    throw new Error(`assertNoPan(${label}): found PAN-shaped run "${m[0]}" in: ${raw.slice(0, 500)}`);
  }
}

function passesLuhn(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    const ch = digits.charCodeAt(i) - 48;
    if (ch < 0 || ch > 9) return false;
    let d = ch;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}
