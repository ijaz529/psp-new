import { decodeBitmap, encodeBitmap } from './bitmap.js';
import { type FieldValue, decodeField, encodeField } from './fields.js';

/** Common ISO 8583 MTIs we care about. */
export type Mti =
  | '0100'
  | '0110'
  | '0101'
  | '0120'
  | '0121'
  | '0200'
  | '0210'
  | '0220'
  | '0221'
  | '0230'
  | '0400'
  | '0410'
  | '0420'
  | '0421'
  | '0430'
  | '0500'
  | '0510'
  | '0520'
  | '0521'
  | '0523'
  | '0800'
  | '0810'
  | '0820'
  | '0821';

export interface Iso8583Message {
  readonly mti: Mti;
  /** Map of DE → value. Bitmap is computed; do not include DE 1. */
  readonly fields: ReadonlyMap<number, FieldValue | Buffer>;
}

/**
 * Encode a message to its ASCII wire form. The result is suitable for the
 * 4-byte length-prefix framing in @psp-new/scheme-simulator's frame reader.
 */
export function encode(msg: Iso8583Message): string {
  if (!/^\d{4}$/.test(msg.mti)) throw new Error(`bad MTI: ${msg.mti}`);
  const sortedDes = [...msg.fields.keys()].filter((de) => de !== 1).sort((a, b) => a - b);
  const bitmap = encodeBitmap(sortedDes);
  let body = '';
  for (const de of sortedDes) {
    const v = msg.fields.get(de)!;
    body += encodeField(de, v);
  }
  return msg.mti + bitmap + body;
}

export function decode(input: string): Iso8583Message {
  if (input.length < 4) throw new Error('ISO 8583: input too short for MTI');
  const mti = input.slice(0, 4) as Mti;
  if (!/^\d{4}$/.test(mti)) throw new Error(`bad MTI: ${mti}`);
  const bm = decodeBitmap(input, 4);
  let offset = 4 + bm.hexLen;
  const fields = new Map<number, FieldValue | Buffer>();
  for (const de of bm.present) {
    const r = decodeField(de, input, offset);
    fields.set(de, r.value);
    offset += r.consumed;
  }
  if (offset !== input.length) {
    throw new Error(`ISO 8583: ${input.length - offset} trailing characters after last field`);
  }
  return { mti, fields };
}

/** Builder helper — most call sites prefer this over raw `new Map`. */
export function buildMessage(mti: Mti, fields: Record<number, FieldValue | Buffer>): Iso8583Message {
  const m = new Map<number, FieldValue | Buffer>();
  for (const [k, v] of Object.entries(fields)) m.set(Number(k), v);
  return { mti, fields: m };
}
