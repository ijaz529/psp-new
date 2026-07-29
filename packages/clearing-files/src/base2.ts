/**
 * Phase 28 — Visa Base II-shaped fixed-width clearing format.
 *
 * Faithful approximation of the real Base II Technical Specifications:
 *   - 200-byte ASCII records, space-padded, newline-separated.
 *   - One TC=90 TCR=0 header, N TC=05 TCR=0 detail records, one TC=90 TCR=1 trailer.
 *   - Trailer carries record_count and total_amount; parser rejects mismatched files.
 *
 * Real Base II is 168-byte EBCDIC with multiple TCR rows per transaction
 * (TCR1-6 carry POS data, CVM, acquirer business data, etc.). We ship a
 * one-TCR layout with ASCII + 200-byte rows. The semantic field set —
 * TC, TCR, account identifier, source currency (ISO 4217 numeric),
 * source amount (zero-padded minor units), RRN, source PCD julian date —
 * matches real Base II's TCR0. Time-of-day is lost in transit
 * (real Base II also only carries date), so round-tripping
 * `ClearingTransaction.occurredAt` truncates to midnight UTC.
 */

import type { ClearingTransaction } from './index.js';

export const RECORD_LENGTH = 200;

/** Field layout as (start, length) in 1-based positions; documented inline. */
const HEADER_LAYOUT = {
  tc: { pos: 1, len: 2 }, //                 "90"
  tcr: { pos: 3, len: 1 }, //                "0"
  fileId: { pos: 4, len: 20 }, //            ULID/text id
  fileDate: { pos: 24, len: 8 }, //          YYYYMMDD
  scheme: { pos: 32, len: 10 }, //           "visa" / "mastercard" (padded)
} as const;

const DETAIL_LAYOUT = {
  tc: { pos: 1, len: 2 }, //                 "05"
  tcr: { pos: 3, len: 1 }, //                "0"
  accountIdentifier: { pos: 4, len: 30 }, // payment_intent_id
  merchantId: { pos: 34, len: 30 }, //       merchant_id
  sourceCurrency: { pos: 64, len: 3 }, //    ISO 4217 numeric, e.g. "840"
  sourceAmount: { pos: 67, len: 12 }, //     zero-padded minor units
  rrn: { pos: 79, len: 12 }, //              12-digit RRN
  sourcePcd: { pos: 91, len: 8 }, //         YYYYMMDD (real Base II uses YYDDD julian; we keep YYYYMMDD for round-trip clarity)
  scheme: { pos: 99, len: 10 }, //           "visa" / "mastercard" / "amex"
} as const;

const TRAILER_LAYOUT = {
  tc: { pos: 1, len: 2 }, //                 "90"
  tcr: { pos: 3, len: 1 }, //                "1"
  recordCount: { pos: 4, len: 10 }, //       zero-padded
  totalAmount: { pos: 14, len: 18 }, //      zero-padded minor units
} as const;

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

export interface BuildBase2Opts {
  readonly fileId?: string;
  readonly fileDate?: Date;
}

export function buildVisaBase2(txs: ReadonlyArray<ClearingTransaction>, opts: BuildBase2Opts = {}): string {
  const fileDate = opts.fileDate ?? txs[0]?.occurredAt ?? new Date();
  const fileId = opts.fileId ?? `BASE2-${formatDateYYYYMMDD(fileDate)}`;
  const scheme = txs[0]?.scheme ?? 'visa';

  const lines: string[] = [];
  lines.push(buildHeader({ fileId, fileDate, scheme }));
  for (const tx of txs) {
    lines.push(buildDetail(tx));
  }
  const totalAmount = txs.reduce((acc, t) => acc + t.amount, 0n);
  lines.push(buildTrailer({ recordCount: txs.length, totalAmount }));
  return `${lines.join('\n')}\n`;
}

export interface ParsedBase2 {
  readonly header: { fileId: string; fileDate: Date; scheme: string };
  readonly transactions: ClearingTransaction[];
}

export function parseVisaBase2(contents: string): ParsedBase2 {
  const lines = contents.split('\n').filter((l) => l.length > 0);
  if (lines.length < 2) {
    throw new Error('base2: file must contain at least a header and a trailer');
  }
  for (const [i, line] of lines.entries()) {
    if (line.length !== RECORD_LENGTH) {
      throw new Error(`base2: record ${i + 1} has length ${line.length}, expected ${RECORD_LENGTH}`);
    }
  }

  const headerLine = lines[0] as string;
  const trailerLine = lines[lines.length - 1] as string;
  const detailLines = lines.slice(1, -1);

  const header = parseHeader(headerLine);
  const trailer = parseTrailer(trailerLine);

  const transactions = detailLines.map((line, i) => parseDetail(line, i + 2));

  if (transactions.length !== trailer.recordCount) {
    throw new Error(
      `base2: trailer record_count ${trailer.recordCount} does not match detail count ${transactions.length}`,
    );
  }
  const sum = transactions.reduce((acc, t) => acc + t.amount, 0n);
  if (sum !== trailer.totalAmount) {
    throw new Error(`base2: trailer total_amount ${trailer.totalAmount} does not match detail sum ${sum}`);
  }
  return { header, transactions };
}

/* ---------- builders ----------------------------------------------------- */

function buildHeader(h: { fileId: string; fileDate: Date; scheme: string }): string {
  const buf = blankRecord();
  writeField(buf, HEADER_LAYOUT.tc, '90');
  writeField(buf, HEADER_LAYOUT.tcr, '0');
  writeField(buf, HEADER_LAYOUT.fileId, h.fileId);
  writeField(buf, HEADER_LAYOUT.fileDate, formatDateYYYYMMDD(h.fileDate));
  writeField(buf, HEADER_LAYOUT.scheme, h.scheme);
  return buf.join('');
}

