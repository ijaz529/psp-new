import { describe, expect, it } from 'vitest';
import { type IssuerRouterDeps, handleAuthRequest, panInStrawberryRange, parseBinRanges } from './issuer.js';

describe('parseBinRanges', () => {
  it('returns empty for unset env', () => {
    expect(parseBinRanges(undefined)).toEqual([]);
    expect(parseBinRanges('')).toEqual([]);
  });
  it('parses a single range', () => {
    expect(parseBinRanges('411111000-411111999')).toEqual([{ low: '411111000', high: '411111999' }]);
  });
  it('parses multiple ranges', () => {
    expect(parseBinRanges('411111000-411111999, 555555000-555555999')).toEqual([
      { low: '411111000', high: '411111999' },
      { low: '555555000', high: '555555999' },
    ]);
  });
  it('rejects malformed input', () => {
    expect(() => parseBinRanges('411111-411112')).toThrow(/9 digits/);
  });
});

describe('panInStrawberryRange', () => {
  const ranges = [
    { low: '411111000', high: '411111999' },
    { low: '555555000', high: '555555999' },
  ];
  it('matches Visa range', () => {
    expect(panInStrawberryRange('4111110001234565', ranges)).toBe(true);
  });
  it('matches Mastercard range', () => {
    expect(panInStrawberryRange('5555550005551234', ranges)).toBe(true);
  });
  it('rejects out-of-range PAN', () => {
    expect(panInStrawberryRange('4012880012345670', ranges)).toBe(false); // 401288 is outside both
  });
  it('rejects short PAN', () => {
    expect(panInStrawberryRange('41111', ranges)).toBe(false);
  });
  it('rejects when no ranges configured', () => {
    expect(panInStrawberryRange('4111110001234565', [])).toBe(false);
  });
});

describe('handleAuthRequest — without issuer-host wiring (legacy stub path)', () => {
  const deps: IssuerRouterDeps = { strawberryRanges: [], issuerClient: null };

  it('approves the standard 4111... test PAN', async () => {
    // Minimal 0100 with PAN field. We rely on the iso8583 encode/decode for shape.
    const { buildMessage, encode } = await import('@psp-new/iso8583');
    const req = encode(
      buildMessage('0100', {
        2: '4111111111111111',
        3: '000000',
        4: '000000000100',
        7: '0101000000',
        11: '000001',
        37: '000000000001',
        49: '840',
      }),
    );
    const respBytes = await handleAuthRequest(req, deps);
    const { decode } = await import('@psp-new/iso8583');
    const resp = decode(respBytes);
    expect(resp.mti).toBe('0110');
    expect(resp.fields.get(39)).toBe('00');
  });
});
