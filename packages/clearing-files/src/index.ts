import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Database } from '@psp-new/db';
import { newId } from '@psp-new/ids';
import type { Kysely, Transaction } from 'kysely';

/**
 * Close-enough CSV per ADR-0017. Two formats:
 *   - `visa_base2`: header + data records, fields match the Base II PDS subset
 *                    needed for reconciliation (rrn, amount, merchant_id, etc.)
 *   - `mc_ipm`    : Mastercard IPM-style columns (slightly different naming
 *                    + different DE 22 POS entry encoding).
 *
 * Phase 6 emits CSVs to a local directory; Phase 8 swaps in object storage.
 */

export type ClearingFormat = 'visa_base2' | 'mc_ipm';

export interface ClearingTransaction {
  readonly paymentIntentId: string;
  readonly merchantId: string;
  readonly scheme: 'visa' | 'mastercard' | 'amex';
  readonly currency: string;
  readonly amount: bigint;
  readonly rrn: string;
  readonly occurredAt: Date;
}

export interface EmitClearingFilesArgs {
  readonly db: Kysely<Database>;
  /** Cleared transactions for the date — typically all succeeded PI captures. */
  readonly transactions: ReadonlyArray<ClearingTransaction>;
  readonly fileDate: Date;
  /** Where on disk to write. Falls back to `data-exports/clearing/`. */
  readonly outputDir?: string;
}

export interface EmittedClearingFile {
  readonly id: string;
  readonly scheme: 'visa' | 'mastercard' | 'amex';
  readonly currency: string;
  readonly format: ClearingFormat;
  readonly path: string;
  readonly recordCount: number;
  readonly totalAmount: bigint;
}

export async function emitClearingFiles(args: EmitClearingFilesArgs): Promise<EmittedClearingFile[]> {
  const outputDir = args.outputDir ?? join(process.cwd(), 'data-exports', 'clearing');
  await mkdir(outputDir, { recursive: true });

  // Group by (scheme, currency).
  const groups = new Map<string, ClearingTransaction[]>();
  for (const tx of args.transactions) {
    const key = `${tx.scheme}|${tx.currency}`;
    let arr = groups.get(key);
    if (!arr) {
      arr = [];
      groups.set(key, arr);
    }
    arr.push(tx);
  }

  const dateStr = formatDate(args.fileDate);
  const emitted: EmittedClearingFile[] = [];

  for (const [key, txs] of groups) {
    const [scheme, currency] = key.split('|') as ['visa' | 'mastercard' | 'amex', string];
    const format: ClearingFormat = scheme === 'mastercard' ? 'mc_ipm' : 'visa_base2';
    const filename = `${scheme}_${currency.toLowerCase()}_${dateStr}.csv`;
    const filePath = join(outputDir, filename);
    const csv = format === 'mc_ipm' ? buildMcIpmCsv(txs) : buildVisaBase2Csv(txs);
    await writeFile(filePath, csv, 'utf8');

    const totalAmount = txs.reduce((acc, t) => acc + t.amount, 0n);
    const id = newId('outbox_event').replace('oe_', 'cf_'); // reuse ULID, swap prefix
    await args.db
      .insertInto('paycore.clearing_files')
      .values({
        id,
        scheme,
        currency,
        file_date: args.fileDate,
        format,
        record_count: txs.length,
        total_amount: totalAmount,
        path: filePath,
        created_at: new Date(),
      })
      .execute();
    await args.db
      .insertInto('paycore.clearing_records')
      .values(
        txs.map((tx) => ({
          id: newId('outbox_event').replace('oe_', 'cr_'),
          clearing_file_id: id,
          payment_intent_id: tx.paymentIntentId,
          merchant_id: tx.merchantId,
          scheme: tx.scheme,
          currency: tx.currency,
          amount: tx.amount,
          rrn: tx.rrn,
          occurred_at: tx.occurredAt,
          created_at: new Date(),
        })),
      )
      .execute();
    emitted.push({ id, scheme, currency, format, path: filePath, recordCount: txs.length, totalAmount });
  }
  return emitted;
}

/** Collect all succeeded payment_intents from the given date (UTC). */
export async function collectClearingTransactionsForDate(
  db: Kysely<Database> | Transaction<Database>,
  date: Date,
): Promise<ClearingTransaction[]> {
  const start = utcStartOfDay(date);
  const end = new Date(start.getTime() + 86_400_000);
  const rows = await db
    .selectFrom('paycore.payment_intents')
    .leftJoin('paycore.payment_methods', 'paycore.payment_methods.id', 'paycore.payment_intents.payment_method_id')
    .select([
      'paycore.payment_intents.id as pi_id',
      'paycore.payment_intents.merchant_id as merchant_id',
      'paycore.payment_methods.scheme as scheme',
      'paycore.payment_intents.currency as currency',
      'paycore.payment_intents.amount_received as amount',
      'paycore.payment_intents.created_at as occurred_at',
    ])
    .where('paycore.payment_intents.status', '=', 'succeeded')
    .where('paycore.payment_intents.created_at', '>=', start)
    .where('paycore.payment_intents.created_at', '<', end)
    .execute();
  return rows
    .filter((r) => r.scheme === 'visa' || r.scheme === 'mastercard' || r.scheme === 'amex')
    .map((r) => ({
      paymentIntentId: r.pi_id,
      merchantId: r.merchant_id,
      scheme: r.scheme as 'visa' | 'mastercard' | 'amex',
      currency: r.currency,
      amount: r.amount,
      rrn: deterministicRrn(r.pi_id),
      occurredAt: r.occurred_at,
    }));
}

// --- CSV builders -----------------------------------------------------------

function buildVisaBase2Csv(txs: ClearingTransaction[]): string {
  // Header mirrors a Base II PDS-style subset. Real Base II is fixed-width;
  // we ship CSV per ADR-0017 (close-enough for reconciliation).
  const header = 'record_id,merchant_id,rrn,currency,amount_minor,occurred_at,scheme';
  const rows = txs.map(
    (tx) =>
      `${tx.paymentIntentId},${tx.merchantId},${tx.rrn},${tx.currency},${tx.amount},${tx.occurredAt.toISOString()},${tx.scheme}`,
  );
  return [header, ...rows].join('\n') + '\n';
}

function buildMcIpmCsv(txs: ClearingTransaction[]): string {
  // Mastercard IPM has a slightly different field set; emulate the headers.
  const header = 'pds_record_id,acceptor_id,acquirer_ref_data,trans_currency,trans_amount,trans_local_dt,mc_ipm_scheme';
  const rows = txs.map(
    (tx) =>
      `${tx.paymentIntentId},${tx.merchantId},${tx.rrn},${tx.currency},${tx.amount},${tx.occurredAt.toISOString()},${tx.scheme}`,
  );
  return [header, ...rows].join('\n') + '\n';
}

function formatDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = (d.getUTCMonth() + 1).toString().padStart(2, '0');
  const day = d.getUTCDate().toString().padStart(2, '0');
  return `${y}${m}${day}`;
}

function utcStartOfDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** Deterministic synthesized RRN from PI id — Phase 5 acquirer-host has real RRNs in logs only. */
function deterministicRrn(pi: string): string {
  let h = 0;
  for (let i = 0; i < pi.length; i++) h = (h * 31 + pi.charCodeAt(i)) | 0;
  return Math.abs(h).toString().padStart(12, '0').slice(0, 12);
}

void dirname; // silence unused if outputDir is provided
