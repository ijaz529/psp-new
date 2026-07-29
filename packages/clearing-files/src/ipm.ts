/**
 * Phase 29 — Mastercard IPM (ISO 8583-shaped) clearing format.
 *
 * Faithful approximation of Mastercard IPM:
 *   - ISO 8583 Message Type Indicator (MTI) per record.
 *   - Primary + secondary bitmaps as ASCII hex (real IPM uses packed
 *     binary; we keep ASCII for file inspectability — same trade-off
 *     Phase 28 made for Base II).
 *   - Numbered Data Elements (DEs) with their proper ISO 8583
 *     variable-length prefixes (LLVAR / LLLVAR) and fixed-width
 *     numeric padding.
 *
 * MTIs wired: 1240 (first presentment, this phase) and 1442 (chargeback,
 * Phase 37). Adding a 1240 reversal would be additive — bitmap layout +
 * per-DE encoding is data-driven.
 *
 * Records are \n-separated for inspectability. Real IPM is 1644-byte
 * fixed blocks; we keep the field-level fidelity instead.
 */

import type { ClearingTransaction } from './index.js';

const MTI_FIRST_PRESENTMENT = '1240';
// Phase 37: chargeback. Same DE set as 1240; trailer totals stay gross
// (sum of all record amounts) — an integrity check, not a net.
const MTI_CHARGEBACK = '1442';

const ISO_NUMERIC_BY_ALPHA: Record<string, string> = {
  USD: '840',
  EUR: '978',
  GBP: '826',
  AED: '784',
  INR: '356',
};
const ISO_ALPHA_BY_NUMERIC: Record<string, string> = Object.fromEntries(
  Object.entries(ISO_NUMERIC_BY_ALPHA).map(([alpha, num]) => [num, alpha]),
);

/**
 * The DEs we use. `kind` follows ISO 8583 terminology:
 *   - 'n' fixed-length numeric, zero-padded ASCII (`len` bytes)
 *   - 'an' fixed-length alphanumeric
 *   - 'LLVAR' / 'LLLVAR' variable-length, `len` = max
 */
interface DeSpec {
  readonly de: number;
  readonly name: string;
  readonly kind: 'n' | 'an' | 'LLVAR-an' | 'LLLVAR-ans';
  readonly len: number;
}

const DE_SPECS: ReadonlyArray<DeSpec> = [
  { de: 4, name: 'transaction_amount', kind: 'n', len: 12 },
  { de: 12, name: 'local_transaction_datetime', kind: 'n', len: 12 }, // YYMMDDhhmmss
  { de: 31, name: 'acquirer_reference_data', kind: 'LLVAR-an', len: 23 },
  { de: 49, name: 'transaction_currency_code', kind: 'n', len: 3 },
  { de: 100, name: 'receiving_institution_id', kind: 'LLVAR-an', len: 11 },
  { de: 105, name: 'reserved_private', kind: 'LLLVAR-ans', len: 999 },
];

const USED_DE_NUMBERS = DE_SPECS.map((s) => s.de);

export interface BuildIpmOpts {
  readonly fileId?: string;
  readonly fileDate?: Date;
}

export function buildMastercardIpm(txs: ReadonlyArray<ClearingTransaction>, opts: BuildIpmOpts = {}): string {
  const fileDate = opts.fileDate ?? txs[0]?.occurredAt ?? new Date();
  const fileId = opts.fileId ?? `IPM-${formatDateYYYYMMDD(fileDate)}`;
  const lines: string[] = [];
  lines.push(`HDR${fileId.padEnd(20, ' ')}${formatDateYYYYMMDD(fileDate)}`);
  for (const tx of txs) {
    lines.push(buildMessage(tx));
  }
  const totalAmount = txs.reduce((acc, t) => acc + t.amount, 0n);
  lines.push(`TRL${padLeftZero(txs.length.toString(), 10)}${padLeftZero(totalAmount.toString(), 18)}`);
  return `${lines.join('\n')}\n`;
}

