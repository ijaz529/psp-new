#!/usr/bin/env tsx
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { parseArgs } from 'node:util';
import { type ClearingFormat, parseClearingFile, reconcileClearingFile } from '@psp-new/clearing-files';
import { createKysely, createPool, dbConfigFromEnv } from '@psp-new/db';

/**
 * Phase 20 — settlement file ingestion.
 *
 * Parses a Phase-6-emitted clearing file (visa_base2 or mc_ipm CSV),
 * reconciles its records against paycore.clearing_records, and prints a
 * report. Exit 0 on clean reconciliation, exit 1 on any discrepancy.
 */
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      path: { type: 'string', short: 'p' },
      format: { type: 'string', short: 'f' },
    },
    strict: true,
  });
  if (!values.path) {
    console.error('usage: pnpm clearing:ingest --path <file> [--format visa_base2|mc_ipm]');
    process.exit(2);
  }

  const format = (values.format ?? detectFormat(values.path)) as ClearingFormat;
  if (format !== 'visa_base2' && format !== 'mc_ipm') {
    console.error(`unknown format "${format}". use --format visa_base2|mc_ipm`);
    process.exit(2);
  }

  const contents = await readFile(values.path, 'utf8');
  const fileName = basename(values.path);
  console.log(`Parsing ${fileName} (${format})…`);
  const parsed = parseClearingFile(contents, format);
  console.log(`  → ${parsed.length} records parsed`);

  console.log('Reconciling against paycore.clearing_records…');
  const pool = createPool({ ...dbConfigFromEnv(), applicationName: 'clearing-ingest' });
  const db = createKysely(pool);
  try {
    const report = await reconcileClearingFile(db, parsed);
    console.log(`  matched           : ${report.matched}`);
    console.log(`  missing-from-ledger: ${report.missingFromLedger.length}`);
    for (const rrn of report.missingFromLedger) console.log(`    - ${rrn}`);
    console.log(`  amount-mismatches  : ${report.amountMismatches.length}`);
    for (const m of report.amountMismatches) {
      console.log(`    - ${m.rrn}  file=${m.fileAmount}  ledger=${m.ledgerAmount}`);
    }
    if (report.clean) {
      console.log('  status: clean ✓');
      process.exit(0);
    }
    console.log('  status: discrepancies found ✗');
    process.exit(1);
  } finally {
    await pool.end();
  }
}

function detectFormat(path: string): ClearingFormat {
  // Phase 6 emits filenames like visa_usd_20260519.csv, mastercard_usd_…csv.
  return /mastercard|mc_/i.test(basename(path)) ? 'mc_ipm' : 'visa_base2';
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
