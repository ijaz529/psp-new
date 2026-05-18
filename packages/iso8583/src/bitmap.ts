/**
 * ISO 8583 bitmap (primary 64 bits + optional secondary 64 bits).
 *
 * ASCII variant: each 4 bits → 1 hex char. 64-bit primary = 16 hex chars.
 * Bit 1 of the primary bitmap signals presence of the secondary bitmap.
 * Bit numbering is 1-based (DE 1 is the secondary-bitmap-present flag).
 */

const PRIMARY_HEX_LEN = 16;
const SECONDARY_HEX_LEN = 16;

export interface BitmapDecodeResult {
  /** DEs present (numeric, 2..128 inclusive). Always sorted ascending. */
  readonly present: ReadonlyArray<number>;
  /** Number of hex characters consumed (16 or 32). */
  readonly hexLen: number;
}

export function encodeBitmap(present: Iterable<number>): string {
  const bits = new Uint8Array(16); // 128 bits / 8 = 16 bytes
  let needsSecondary = false;
  for (const de of present) {
    if (de < 2 || de > 128) throw new RangeError(`DE ${de} out of range`);
    if (de > 64) needsSecondary = true;
    setBit(bits, de);
  }
  if (needsSecondary) setBit(bits, 1);
  const hexLen = needsSecondary ? 32 : 16;
  return hex(bits).slice(0, hexLen).toUpperCase();
}

export function decodeBitmap(input: string, offset = 0): BitmapDecodeResult {
  if (input.length < offset + PRIMARY_HEX_LEN) {
    throw new Error('ISO 8583: input too short for primary bitmap');
  }
  const primary = input.slice(offset, offset + PRIMARY_HEX_LEN);
  const primaryBits = unhex(primary);
  let hexLen = PRIMARY_HEX_LEN;

  let secondaryBits: Uint8Array | null = null;
  if (getBit(primaryBits, 1)) {
    if (input.length < offset + PRIMARY_HEX_LEN + SECONDARY_HEX_LEN) {
      throw new Error('ISO 8583: input too short for secondary bitmap');
    }
    const secondary = input.slice(offset + PRIMARY_HEX_LEN, offset + PRIMARY_HEX_LEN + SECONDARY_HEX_LEN);
    secondaryBits = unhex(secondary);
    hexLen += SECONDARY_HEX_LEN;
  }

  const present: number[] = [];
  for (let de = 2; de <= 64; de++) if (getBit(primaryBits, de)) present.push(de);
  if (secondaryBits) {
    for (let de = 65; de <= 128; de++) if (getBitSecondary(secondaryBits, de)) present.push(de);
  }
  return { present, hexLen };
}

// --- bit manipulation -------------------------------------------------------

function setBit(buf: Uint8Array, bitOneIndexed: number): void {
  // bit 1 = MSB of byte 0 = byte 0, bit 7
  const byte = (bitOneIndexed - 1) >> 3;
  const bit = 7 - ((bitOneIndexed - 1) & 7);
  buf[byte] = (buf[byte] ?? 0) | (1 << bit);
}

function getBit(buf: Uint8Array, bitOneIndexed: number): boolean {
  const byte = (bitOneIndexed - 1) >> 3;
  const bit = 7 - ((bitOneIndexed - 1) & 7);
  return ((buf[byte] ?? 0) & (1 << bit)) !== 0;
}

function getBitSecondary(buf: Uint8Array, bitOneIndexed: number): boolean {
  // Secondary covers DEs 65..128; bit 65 is the MSB of byte 0 of the secondary.
  return getBit(buf, bitOneIndexed - 64);
}

function hex(buf: Uint8Array): string {
  let s = '';
  for (const b of buf) s += b.toString(16).padStart(2, '0');
  return s;
}

function unhex(s: string): Uint8Array {
  if (s.length % 2 !== 0) throw new Error('hex string odd length');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error(`invalid hex char near offset ${i * 2}`);
    out[i] = byte;
  }
  return out;
}