export interface ParsedIpm {
  readonly header: { fileId: string; fileDate: Date };
  readonly transactions: ClearingTransaction[];
}

export function parseMastercardIpm(contents: string): ParsedIpm {
  const lines = contents.split('\n').filter((l) => l.length > 0);
  if (lines.length < 2) {
    throw new Error('ipm: file must contain at least a header and a trailer');
  }
  const headerLine = lines[0] as string;
  const trailerLine = lines[lines.length - 1] as string;
  const detailLines = lines.slice(1, -1);

  const header = parseHeader(headerLine);
  const trailer = parseTrailer(trailerLine);

  const transactions = detailLines.map((line, i) => parseMessage(line, i + 2));

  if (transactions.length !== trailer.recordCount) {
    throw new Error(
      `ipm: trailer record_count ${trailer.recordCount} does not match detail count ${transactions.length}`,
    );
  }
  const sum = transactions.reduce((acc, t) => acc + t.amount, 0n);
  if (sum !== trailer.totalAmount) {
    throw new Error(`ipm: trailer total_amount ${trailer.totalAmount} does not match detail sum ${sum}`);
  }

  return { header, transactions };
}

/* ---------- message builder/parser --------------------------------------- */

function buildMessage(tx: ClearingTransaction): string {
  const currency = ISO_NUMERIC_BY_ALPHA[tx.currency];
  if (!currency) {
    throw new Error(`ipm: unsupported currency ${tx.currency} (no ISO 4217 numeric mapping)`);
  }
  const de4 = padLeftZero(tx.amount.toString(), 12);
  const de12 = formatDateYYMMDDhhmmss(tx.occurredAt);
  const de31 = tx.rrn;
  const de49 = currency;
  const de100 = tx.scheme === 'mastercard' ? '540' : tx.scheme === 'visa' ? '400' : '999';
  const de105 = `${tx.merchantId}|${tx.paymentIntentId}`;

  const bitmap = bitmapForDes(USED_DE_NUMBERS);
  const parts = [tx.kind === 'chargeback' ? MTI_CHARGEBACK : MTI_FIRST_PRESENTMENT, bitmap];
  for (const spec of DE_SPECS) {
    parts.push(encodeDE(spec, deValue(spec.de, { de4, de12, de31, de49, de100, de105 })));
  }
  return parts.join('');
}

function deValue(
  de: number,
  v: { de4: string; de12: string; de31: string; de49: string; de100: string; de105: string },
): string {
  switch (de) {
    case 4:
      return v.de4;
    case 12:
      return v.de12;
    case 31:
      return v.de31;
    case 49:
      return v.de49;
    case 100:
      return v.de100;
    case 105:
      return v.de105;
    default:
      throw new Error(`ipm: no encoder for DE ${de}`);
  }
}

