/**
 * 3DS policy decision — pure function. Decides whether to require 3DS and
 * whether to use the challenge or frictionless flow.
 *
 * Phase 4 inputs:
 *   - bin (first 6 of the PAN, public)
 *   - scheme
 *   - request_three_d_secure: 'automatic' | 'any' | 'never' (merchant request)
 *
 * Decision matrix for Phase 4 (test BINs):
 *   - request='never' → no 3DS
 *   - request='any'   → 3DS challenge (force)
 *   - request='automatic':
 *       BIN 400000 (Visa 3DS test) → 3DS challenge
 *       BIN 555555 (MC 3DS test)   → 3DS frictionless (auto-approve)
 *       everything else            → no 3DS
 *
 * Phase 7 risk engine will replace this with real rules.
 */
export type ThreeDsRequest = 'automatic' | 'any' | 'never';

export interface ThreeDsDecision {
  readonly required: boolean;
  readonly mode: 'none' | 'frictionless' | 'challenge';
}

export function decideThreeDs(opts: {
  readonly bin: string;
  readonly scheme: string;
  readonly requestThreeDSecure: ThreeDsRequest;
}): ThreeDsDecision {
  if (opts.requestThreeDSecure === 'never') return { required: false, mode: 'none' };
  if (opts.requestThreeDSecure === 'any') return { required: true, mode: 'challenge' };

  // Automatic — Phase 4 demo policy by BIN.
  if (opts.bin === '400000') return { required: true, mode: 'challenge' };
  if (opts.bin === '555555') return { required: true, mode: 'frictionless' };
  return { required: false, mode: 'none' };
}

/**
 * ECI / CAVV / transStatus emitted by the (simulated) ACS at 3DS completion.
 * Returned for both frictionless and challenge flows.
 */
export interface ThreeDsResult {
  readonly success: boolean;
  readonly transStatus: 'Y' | 'A' | 'N' | 'U' | 'R' | 'C';
  readonly eci: string;
  readonly cavv: string | null;
}

/**
 * Produce a synthetic 3DS result. Used by the frictionless flow inside the
 * orchestrator and by the simulator after the customer clicks Approve/Decline.
 *
 * ECI codes per scheme:
 *   - Visa:        05 (Y, fully authenticated), 06 (A, attempted), 07 (N, not auth)
 *   - Mastercard:  02 (Y), 01 (A), 00 (N)
 */
export function makeThreeDsResult(opts: {
  readonly scheme: string;
  readonly outcome: 'approve' | 'decline' | 'attempted';
}): ThreeDsResult {
  const isVisa = opts.scheme === 'visa';
  if (opts.outcome === 'approve') {
    return {
      success: true,
      transStatus: 'Y',
      eci: isVisa ? '05' : '02',
      cavv: synthCavv(),
    };
  }
  if (opts.outcome === 'attempted') {
    return {
      success: true, // attempted is treated as success for liability shift purposes
      transStatus: 'A',
      eci: isVisa ? '06' : '01',
      cavv: synthCavv(),
    };
  }
  return {
    success: false,
    transStatus: 'N',
    eci: isVisa ? '07' : '00',
    cavv: null,
  };
}

function synthCavv(): string {
  // Synthetic 20-byte base64 CAVV. Real CAVV is issued by the ACS.
  // For the simulator we just generate something stable-looking.
  const bytes = new Uint8Array(20);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Buffer.from(bytes).toString('base64');
}
