import { describe, expect, it } from 'vitest';
import { type ClearingTransaction, emitClearingFiles, parseClearingFile, reconcileClearingFile } from './index.js';

// We only unit-test the CSV format directly (no DB).
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

describe('emitClearingFiles', () => {
  it('groups by (scheme, currency) and writes a CSV per group (DB-skipped variant)', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'clearing-'));
    const txs: ClearingTransaction[] = [
      {
        paymentIntentId: 'pi_1',
        merchantId: 'mrch_1',
        scheme: 'visa',
        currency: 'USD',
        amount: 1000n,
        rrn: '000000000001',
        occurredAt: new Date('2026-05-18T12:00:00Z'),
      },
      {
        paymentIntentId: 'pi_2',
        merchantId: 'mrch_1',
        scheme: 'visa',
        currency: 'USD',
        amount: 500n,
        rrn: '000000000002',
        occurredAt: new Date('2026-05-18T13:00:00Z'),
      },
      {
        paymentIntentId: 'pi_3',
        merchantId: 'mrch_1',
        scheme: 'mastercard',
        currency: 'USD',
        amount: 200n,
        rrn: '000000000003',
        occurredAt: new Date('2026-05-18T14:00:00Z'),
      },
      {
        paymentIntentId: 'pi_4',
        merchantId: 'mrch_2',
        scheme: 'visa',
        currency: 'EUR',
        amount: 700n,
        rrn: '000000000004',
        occurredAt: new Date('2026-05-18T15:00:00Z'),
      },
    ];
    // Use a mocked db that records insert calls.
    const inserts: Array<{ table: string; values: unknown }> = [];
    const mockDb: any = {
      insertInto: (table: string) => ({
        values: (values: unknown) => ({
          execute: async () => {
            inserts.push({ table, values });
          },
        }),
      }),
    };
    const out = await emitClearingFiles({
      db: mockDb,
      transactions: txs,
      fileDate: new Date('2026-05-18T00:00:00Z'),
      outputDir: tmp,
    });
    expect(out).toHaveLength(3); // (visa, USD), (mc, USD), (visa, EUR)
    expect(inserts.filter((i) => i.table === 'paycore.clearing_files')).toHaveLength(3);
    expect(inserts.filter((i) => i.table === 'paycore.clearing_records')).toHaveLength(3);

    const visaUsdFile = out.find((e) => e.scheme === 'visa' && e.currency === 'USD');
    expect(visaUsdFile?.recordCount).toBe(2);
    expect(visaUsdFile?.totalAmount).toBe(1500n);
    const content = await fs.readFile(visaUsdFile!.path, 'utf8');
    expect(content).toMatch(/record_id,merchant_id,rrn/);
    expect(content).toMatch(/pi_1.*USD.*1000/);

    const mcFile = out.find((e) => e.scheme === 'mastercard');
    const mcContent = await fs.readFile(mcFile!.path, 'utf8');
    expect(mcContent).toMatch(/pds_record_id,acceptor_id/); // MC IPM-style header

    await fs.rm(tmp, { recursive: true });
  });
});