function parseMessage(line: string, recordNumber: number): ClearingTransaction {
  let pos = 0;
  const mti = line.slice(pos, pos + 4);
  pos += 4;
  if (mti !== MTI_FIRST_PRESENTMENT && mti !== MTI_CHARGEBACK) {
    throw new Error(`ipm: record ${recordNumber} expected MTI ${MTI_FIRST_PRESENTMENT}|${MTI_CHARGEBACK}, got ${mti}`);
  }
  // 32 hex chars: 16 primary + 16 secondary (we always emit both for our DE set).
  const bitmapHex = line.slice(pos, pos + 32);
  pos += 32;
  const presentDes = desFromBitmap(bitmapHex);
  // Sanity: the present-DE set must equal what we know how to parse.
  const expected = new Set(USED_DE_NUMBERS);
  const got = new Set(presentDes.filter((d) => d !== 1)); // bit 1 is "secondary present", not a real DE
  if (expected.size !== got.size || [...expected].some((d) => !got.has(d))) {
    throw new Error(
      `ipm: record ${recordNumber} bitmap declares DEs ${[...got].sort().join(',')}, expected ${[...expected].sort().join(',')}`,
    );
  }

  const values = new Map<number, string>();
  for (const spec of DE_SPECS) {
    const { value, consumed } = decodeDE(spec, line, pos);
    values.set(spec.de, value);
    pos += consumed;
  }

  const currencyAlpha = ISO_ALPHA_BY_NUMERIC[values.get(49) as string];
  if (!currencyAlpha) {
    throw new Error(`ipm: record ${recordNumber} unknown ISO 4217 numeric ${values.get(49)}`);
  }
  const schemeCode = values.get(100);
  const scheme: 'visa' | 'mastercard' | 'amex' =
    schemeCode === '540' ? 'mastercard' : schemeCode === '400' ? 'visa' : 'amex';
  const de105Raw = values.get(105) as string;
  const sep = de105Raw.indexOf('|');
  if (sep === -1) {
    throw new Error(`ipm: record ${recordNumber} DE 105 missing pipe separator`);
  }
  return {
    paymentIntentId: de105Raw.slice(sep + 1),
    merchantId: de105Raw.slice(0, sep),
    scheme,
    currency: currencyAlpha,
    amount: BigInt(values.get(4) as string),
    rrn: values.get(31) as string,
    occurredAt: parseDateYYMMDDhhmmss(values.get(12) as string),
    ...(mti === MTI_CHARGEBACK ? { kind: 'chargeback' as const } : {}),
  };
}

/* ---------- bitmap ------------------------------------------------------- */

function bitmapForDes(deNumbers: ReadonlyArray<number>): string {
  const primary = new Uint8Array(8);
  const secondary = new Uint8Array(8);
  const hasSecondary = deNumbers.some((d) => d > 64);
  if (hasSecondary) {
    setBit(primary, 1); // bit 1 = secondary bitmap present
  }
  for (const d of deNumbers) {
    if (d <= 64) setBit(primary, d);
    else setBit(secondary, d - 64);
  }
  return toHex(primary) + (hasSecondary ? toHex(secondary) : '');
}

function desFromBitmap(hex: string): number[] {
  if (hex.length < 16) {
    throw new Error(`ipm: bitmap too short (got ${hex.length} hex chars, need ≥16)`);
  }
  const primary = fromHex(hex.slice(0, 16));
  const out: number[] = [];
  for (let i = 1; i <= 64; i++) {
    if (testBit(primary, i)) out.push(i);
  }
  if (out.includes(1)) {
    if (hex.length < 32) {
      throw new Error('ipm: bitmap signals secondary present but only 16 hex chars provided');
    }
    const secondary = fromHex(hex.slice(16, 32));
    for (let i = 1; i <= 64; i++) {
      if (testBit(secondary, i)) out.push(64 + i);
    }
  }
  return out;
}

function setBit(buf: Uint8Array, bit1Based: number): void {
  const byteIdx = Math.floor((bit1Based - 1) / 8);
  const bitInByte = (bit1Based - 1) % 8; // 0 = MSB
  buf[byteIdx] = ((buf[byteIdx] as number) | (0x80 >> bitInByte)) & 0xff;
}

function testBit(buf: Uint8Array, bit1Based: number): boolean {
  const byteIdx = Math.floor((bit1Based - 1) / 8);
  const bitInByte = (bit1Based - 1) % 8;
  return ((buf[byteIdx] as number) & (0x80 >> bitInByte)) !== 0;
}

function toHex(buf: Uint8Array): string {
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
}

