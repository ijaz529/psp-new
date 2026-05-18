import { type Iso8583Message, buildMessage, decode, encode } from '@psp-new/iso8583';

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

export function handleAuthRequest(reqBytes: string): string {
  const req = decode(reqBytes);
  if (req.mti !== '0100' && req.mti !== '0200') {
    // unsupported — respond network management error
    return encode(buildMessage('0110', { 39: '96' }));
  }
  const pan = (req.fields.get(2) as string | undefined) ?? '';
  const rc = decideResponseCode(pan);
  const respMti: Iso8583Message['mti'] = req.mti === '0200' ? '0210' : '0110';

  const fields: Record<number, string> = {
    3: (req.fields.get(3) as string | undefined) ?? '000000',
    4: (req.fields.get(4) as string | undefined) ?? '000000000000',
    7: (req.fields.get(7) as string | undefined) ?? '0101000000',
    11: (req.fields.get(11) as string | undefined) ?? '000000',
    37: (req.fields.get(37) as string | undefined) ?? '000000000000',
    39: rc,
    49: (req.fields.get(49) as string | undefined) ?? '840',
  };
  if (rc === '00') {
    fields[38] = `APPR${((req.fields.get(11) as string | undefined) ?? '0').slice(-2)}`.slice(0, 6).padEnd(6, ' ');
  }
  return encode(buildMessage(respMti, fields));
}
