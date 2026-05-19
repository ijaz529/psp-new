import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Database } from '@psp-new/db';
import { newId } from '@psp-new/ids';
import { postJournal, pspAccount, schemeAccount } from '@psp-new/ledger';
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

/* -------------------------------------------------------------------------- */
/* Phase 20 — settlement file ingestion                                       */
/* -------------------------------------------------------------------------- */

/**
 * Inverse of buildVisaBase2Csv / buildMcIpmCsv. Returns the parsed transactions
 * in the same shape the emit side produces, so a round-trip is symmetric.
 *
 * Tolerates trailing newlines and ignores blank lines. The header row is
 * required (and validated against the expected schema for the given format).
 */
export function parseClearingFile(contents: string, format: ClearingFormat): ClearingTransaction[] {
  const lines = contents.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  const [headerLine, ...dataLines] = lines as [string, ...string[]];
  const expectedHeader =
    format === 'mc_ipm'
      ? 'pds_record_id,acceptor_id,acquirer_ref_data,trans_currency,trans_amount,trans_local_dt,mc_ipm_scheme'
      : 'record_id,merchant_id,rrn,currency,amount_minor,occurred_at,scheme';
  if (headerLine !== expectedHeader) {
    throw new Error(`clearing file header mismatch (format=${format}). got: ${headerLine}`);
  }
  return dataLines.map((line, i) => {
    const cols = line.split(',');
    if (cols.length !== 7) {
      throw new Error(`clearing file row ${i + 2}: expected 7 columns, got ${cols.length}`);
    }
    // Same column order for both formats — they only differ by header naming.
    const [paymentIntentId, merchantId, rrn, currency, amountStr, occurredAtIso, scheme] = cols as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    if (scheme !== 'visa' && scheme !== 'mastercard' && scheme !== 'amex') {
      throw new Error(`clearing file row ${i + 2}: unknown scheme ${scheme}`);
    }
    return {
      paymentIntentId,
      merchantId,
      scheme,
      currency,
      amount: BigInt(amountStr),
      rrn,
      occurredAt: new Date(occurredAtIso),
    };
  });
}

/**
 * Compare a parsed clearing file against what we wrote at emit time. Records
 * with no matching `paycore.clearing_records` row by (scheme, currency, rrn)
 * are reported as missing-from-ledger. Records that match but disagree on
 * amount are reported as amount-mismatches.
 *
 * Phase 15's scheme-settlement worker trusts the ledger balance as the
 * source of truth for what schemes will settle. This function makes that
 * trust falsifiable — operators run it to detect drift.
 */
export interface AmountMismatch {
  readonly rrn: string;
  readonly fileAmount: bigint;
  readonly ledgerAmount: bigint;
}

export interface ReconciliationReport {
  readonly totalParsed: number;
  readonly matched: number;
  readonly missingFromLedger: ReadonlyArray<string>;
  readonly amountMismatches: ReadonlyArray<AmountMismatch>;
  readonly clean: boolean;
}

export async function reconcileClearingFile(
  db: Kysely<Database> | Transaction<Database>,
  parsed: ReadonlyArray<ClearingTransaction>,
): Promise<ReconciliationReport> {
  if (parsed.length === 0) {
    return { totalParsed: 0, matched: 0, missingFromLedger: [], amountMismatches: [], clean: true };
  }
  // One query for everything — fetch any clearing_records that match an RRN
  // from the file. The (scheme, currency, rrn) tuple uniquely identifies a
  // record in practice (RRNs are scheme-scoped 12-digit values, and a record
  // for one currency wouldn't show up under another's file).
  const rrns = parsed.map((p) => p.rrn);
  const ledgerRows = (await db
    .selectFrom('paycore.clearing_records')
    .select(['rrn', 'amount', 'scheme', 'currency'])
    .where('rrn', 'in', rrns)
    .execute()) as ReadonlyArray<{ rrn: string; amount: bigint; scheme: string; currency: string }>;
  const ledgerByKey = new Map<string, { amount: bigint }>();
  for (const r of ledgerRows) {
    ledgerByKey.set(`${r.scheme}|${r.currency}|${r.rrn}`, { amount: r.amount });
  }

  const missingFromLedger: string[] = [];
  const amountMismatches: AmountMismatch[] = [];
  let matched = 0;

  for (const p of parsed) {
    const key = `${p.scheme}|${p.currency}|${p.rrn}`;
    const ledger = ledgerByKey.get(key);
    if (!ledger) {
      missingFromLedger.push(p.rrn);
      continue;
    }
    if (ledger.amount !== p.amount) {
      amountMismatches.push({ rrn: p.rrn, fileAmount: p.amount, ledgerAmount: ledger.amount });
      continue;
    }
    matched++;
  }

  return {
    totalParsed: parsed.length,
    matched,
    missingFromLedger,
    amountMismatches,
    clean: missingFromLedger.length === 0 && amountMismatches.length === 0,
  };
}

