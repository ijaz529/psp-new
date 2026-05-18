/**
 * ISO 8583:1987 field specification (ASCII variant per ADR-0016).
 *
 *   - `n`   fixed-length numeric
 *   - `an`  fixed-length alphanumeric
 *   - `ans` fixed-length printable
 *   - `z`   track data (digits + 'D' separator)
 *   - `b`   binary, encoded on the wire as hex (each byte → 2 ASCII chars)
 *   - LL    2-digit ASCII length prefix
 *   - LLL   3-digit ASCII length prefix
 *
 * Length field for VAR types is the COUNT OF CHARACTERS in the encoded
 * representation (not bytes-before-hex). So a binary 8-byte block in LLLVAR
 * encodes as `016xxxxxxxxxxxxxxxx` (16 hex chars).
 */
export type FieldType = 'n' | 'an' | 'ans' | 'z' | 'b';
export type LengthKind = 'FIXED' | 'LLVAR' | 'LLLVAR';

export interface FieldSpec {
  /** Data element number (1-128). */
  readonly de: number;
  readonly kind: LengthKind;
  readonly type: FieldType;
  /** Fixed length, or maximum length for VAR fields. In characters. */
  readonly length: number;
  /** Human label for debugging / logs. */
  readonly name: string;
}

/**
 * The DEs we use in the auth flow (Phase 5). PROJECT_BRIEF.md §3 Phase 5
 * listed the full set; we ship a subset and add others as they become needed.
 */
export const FIELDS_8583: ReadonlyMap<number, FieldSpec> = new Map<number, FieldSpec>([
  [2, { de: 2, kind: 'LLVAR', type: 'n', length: 19, name: 'Primary Account Number' }],
  [3, { de: 3, kind: 'FIXED', type: 'n', length: 6, name: 'Processing Code' }],
  [4, { de: 4, kind: 'FIXED', type: 'n', length: 12, name: 'Amount, Transaction' }],
  [7, { de: 7, kind: 'FIXED', type: 'n', length: 10, name: 'Transmission Date and Time' }],
  [11, { de: 11, kind: 'FIXED', type: 'n', length: 6, name: 'STAN' }],
  [12, { de: 12, kind: 'FIXED', type: 'n', length: 6, name: 'Time, Local Transaction' }],
  [13, { de: 13, kind: 'FIXED', type: 'n', length: 4, name: 'Date, Local Transaction' }],
  [14, { de: 14, kind: 'FIXED', type: 'n', length: 4, name: 'Date, Expiration' }],
  [22, { de: 22, kind: 'FIXED', type: 'n', length: 3, name: 'POS Entry Mode' }],
  [32, { de: 32, kind: 'LLVAR', type: 'n', length: 11, name: 'Acquiring Institution ID' }],
  [35, { de: 35, kind: 'LLVAR', type: 'z', length: 37, name: 'Track 2 Data' }],
  [37, { de: 37, kind: 'FIXED', type: 'an', length: 12, name: 'Retrieval Reference Number' }],
  [38, { de: 38, kind: 'FIXED', type: 'an', length: 6, name: 'Authorization Identification Response' }],
  [39, { de: 39, kind: 'FIXED', type: 'an', length: 2, name: 'Response Code' }],
  [41, { de: 41, kind: 'FIXED', type: 'ans', length: 8, name: 'Card Acceptor Terminal ID' }],
  [42, { de: 42, kind: 'FIXED', type: 'ans', length: 15, name: 'Card Acceptor ID Code' }],
  [49, { de: 49, kind: 'FIXED', type: 'n', length: 3, name: 'Currency Code, Transaction' }],
  [52, { de: 52, kind: 'FIXED', type: 'b', length: 16, name: 'PIN Data' }],
  [55, { de: 55, kind: 'LLLVAR', type: 'b', length: 510, name: 'ICC Data (EMV TLV)' }],
  [62, { de: 62, kind: 'LLLVAR', type: 'ans', length: 999, name: 'Private 62' }],
  [63, { de: 63, kind: 'LLLVAR', type: 'ans', length: 999, name: 'Private 63' }],
  [90, { de: 90, kind: 'FIXED', type: 'n', length: 42, name: 'Original Data Elements' }],
  [102, { de: 102, kind: 'LLVAR', type: 'ans', length: 28, name: 'Account Identification 1' }],
  [103, { de: 103, kind: 'LLVAR', type: 'ans', length: 28, name: 'Account Identification 2' }],
]);

export function fieldSpec(de: number): FieldSpec {
  const s = FIELDS_8583.get(de);
  if (!s) throw new Error(`ISO 8583: no spec for DE ${de}`);
  return s;
}
