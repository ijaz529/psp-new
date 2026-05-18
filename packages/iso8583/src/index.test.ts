import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { decodeBitmap, encodeBitmap } from './bitmap.js';
import { decodeField, encodeField } from './fields.js';
import { buildMessage, decode, encode } from './message.js';

describe('bitmap', () => {
  it('encodes a single DE 2 primary bitmap', () => {
    expect(encodeBitmap([2])).toBe('4000000000000000');
  });
  it('encodes DE 39 (single field) as bit 39 in primary', () => {
    // bit 39 = byte 4 (zero-indexed), bit-in-byte 1 → 0x02; bytes 0-3 zero, byte 4 = 0x02
    expect(encodeBitmap([39])).toBe('0000000002000000');
  });
  it('encodes a secondary-bitmap-triggering DE 90', () => {
    const out = encodeBitmap([90]);
    expect(out.length).toBe(32);
    // bit 1 set + bit 90 set
    expect(out[0]).toBe('8');
  });
  it('round-trips a random set of DEs', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 2, max: 128 }), { minLength: 1, maxLength: 30 }), (raw) => {
        const present = [...new Set(raw)].sort((a, b) => a - b);
        const enc = encodeBitmap(present);
        const dec = decodeBitmap(enc);
        expect(dec.present).toEqual(present);
      }),
    );
  });
});

describe('fields — round trip', () => {
  it('FIXED n6 (STAN)', () => {
    const enc = encodeField(11, '000042');
    expect(enc).toBe('000042');
    expect(decodeField(11, enc, 0)).toEqual({ value: '000042', consumed: 6 });
  });

  it('FIXED n12 (amount)', () => {
    expect(encodeField(4, '000000001000')).toBe('000000001000');
  });

  it('FIXED an2 (response code)', () => {
    expect(encodeField(39, '00')).toBe('00');
    expect(decodeField(39, '51', 0)).toEqual({ value: '51', consumed: 2 });
  });

  it('LLVAR n..19 (PAN)', () => {
    const pan = '4111111111111111';
    const enc = encodeField(2, pan);
    expect(enc).toBe(`16${pan}`);
    const { value, consumed } = decodeField(2, enc, 0);
    expect(value).toBe(pan);
    expect(consumed).toBe(18);
  });

  it('LLLVAR (private 62)', () => {
    const enc = encodeField(62, 'hello');
    expect(enc).toBe('005hello');
    const { value, consumed } = decodeField(62, enc, 0);
    expect(value).toBe('hello');
    expect(consumed).toBe(8);
  });

  it('numeric type rejects non-digits', () => {
    expect(() => encodeField(4, '00000000abcd')).toThrowError(/non-numeric/);
  });

  it('exceeds-max errors are precise', () => {
    expect(() => encodeField(2, '12345678901234567890')).toThrowError(/exceeds max length 19/);
  });
});

describe('message — encode/decode round trip', () => {
  it('0100 auth request', () => {
    const msg = buildMessage('0100', {
      2: '4111111111111111',
      3: '000000',
      4: '000000001000',
      7: '0518120000',
      11: '000042',
      12: '120000',
      13: '0518',
      14: '3012',
      22: '012',
      37: 'RRN000000042',
      41: 'TERM0001',
      42: 'MERCH_DEMO_0001',
      49: '840',
    });
    const enc = encode(msg);
    const dec = decode(enc);
    expect(dec.mti).toBe('0100');
    expect(dec.fields.get(2)).toBe('4111111111111111');
    expect(dec.fields.get(4)).toBe('000000001000');
    expect(dec.fields.get(37)).toBe('RRN000000042');
    expect(dec.fields.get(49)).toBe('840');
  });

  it('0110 auth response (RC=00 approved)', () => {
    const msg = buildMessage('0110', {
      3: '000000',
      4: '000000001000',
      7: '0518120000',
      11: '000042',
      37: 'RRN000000042',
      38: 'APPR42',
      39: '00',
      49: '840',
    });
    const enc = encode(msg);
    const dec = decode(enc);
    expect(dec.fields.get(39)).toBe('00');
    expect(dec.fields.get(38)).toBe('APPR42');
  });

  it('property: any valid combination of supported DEs round-trips', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('0100', '0110', '0200', '0210', '0400', '0410'),
        fc.integer({ min: 1, max: 999_999 }),
        (mti, stan) => {
          const msg = buildMessage(mti as never, {
            4: stan.toString().padStart(12, '0'),
            11: (stan % 1_000_000).toString().padStart(6, '0'),
            39: '00',
            49: '840',
          });
          const enc = encode(msg);
          const dec = decode(enc);
          expect(dec.mti).toBe(mti);
          expect(dec.fields.get(11)).toBe(msg.fields.get(11));
        },
      ),
    );
  });
});
