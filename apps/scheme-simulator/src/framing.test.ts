import { describe, expect, it } from 'vitest';
import { createFrameReader, encodeFrame } from './framing.js';

describe('frame reader', () => {
  it('decodes a single complete frame', () => {
    const reader = createFrameReader();
    const body = Buffer.from('hello world');
    const wire = encodeFrame(body);
    const out = reader.push(wire);
    expect(out).toHaveLength(1);
    expect(out[0]!.toString()).toBe('hello world');
  });

  it('decodes two frames in one push', () => {
    const reader = createFrameReader();
    const a = encodeFrame(Buffer.from('alpha'));
    const b = encodeFrame(Buffer.from('beta'));
    const out = reader.push(Buffer.concat([a, b]));
    expect(out.map((f) => f.toString())).toEqual(['alpha', 'beta']);
  });

  it('reassembles a frame split across pushes', () => {
    const reader = createFrameReader();
    const body = encodeFrame(Buffer.from('hello world'));
    const r1 = reader.push(body.subarray(0, 6));
    expect(r1).toEqual([]);
    const r2 = reader.push(body.subarray(6));
    expect(r2).toHaveLength(1);
    expect(r2[0]!.toString()).toBe('hello world');
  });

  it('throws on malformed length prefix', () => {
    const reader = createFrameReader();
    expect(() => reader.push(Buffer.from('xxxxhello'))).toThrow(/malformed frame length prefix/);
  });

  it('encodeFrame rejects oversize bodies', () => {
    expect(() => encodeFrame(Buffer.alloc(10_000))).toThrow(RangeError);
  });

  it('encodeFrame pads small lengths to 4 digits', () => {
    const out = encodeFrame(Buffer.from('hi'));
    expect(out.subarray(0, 4).toString()).toBe('0002');
  });
});
