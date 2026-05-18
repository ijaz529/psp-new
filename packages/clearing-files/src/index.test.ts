import { describe, expect, it } from 'vitest';
import { type ClearingTransaction, emitClearingFiles } from './index.js';

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
