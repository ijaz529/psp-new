import { type Iso8583Message, buildMessage, decode, encode } from '@psp-new/iso8583';
import type { IssuerClient } from './issuer-client.js';

/**
 * Simulated issuer policy by BIN range. Phase 5 ships a small set of test
 * BINs so the demo + CI can exercise approve, decline, soft-decline, etc.
 *
 * Mapping (Phase 5):
 *   - PAN starts with 411111 → approve (RC 00)
 *   - PAN starts with 400000 → 3DS challenge BIN; if no 3DS data carried,
 *                              issuer would decline 1A (soft, step-up).
 *                              In our flow the api already finished 3DS before
 *                              calling, so we approve here.
 *   - PAN starts with 555555 → approve (Mastercard frictionless 3DS test)
 *   - PAN starts with 400000000000999 → decline RC 51 (insufficient funds)
 *   - PAN starts with 400000000000003 → decline RC 05 (do not honor)
 *   - PAN starts with 400000000000006 → decline RC 54 (expired card)
 *   - default → approve (good citizen)
 *
 * Phase 9 adds BIN-routing: if the PAN's first 9 digits fall within a
 * configured Strawberry-issuing range, forward the request to issuer-host
 * (which runs the real authorization-control engine + ledger). Otherwise the
 * existing always-approve / decline-by-BIN stub above answers itself.
 */

const DECLINE_SUFFIX_MAP: ReadonlyArray<{ pan: string; rc: string }> = [
  { pan: '4000000000000999', rc: '51' },
  { pan: '4000000000000003', rc: '05' },
  { pan: '4000000000000006', rc: '54' },
];

export function decideResponseCode(pan: string): string {
  for (const m of DECLINE_SUFFIX_MAP) if (pan === m.pan) return m.rc;
  return '00';
}

export interface BinRange {
  readonly low: string; // 9-digit
  readonly high: string; // 9-digit
}

export interface IssuerRouterDeps {
  /** Ranges that should be forwarded to issuer-host. Empty = always self-handle. */
  readonly strawberryRanges: ReadonlyArray<BinRange>;
  /** Forwarding client, present only when strawberryRanges is non-empty. */
  readonly issuerClient: IssuerClient | null;
}

/** True if PAN's first 9 digits fall inside any Strawberry-issuing BIN range. */
export function panInStrawberryRange(pan: string, ranges: ReadonlyArray<BinRange>): boolean {
  if (pan.length < 9) return false;
  const prefix = pan.slice(0, 9);
  for (const r of ranges) {
    if (prefix >= r.low && prefix <= r.high) return true;
  }
  return false;
}

/** MTIs routed by this simulator. Auth pair from Phase 5/9, capture+reversal from Phase 10. */
const ROUTED_REQUEST_MTIS = new Set<string>(['0100', '0200', '0220', '0420']);

/** Default response MTI for each routed request (when the simulator self-handles). */
const RESPONSE_MTI: Readonly<Record<string, Iso8583Message['mti']>> = {
  '0100': '0110',
  '0200': '0210',
  '0220': '0230',
  '0420': '0430',
};

export async function handleAuthRequest(reqBytes: string, deps: IssuerRouterDeps): Promise<string> {
  const req = decode(reqBytes);
  if (!ROUTED_REQUEST_MTIS.has(req.mti)) {
    return encode(buildMessage('0110', { 39: '96' }));
  }
  const pan = (req.fields.get(2) as string | undefined) ?? '';

  // Phase 9 BIN routing. Phase 10 widens to 0220/0420 — the acquirer-host
  // includes DE 2 PAN on capture/reversal so the same router rule applies.
  if (deps.issuerClient && panInStrawberryRange(pan, deps.strawberryRanges)) {
    return deps.issuerClient.send(reqBytes);
  }

  // Stub issuer self-response. For 0220/0420 against external (non-Strawberry)
  // cards we auto-ack RC 00 — no tracked state on this side.
  const respMti = RESPONSE_MTI[req.mti] ?? '0110';
  const rc = req.mti === '0100' || req.mti === '0200' ? decideResponseCode(pan) : '00';

  const fields: Record<number, string> = {
    3: (req.fields.get(3) as string | undefined) ?? '000000',
    4: (req.fields.get(4) as string | undefined) ?? '000000000000',
    7: (req.fields.get(7) as string | undefined) ?? '0101000000',
    11: (req.fields.get(11) as string | undefined) ?? '000000',
    37: (req.fields.get(37) as string | undefined) ?? '000000000000',
    39: rc,
    49: (req.fields.get(49) as string | undefined) ?? '840',
  };
  if (rc === '00' && (req.mti === '0100' || req.mti === '0200')) {
    fields[38] = `APPR${((req.fields.get(11) as string | undefined) ?? '0').slice(-2)}`.slice(0, 6).padEnd(6, ' ');
  }
  return encode(buildMessage(respMti, fields));
}

/**
 * Parse the env var `STRAWBERRY_BIN_RANGES` into a list of 9-digit BIN ranges.
 * Format: "low-high,low-high" e.g. "411111000-411111999,555555000-555555999".
 * Returns an empty array if unset.
 */
export function parseBinRanges(spec: string | undefined): BinRange[] {
  if (!spec) return [];
  const out: BinRange[] = [];
  for (const part of spec.split(',')) {
    const [low, high] = part.split('-').map((s) => s.trim());
    if (!low || !high || low.length !== 9 || high.length !== 9) {
      throw new Error(`bad BIN range "${part}" — expected "<9 digits>-<9 digits>"`);
    }
    out.push({ low, high });
  }
  return out;
}