function buildDetail(tx: ClearingTransaction): string {
  const buf = blankRecord();
  const sourceCurrency = ISO_NUMERIC_BY_ALPHA[tx.currency];
  if (!sourceCurrency) {
    throw new Error(`base2: unsupported currency ${tx.currency} (no ISO 4217 numeric mapping)`);
  }
  // Phase 37: TC 05 = first presentment, TC 25 = chargeback. Trailer totals
  // stay gross (sum of all record amounts) — an integrity check, not a net.
  writeField(buf, DETAIL_LAYOUT.tc, tx.kind === 'chargeback' ? '25' : '05');
  writeField(buf, DETAIL_LAYOUT.tcr, '0');
  writeField(buf, DETAIL_LAYOUT.accountIdentifier, tx.paymentIntentId);
  writeField(buf, DETAIL_LAYOUT.merchantId, tx.merchantId);
  writeField(buf, DETAIL_LAYOUT.sourceCurrency, sourceCurrency);
  writeField(buf, DETAIL_LAYOUT.sourceAmount, padLeftZero(tx.amount.toString(), 12));
  writeField(buf, DETAIL_LAYOUT.rrn, tx.rrn);
  writeField(buf, DETAIL_LAYOUT.sourcePcd, formatDateYYYYMMDD(tx.occurredAt));
  writeField(buf, DETAIL_LAYOUT.scheme, tx.scheme);
  return buf.join('');
}

function buildTrailer(t: { recordCount: number; totalAmount: bigint }): string {
  const buf = blankRecord();
  writeField(buf, TRAILER_LAYOUT.tc, '90');
  writeField(buf, TRAILER_LAYOUT.tcr, '1');
  writeField(buf, TRAILER_LAYOUT.recordCount, padLeftZero(t.recordCount.toString(), 10));
  writeField(buf, TRAILER_LAYOUT.totalAmount, padLeftZero(t.totalAmount.toString(), 18));
  return buf.join('');
}

/* ---------- parsers ------------------------------------------------------ */

function parseHeader(line: string): { fileId: string; fileDate: Date; scheme: string } {
  const tc = readField(line, HEADER_LAYOUT.tc);
  const tcr = readField(line, HEADER_LAYOUT.tcr);
  if (tc !== '90' || tcr !== '0') {
    throw new Error(`base2: header expected TC=90 TCR=0, got TC=${tc} TCR=${tcr}`);
  }
  return {
    fileId: readField(line, HEADER_LAYOUT.fileId),
    fileDate: parseDateYYYYMMDD(readField(line, HEADER_LAYOUT.fileDate)),
    scheme: readField(line, HEADER_LAYOUT.scheme),
  };
}

function parseDetail(line: string, recordNumber: number): ClearingTransaction {
  const tc = readField(line, DETAIL_LAYOUT.tc);
  const tcr = readField(line, DETAIL_LAYOUT.tcr);
  if ((tc !== '05' && tc !== '25') || tcr !== '0') {
    throw new Error(`base2: detail record ${recordNumber} expected TC=05|25 TCR=0, got TC=${tc} TCR=${tcr}`);
  }
  const sourceCurrency = readField(line, DETAIL_LAYOUT.sourceCurrency);
  const currency = ISO_ALPHA_BY_NUMERIC[sourceCurrency];
  if (!currency) {
    throw new Error(`base2: detail record ${recordNumber} unknown ISO 4217 numeric ${sourceCurrency}`);
  }
  const scheme = readField(line, DETAIL_LAYOUT.scheme);
  if (scheme !== 'visa' && scheme !== 'mastercard' && scheme !== 'amex') {
    throw new Error(`base2: detail record ${recordNumber} unknown scheme ${scheme}`);
  }
  return {
    paymentIntentId: readField(line, DETAIL_LAYOUT.accountIdentifier),
    merchantId: readField(line, DETAIL_LAYOUT.merchantId),
    scheme,
    currency,
    amount: BigInt(readField(line, DETAIL_LAYOUT.sourceAmount)),
    rrn: readField(line, DETAIL_LAYOUT.rrn),
    occurredAt: parseDateYYYYMMDD(readField(line, DETAIL_LAYOUT.sourcePcd)),
    ...(tc === '25' ? { kind: 'chargeback' as const } : {}),
  };
}

function parseTrailer(line: string): { recordCount: number; totalAmount: bigint } {
  const tc = readField(line, TRAILER_LAYOUT.tc);
  const tcr = readField(line, TRAILER_LAYOUT.tcr);
  if (tc !== '90' || tcr !== '1') {
    throw new Error(`base2: trailer expected TC=90 TCR=1, got TC=${tc} TCR=${tcr}`);
  }
  return {
    recordCount: Number.parseInt(readField(line, TRAILER_LAYOUT.recordCount), 10),
    totalAmount: BigInt(readField(line, TRAILER_LAYOUT.totalAmount)),
  };
}

/* ---------- low-level helpers -------------------------------------------- */

function blankRecord(): string[] {
  return new Array<string>(RECORD_LENGTH).fill(' ');
}

interface FieldSpec {
  readonly pos: number;
  readonly len: number;
}

function writeField(buf: string[], field: FieldSpec, value: string): void {
  const padded = value.length > field.len ? value.slice(0, field.len) : value.padEnd(field.len, ' ');
  for (let i = 0; i < field.len; i++) {
    buf[field.pos - 1 + i] = padded[i] as string;
  }
}

function readField(line: string, field: FieldSpec): string {
  return line.slice(field.pos - 1, field.pos - 1 + field.len).trimEnd();
}

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
