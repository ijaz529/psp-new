import { describe, expect, it } from 'vitest';
import { hashRequestBody, processExisting } from './index.js';

const baseRow = {
  request_hash: hashRequestBody({ amount: 100 }),
  response_status: null as number | null,
  response_body: null as unknown,
  locked_at: new Date(),
  completed_at: null as Date | null,
  expires_at: new Date(Date.now() + 60_000),
};

describe('processExisting (4-path decision)', () => {
  it('returns replay when completed', () => {
    const row = { ...baseRow, response_status: 200, response_body: { ok: true }, completed_at: new Date() };
    const out = processExisting(row, hashRequestBody({ amount: 100 }));
    expect(out.kind).toBe('replay');
    if (out.kind === 'replay') {
      expect(out.status).toBe(200);
      expect(out.body).toEqual({ ok: true });
    }
  });

  it('returns body_mismatch when hash differs (regardless of completion)', () => {
    const row = { ...baseRow, response_status: 200, completed_at: new Date() };
    const out = processExisting(row, hashRequestBody({ amount: 999 }));
    expect(out.kind).toBe('body_mismatch');
  });

  it('returns locked when in-progress', () => {
    const out = processExisting(baseRow, hashRequestBody({ amount: 100 }));
    expect(out.kind).toBe('locked');
  });

  it('returns locked when stale (caller should back off and retry; janitor will sweep)', () => {
    const row = { ...baseRow, expires_at: new Date(Date.now() - 1000) };
    const out = processExisting(row, hashRequestBody({ amount: 100 }));
    expect(out.kind).toBe('locked');
  });
});