function fromHex(hex: string): Uint8Array {
  const buf = new Uint8Array(hex.length / 2);
  for (let i = 0; i < buf.length; i++) {
    buf[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return buf;
}

/* ---------- per-DE encoder / decoder ------------------------------------- */

function encodeDE(spec: DeSpec, value: string): string {
  switch (spec.kind) {
    case 'n':
      return padLeftZero(value, spec.len);
    case 'an':
      return value.padEnd(spec.len, ' ').slice(0, spec.len);
    case 'LLVAR-an': {
      if (value.length > spec.len) throw new Error(`ipm: DE ${spec.de} value too long (${value.length} > ${spec.len})`);
      return padLeftZero(value.length.toString(), 2) + value;
    }
    case 'LLLVAR-ans': {
      if (value.length > spec.len) throw new Error(`ipm: DE ${spec.de} value too long (${value.length} > ${spec.len})`);
      return padLeftZero(value.length.toString(), 3) + value;
    }
  }
}

function decodeDE(spec: DeSpec, line: string, pos: number): { value: string; consumed: number } {
  switch (spec.kind) {
    case 'n':
    case 'an':
      return { value: line.slice(pos, pos + spec.len), consumed: spec.len };
    case 'LLVAR-an': {
      const len = Number.parseInt(line.slice(pos, pos + 2), 10);
      return { value: line.slice(pos + 2, pos + 2 + len), consumed: 2 + len };
    }
    case 'LLLVAR-ans': {
      const len = Number.parseInt(line.slice(pos, pos + 3), 10);
      return { value: line.slice(pos + 3, pos + 3 + len), consumed: 3 + len };
    }
  }
}

/* ---------- header / trailer --------------------------------------------- */

function parseHeader(line: string): { fileId: string; fileDate: Date } {
  if (!line.startsWith('HDR')) {
    throw new Error(`ipm: header expected HDR prefix, got ${line.slice(0, 3)}`);
  }
  const fileId = line.slice(3, 23).trimEnd();
  const fileDate = parseDateYYYYMMDD(line.slice(23, 31));
  return { fileId, fileDate };
}

function parseTrailer(line: string): { recordCount: number; totalAmount: bigint } {
  if (!line.startsWith('TRL')) {
    throw new Error(`ipm: trailer expected TRL prefix, got ${line.slice(0, 3)}`);
  }
  return {
    recordCount: Number.parseInt(line.slice(3, 13), 10),
    totalAmount: BigInt(line.slice(13, 31)),
  };
}

/* ---------- low-level helpers -------------------------------------------- */

function padLeftZero(s: string, len: number): string {
  return s.length >= len ? s.slice(-len) : s.padStart(len, '0');
}

function formatDateYYYYMMDD(d: Date): string {
  const y = d.getUTCFullYear();
  const m = (d.getUTCMonth() + 1).toString().padStart(2, '0');
  const day = d.getUTCDate().toString().padStart(2, '0');
  return `${y}${m}${day}`;
}

function parseDateYYYYMMDD(s: string): Date {
  const y = Number.parseInt(s.slice(0, 4), 10);
  const m = Number.parseInt(s.slice(4, 6), 10);
  const d = Number.parseInt(s.slice(6, 8), 10);
  return new Date(Date.UTC(y, m - 1, d));
}

function formatDateYYMMDDhhmmss(d: Date): string {
  const yy = (d.getUTCFullYear() % 100).toString().padStart(2, '0');
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, '0');
  const dd = d.getUTCDate().toString().padStart(2, '0');
  const hh = d.getUTCHours().toString().padStart(2, '0');
  const mi = d.getUTCMinutes().toString().padStart(2, '0');
  const ss = d.getUTCSeconds().toString().padStart(2, '0');
  return `${yy}${mm}${dd}${hh}${mi}${ss}`;
}

function parseDateYYMMDDhhmmss(s: string): Date {
  const yy = Number.parseInt(s.slice(0, 2), 10);
  const mm = Number.parseInt(s.slice(2, 4), 10);
  const dd = Number.parseInt(s.slice(4, 6), 10);
  const hh = Number.parseInt(s.slice(6, 8), 10);
  const mi = Number.parseInt(s.slice(8, 10), 10);
  const ss = Number.parseInt(s.slice(10, 12), 10);
  // YY is 2026-style — we're in the 2000s.
  return new Date(Date.UTC(2000 + yy, mm - 1, dd, hh, mi, ss));
}
