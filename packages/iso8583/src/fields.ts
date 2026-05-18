import { type FieldSpec, fieldSpec } from './spec.js';

/**
 * Per-DE encoder / decoder. ASCII-only variant: all values on the wire are
 * ASCII characters. Binary fields are hex-encoded (each byte → 2 ASCII chars).
 *
 * Encoders accept the "natural" representation:
 *   - `n` / `an` / `ans` / `z` → string
 *   - `b` → Buffer or hex string
 *
 * Decoders return the natural representation.
 */
export type FieldValue = string;

export function encodeField(de: number, value: FieldValue | Buffer): string {
  const spec = fieldSpec(de);
  const body = encodeBody(spec, value);
  if (spec.kind === 'FIXED') {
    if (body.length !== expectedFixedLen(spec)) {
      throw new Error(`DE ${de} (${spec.name}): fixed length ${expectedFixedLen(spec)}, got ${body.length}`);
    }
    return body;
  }
  // VAR
  const max = expectedFixedLen(spec);
  if (body.length > max) {
    throw new Error(`DE ${de} (${spec.name}): exceeds max length ${max} (got ${body.length})`);
  }
  const prefixLen = spec.kind === 'LLVAR' ? 2 : 3;
  return body.length.toString().padStart(prefixLen, '0') + body;
}

export interface DecodeFieldResult {
  readonly value: FieldValue | Buffer;
  /** Characters consumed from the input. */
  readonly consumed: number;
}

export function decodeField(de: number, input: string, offset: number): DecodeFieldResult {
  const spec = fieldSpec(de);
  if (spec.kind === 'FIXED') {
    const len = expectedFixedLen(spec);
    if (input.length < offset + len) {
      throw new Error(`DE ${de} (${spec.name}): truncated, expected ${len} chars`);
    }
    const body = input.slice(offset, offset + len);
    return { value: decodeBody(spec, body), consumed: len };
  }
  const prefixLen = spec.kind === 'LLVAR' ? 2 : 3;
  if (input.length < offset + prefixLen) {
    throw new Error(`DE ${de}: truncated length prefix`);
  }
  const lenStr = input.slice(offset, offset + prefixLen);
  if (!/^\d+$/.test(lenStr)) throw new Error(`DE ${de}: non-numeric length prefix '${lenStr}'`);
  const len = Number.parseInt(lenStr, 10);
  const max = expectedFixedLen(spec);
  if (len > max) throw new Error(`DE ${de}: length ${len} exceeds max ${max}`);
  if (input.length < offset + prefixLen + len) {
    throw new Error(`DE ${de}: truncated body, expected ${len} chars`);
  }
  const body = input.slice(offset + prefixLen, offset + prefixLen + len);
  return { value: decodeBody(spec, body), consumed: prefixLen + len };
}

// --- internals --------------------------------------------------------------

function expectedFixedLen(spec: FieldSpec): number {
  // For binary FIXED fields, length is in *bytes*; we encode as hex → ×2.
  if (spec.type === 'b' && spec.kind === 'FIXED') return spec.length * 2;
  return spec.length;
}

function encodeBody(spec: FieldSpec, value: FieldValue | Buffer): string {
  if (spec.type === 'b') {
    const hex = Buffer.isBuffer(value) ? value.toString('hex') : String(value);
    if (!/^[0-9a-fA-F]*$/.test(hex)) throw new Error(`DE ${spec.de}: invalid hex for binary field`);
    return hex.toUpperCase();
  }
  if (typeof value !== 'string') throw new Error(`DE ${spec.de}: expected string`);
  if (spec.type === 'n' && !/^\d*$/.test(value)) throw new Error(`DE ${spec.de}: non-numeric value`);
  if (spec.type === 'an' && !/^[A-Za-z0-9 ]*$/.test(value)) throw new Error(`DE ${spec.de}: non-an value`);
  if (spec.type === 'z' && !/^[0-9D=]*$/.test(value)) throw new Error(`DE ${spec.de}: invalid track data`);
  return value;
}

function decodeBody(spec: FieldSpec, body: string): FieldValue | Buffer {
  if (spec.type === 'b') return Buffer.from(body, 'hex');
  return body;
}
