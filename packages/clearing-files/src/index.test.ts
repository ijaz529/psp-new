import { describe, expect, it } from 'vitest';
import {
  type ClearingTransaction,
  clearingFileHash,
  emitClearingFiles,
  parseClearingFile,
  postClearingAdjustments,
  reconcileClearingFile,
} from './index.js';

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
    expect(visaUsdFile?.path.endsWith('.b2')).toBe(true);
    const content = await fs.readFile(visaUsdFile!.path, 'utf8');
    expect(content.startsWith('900')).toBe(true); // TC=90 TCR=0 header
    expect(content).toContain('pi_1'); // account identifier slot
    expect(content).toContain('840'); // USD ISO 4217 numeric

    const mcFile = out.find((e) => e.scheme === 'mastercard');
    const mcContent = await fs.readFile(mcFile!.path, 'utf8');
    expect(mcContent).toMatch(/pds_record_id,acceptor_id/); // MC IPM-style header (still CSV pre-phase-29)

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

  it('visa_base2 round-trip preserves all fields (time-of-day truncated to UTC midnight)', async () => {
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
      // Base II only carries date (not time); compare with truncated occurredAt.
      const expected = sampleTxs.map((t) => ({ ...t, occurredAt: new Date('2026-05-19T00:00:00Z') }));
      expect(parsed).toEqual(expected);
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

  it('rejects a clearly wrong mc_ipm header', () => {
    expect(() => parseClearingFile('wrong,header,here\npi_1,mrch_1,r,USD,100,2026-01-01,visa', 'mc_ipm')).toThrow(
      /header mismatch/,
    );
  });

  it('rejects an unknown scheme on an mc_ipm record', () => {
    const mcHeader =
      'pds_record_id,acceptor_id,acquirer_ref_data,trans_currency,trans_amount,trans_local_dt,mc_ipm_scheme';
    expect(() =>
      parseClearingFile(`${mcHeader}\npi_1,mrch_1,000000000001,USD,100,2026-01-01T00:00:00Z,jcb`, 'mc_ipm'),
    ).toThrow(/unknown scheme jcb/);
  });

  it('returns empty array for an empty mc_ipm file', () => {
    expect(parseClearingFile('', 'mc_ipm')).toEqual([]);
  });

  it('rejects a base2 file with truncated record length', () => {
    // Two lines so we pass the min-line gate, both too short → length error.
    expect(() => parseClearingFile('900tooshort\n901tooshort\n', 'visa_base2')).toThrow(/length/);
  });

  it('rejects a base2 file whose trailer total does not match detail sum', async () => {
    // Build a valid file, tamper the trailer total, expect parser to throw.
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'clearing-tamper-'));
    try {
      const out = await emitClearingFiles({
        db: mockDb,
        transactions: sampleTxs,
        fileDate: new Date('2026-05-19T00:00:00Z'),
        outputDir: tmp,
      });
      const visaFile = out.find((f) => f.scheme === 'visa' && f.currency === 'USD');
      const content = await fs.readFile(visaFile!.path, 'utf8');
      const lines = content.split('\n').filter((l) => l.length > 0);
      // Last line is the trailer (TC=90, TCR=1). Flip the last digit of the total amount.
      const trailer = lines[lines.length - 1] as string;
      const tampered = `${trailer.slice(0, 30)}9${trailer.slice(31)}`;
      const tamperedFile = [...lines.slice(0, -1), tampered].join('\n') + '\n';
      expect(() => parseClearingFile(tamperedFile, 'visa_base2')).toThrow(/total_amount/);
    } finally {
      await fs.rm(tmp, { recursive: true });
    }
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

describe('postClearingAdjustments', () => {
  // Mock db that supports both the SELECT path (for reading ledger sums) and
  // the .transaction().execute(async (trx) => postJournal(trx, ...)) path.
  // postJournal does insertInto('ledger.journal_entries').values(…).execute()
  // then insertInto('ledger.journal_lines').values(…).execute().
  interface PostedJournal {
    externalId: string;
    description: string;
    occurredAt: Date;
    lines: Array<{ account_id: string; amount: bigint; currency: string }>;
  }

  function buildMockDb(
    ledgerRows: Array<{ rrn: string; amount: bigint; scheme: string; currency: string }>,
    posted: PostedJournal[],
  ): any {
    const dummyEntryId = (): string => `je_test_${Math.random().toString(36).slice(2, 10)}`;
    const trx = {
      // ledger.journal_entries insert
      insertInto: (table: string) => ({
        values: (values: unknown) => ({
          execute: async () => {
            if (table === 'ledger.journal_entries') {
              const v = values as { id: string; external_id: string; description: string; occurred_at: Date };
              posted.push({
                externalId: v.external_id,
                description: v.description,
                occurredAt: v.occurred_at,
                lines: [],
              });
            } else if (table === 'ledger.journal_lines') {
              const v = values as Array<{ account_id: string; amount: bigint; currency: string }>;
              posted[posted.length - 1]!.lines.push(
                ...v.map((l) => ({ account_id: l.account_id, amount: l.amount, currency: l.currency })),
              );
            }
          },
        }),
      }),
    };
    return {
      selectFrom: () => ({
        select: () => ({
          where: () => ({
            execute: async () => ledgerRows,
          }),
        }),
      }),
      transaction: () => ({
        execute: async <T>(fn: (trx: any) => Promise<T>) => {
          // postJournal also returns its own entryId — emulate that.
          const result = await fn(trx);
          return result ?? { id: dummyEntryId() };
        },
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

  it('clean — no adjustments posted', async () => {
    const posted: PostedJournal[] = [];
    const db = buildMockDb(
      [
        { rrn: '000000000001', amount: 1000n, scheme: 'visa', currency: 'USD' },
        { rrn: '000000000002', amount: 2000n, scheme: 'visa', currency: 'USD' },
      ],
      posted,
    );
    const adjustments = await postClearingAdjustments(db, parsed, 'hash1');
    expect(adjustments).toEqual([]);
    expect(posted).toEqual([]);
  });

  it('file higher than ledger → positive delta adjustment', async () => {
    const posted: PostedJournal[] = [];
    const db = buildMockDb(
      [
        { rrn: '000000000001', amount: 999n, scheme: 'visa', currency: 'USD' }, // file says 1000
        { rrn: '000000000002', amount: 2000n, scheme: 'visa', currency: 'USD' },
      ],
      posted,
    );
    const adjustments = await postClearingAdjustments(db, parsed, 'hash2');
    expect(adjustments).toHaveLength(1);
    expect(adjustments[0]!.delta).toBe(1n);
    expect(adjustments[0]!.scheme).toBe('visa');
    expect(adjustments[0]!.currency).toBe('USD');
    // One journal posted with two lines summing to zero.
    expect(posted).toHaveLength(1);
    expect(posted[0]!.externalId).toBe('clearing_adjust:hash2:visa:USD');
    const sum = posted[0]!.lines.reduce((a, l) => a + l.amount, 0n);
    expect(sum).toBe(0n);
  });

  it('missing-from-ledger contributes full file amount to the delta', async () => {
    const posted: PostedJournal[] = [];
    const db = buildMockDb(
      [
        { rrn: '000000000001', amount: 1000n, scheme: 'visa', currency: 'USD' },
        // 000000000002 missing — file says 2000, ledger says 0
      ],
      posted,
    );
    const adjustments = await postClearingAdjustments(db, parsed, 'hash3');
    expect(adjustments).toHaveLength(1);
    expect(adjustments[0]!.delta).toBe(2000n);
  });

  it('mix across (scheme, currency) combos posts one journal per combo', async () => {
    const mixedParsed: ClearingTransaction[] = [
      ...parsed,
      {
        paymentIntentId: 'pi_c',
        merchantId: 'mrch_x',
        scheme: 'mastercard',
        currency: 'EUR',
        amount: 500n,
        rrn: '000000000003',
        occurredAt: new Date('2026-05-19T11:00:00Z'),
      },
    ];
    const posted: PostedJournal[] = [];
    const db = buildMockDb(
      [
        { rrn: '000000000001', amount: 999n, scheme: 'visa', currency: 'USD' },
        { rrn: '000000000002', amount: 1999n, scheme: 'visa', currency: 'USD' },
        { rrn: '000000000003', amount: 499n, scheme: 'mastercard', currency: 'EUR' },
      ],
      posted,
    );
    const adjustments = await postClearingAdjustments(db, mixedParsed, 'hash4');
    expect(adjustments).toHaveLength(2);
    expect(adjustments.map((a) => a.delta).sort()).toEqual([1n, 2n]);
  });

  it('empty parsed input → no work', async () => {
    const posted: PostedJournal[] = [];
    const db = buildMockDb([], posted);
    const adjustments = await postClearingAdjustments(db, [], 'hash5');
    expect(adjustments).toEqual([]);
  });

  it('clearingFileHash is stable for the same input', () => {
    expect(clearingFileHash('hello')).toBe(clearingFileHash('hello'));
    expect(clearingFileHash('hello')).not.toBe(clearingFileHash('world'));
  });
});
