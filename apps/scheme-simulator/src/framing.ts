/**
 * 4-byte ASCII length prefix framing per PROJECT_BRIEF.md §3 Phase 5.
 * On the wire: "0042"<body of 42 bytes>"0019"<body of 19 bytes>...
 *
 * Phase 0 only implements the framing layer — no 8583 message parsing. Phase 5
 * will lift the body bytes into the codec.
 *
 * The reader returns whole frames; partial reads accumulate in a buffer.
 */
export interface FrameReader {
  /** Push raw bytes from a socket. Returns whole frames (without the length prefix). */
  push(chunk: Buffer): Buffer[];
}

export function createFrameReader(): FrameReader {
  let buf = Buffer.alloc(0);
  return {
    push(chunk) {
      buf = Buffer.concat([buf, chunk]);
      const frames: Buffer[] = [];
      while (buf.length >= 4) {
        const lenStr = buf.subarray(0, 4).toString('ascii');
        if (!/^\d{4}$/.test(lenStr)) {
          // Stream desync — drop the connection by clearing the buffer.
          buf = Buffer.alloc(0);
          throw new Error(`malformed frame length prefix: "${lenStr}"`);
        }
        const len = Number.parseInt(lenStr, 10);
        if (buf.length < 4 + len) break; // wait for more data
        frames.push(buf.subarray(4, 4 + len));
        buf = buf.subarray(4 + len);
      }
      return frames;
    },
  };
}

export function encodeFrame(body: Buffer): Buffer {
  if (body.length > 9999) throw new RangeError('frame body exceeds 9999 bytes');
  const header = Buffer.from(body.length.toString().padStart(4, '0'), 'ascii');
  return Buffer.concat([header, body]);
}