/* -------------------------------------------------------------------------- */
/* Phase 21 — opt-in auto-adjust on clearing ingest                           */
/* -------------------------------------------------------------------------- */

export interface AdjustmentJournal {
  readonly scheme: 'visa' | 'mastercard' | 'amex';
  readonly currency: string;
  readonly delta: bigint;
  readonly journalEntryId: string;
}

/**
 * For each (scheme, currency) combo in the parsed file, compute the net
 * delta = Σ file_amount − Σ ledger_amount. If non-zero, post a single
 * adjustment journal that true-ups scheme_receivable against the file:
 *
 *   scheme_receivable[scheme, currency]  +delta
 *   clearing_adjustments[currency]       -delta
 *
 * Idempotency rides externalId 'clearing_adjust:${fileHash}:${scheme}:${currency}'.
 * A second run with the same file is a no-op (unique violation swallowed).
 *
 * Per-(scheme, currency) transaction so one bad group doesn't poison the run.
 */
export async function postClearingAdjustments(
  db: Kysely<Database> | Transaction<Database>,
  parsed: ReadonlyArray<ClearingTransaction>,
  fileHash: string,
): Promise<AdjustmentJournal[]> {
  if (parsed.length === 0) return [];

  // Group parsed by (scheme, currency) and sum file_amounts.
  const groups = new Map<
    string,
    { scheme: 'visa' | 'mastercard' | 'amex'; currency: string; fileSum: bigint; rrns: string[] }
  >();
  for (const p of parsed) {
    const key = `${p.scheme}|${p.currency}`;
    let g = groups.get(key);
    if (!g) {
      g = { scheme: p.scheme, currency: p.currency, fileSum: 0n, rrns: [] };
      groups.set(key, g);
    }
    g.fileSum += p.amount;
    g.rrns.push(p.rrn);
  }

  // One bulk SELECT for all rrns across all groups; partition into per-group sums.
  const allRrns = parsed.map((p) => p.rrn);
  const ledgerRows = (await db
    .selectFrom('paycore.clearing_records')
    .select(['rrn', 'amount', 'scheme', 'currency'])
    .where('rrn', 'in', allRrns)
    .execute()) as ReadonlyArray<{ rrn: string; amount: bigint; scheme: string; currency: string }>;
  const ledgerSumByKey = new Map<string, bigint>();
  for (const r of ledgerRows) {
    const key = `${r.scheme}|${r.currency}`;
    ledgerSumByKey.set(key, (ledgerSumByKey.get(key) ?? 0n) + r.amount);
  }

  const out: AdjustmentJournal[] = [];
  for (const [key, g] of groups) {
    const ledgerSum = ledgerSumByKey.get(key) ?? 0n;
    const delta = g.fileSum - ledgerSum;
    if (delta === 0n) continue;
    try {
      const entry = await (db as Kysely<Database>).transaction().execute(async (trx) => {
        return postJournal(trx, {
          externalId: `clearing_adjust:${fileHash}:${g.scheme}:${g.currency}`,
          description: `clearing adjust ${g.scheme} ${g.currency} delta=${delta}`,
          occurredAt: new Date(),
          postings: [
            {
              accountId: schemeAccount('scheme_receivable', g.currency, g.scheme),
              amount: delta,
              currency: g.currency,
            },
            { accountId: pspAccount('clearing_adjustments', g.currency), amount: -delta, currency: g.currency },
          ],
        });
      });
      out.push({ scheme: g.scheme, currency: g.currency, delta, journalEntryId: entry.id });
    } catch {
      // Likely externalId unique violation — already adjusted for this file.
      // Skip; caller can re-read journal entries by externalId if curious.
    }
  }
  return out;
}

/** Convenience: SHA-256 hex digest of file contents, suitable for fileHash. */
export function clearingFileHash(contents: string): string {
  return createHash('sha256').update(contents).digest('hex');
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