describe('parseClearingFile — round-trip with emit', () => {
  // Use the same db mock as the emit test so we can reuse the txs setup.
  const inserts: Array<{ table: string; values: unknown }> = [];
  const mockDb: any = {
    insertInto: (table: string) => ({
      values: (values: unknown) => ({
        execute: async () => {
          inserts.push({ table, values });
        },
      }),
    }),
  };

  const sampleTxs: ClearingTransaction[] = [
    {
      paymentIntentId: 'pi_a',
      merchantId: 'mrch_x',
      scheme: 'visa',
      currency: 'USD',
      amount: 2500n,
      rrn: '601201000010',
      occurredAt: new Date('2026-05-19T09:00:00Z'),
    },
    {
      paymentIntentId: 'pi_b',
      merchantId: 'mrch_x',
      scheme: 'visa',
      currency: 'USD',
      amount: 9900n,
      rrn: '601201000011',
      occurredAt: new Date('2026-05-19T10:30:00Z'),
    },
  ];

  it('visa_base2 round-trip preserves all fields', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'clearing-roundtrip-'));
    try {
      const out = await emitClearingFiles({
        db: mockDb,
        transactions: sampleTxs,
        fileDate: new Date('2026-05-19T00:00:00Z'),
        outputDir: tmp,
      });
      const visaFile = out.find((f) => f.scheme === 'visa' && f.currency === 'USD');
      expect(visaFile).toBeDefined();
      const content = await fs.readFile(visaFile!.path, 'utf8');
      const parsed = parseClearingFile(content, 'visa_base2');
      expect(parsed).toHaveLength(2);
      expect(parsed).toEqual(sampleTxs);
    } finally {
      await fs.rm(tmp, { recursive: true });
    }
  });

  it('mc_ipm round-trip preserves all fields', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'clearing-roundtrip-mc-'));
    try {
      const mcTxs: ClearingTransaction[] = sampleTxs.map((t) => ({ ...t, scheme: 'mastercard' as const }));
      const out = await emitClearingFiles({
        db: mockDb,
        transactions: mcTxs,
        fileDate: new Date('2026-05-19T00:00:00Z'),
        outputDir: tmp,
      });
      const mcFile = out.find((f) => f.scheme === 'mastercard');
      expect(mcFile).toBeDefined();
      const content = await fs.readFile(mcFile!.path, 'utf8');
      const parsed = parseClearingFile(content, 'mc_ipm');
      expect(parsed).toEqual(mcTxs);
    } finally {
      await fs.rm(tmp, { recursive: true });
    }
  });

  it('rejects a clearly wrong header', () => {
    expect(() => parseClearingFile('wrong,header,here\npi_1,mrch_1,r,USD,100,2026-01-01,visa', 'visa_base2')).toThrow(
      /header mismatch/,
    );
  });

  it('rejects an unknown scheme on a record', () => {
    const visaHeader = 'record_id,merchant_id,rrn,currency,amount_minor,occurred_at,scheme';
    expect(() =>
      parseClearingFile(`${visaHeader}\npi_1,mrch_1,000000000001,USD,100,2026-01-01T00:00:00Z,jcb`, 'visa_base2'),
    ).toThrow(/unknown scheme jcb/);
  });

  it('returns empty array for an empty file', () => {
    expect(parseClearingFile('', 'visa_base2')).toEqual([]);
  });
});

describe('reconcileClearingFile', () => {
  function dbWithLedgerRows(rows: Array<{ rrn: string; amount: bigint; scheme: string; currency: string }>): any {
    return {
      selectFrom: () => ({
        select: () => ({
          where: () => ({
            execute: async () => rows,
          }),
        }),
      }),
    };
  }

  const parsed: ClearingTransaction[] = [
    {
      paymentIntentId: 'pi_a',
      merchantId: 'mrch_x',
      scheme: 'visa',
      currency: 'USD',
      amount: 1000n,
      rrn: '000000000001',
      occurredAt: new Date('2026-05-19T09:00:00Z'),
    },
    {
      paymentIntentId: 'pi_b',
      merchantId: 'mrch_x',
      scheme: 'visa',
      currency: 'USD',
      amount: 2000n,
      rrn: '000000000002',
      occurredAt: new Date('2026-05-19T10:00:00Z'),
    },
  ];

  it('reports clean when all records match', async () => {
    const db = dbWithLedgerRows([
      { rrn: '000000000001', amount: 1000n, scheme: 'visa', currency: 'USD' },
      { rrn: '000000000002', amount: 2000n, scheme: 'visa', currency: 'USD' },
    ]);
    const r = await reconcileClearingFile(db, parsed);
    expect(r.clean).toBe(true);
    expect(r.matched).toBe(2);
    expect(r.missingFromLedger).toEqual([]);
    expect(r.amountMismatches).toEqual([]);
  });

  it('flags amount mismatches', async () => {
    const db = dbWithLedgerRows([
      { rrn: '000000000001', amount: 999n, scheme: 'visa', currency: 'USD' }, // tampered
      { rrn: '000000000002', amount: 2000n, scheme: 'visa', currency: 'USD' },
    ]);
    const r = await reconcileClearingFile(db, parsed);
    expect(r.clean).toBe(false);
    expect(r.matched).toBe(1);
    expect(r.amountMismatches).toEqual([{ rrn: '000000000001', fileAmount: 1000n, ledgerAmount: 999n }]);
  });

  it('flags records missing from the ledger', async () => {
    const db = dbWithLedgerRows([
      { rrn: '000000000001', amount: 1000n, scheme: 'visa', currency: 'USD' },
      // 000000000002 absent
    ]);
    const r = await reconcileClearingFile(db, parsed);
    expect(r.clean).toBe(false);
    expect(r.missingFromLedger).toEqual(['000000000002']);
  });

  it('clean for empty parsed input', async () => {
    const db = dbWithLedgerRows([]);
    const r = await reconcileClearingFile(db, []);
    expect(r.clean).toBe(true);
    expect(r.totalParsed).toBe(0);
  });
});
