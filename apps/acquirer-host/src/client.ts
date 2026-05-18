import net from 'node:net';
import { type Iso8583Message, buildMessage, decode, encode } from '@psp-new/iso8583';

const FRAME_LEN_BYTES = 4;

export interface SchemeClient {
  send(req: Iso8583Message): Promise<Iso8583Message>;
  close(): void;
  isConnected(): boolean;
}

export interface SchemeClientOptions {
  readonly host: string;
  readonly port: number;
  readonly timeoutMs?: number;
  readonly reconnectMs?: number;
}

/**
 * Sequential request/response 8583 client. One in-flight message per
 * connection; STAN is the natural correlation key but for Phase 5 MVP we
 * just queue responses in the order replies arrive (which is the order
 * requests went out, because we're sequential).
 *
 * The connection is persistent + auto-reconnecting. Phase 6 will add a
 * connection pool and 0800 network-management heartbeat.
 */
export function createSchemeClient(opts: SchemeClientOptions): SchemeClient {
  let socket: net.Socket | null = null;
  let buffer = Buffer.alloc(0);
  const pending: Array<(msg: Iso8583Message) => void> = [];
  let connecting: Promise<net.Socket> | null = null;

  function ensureConnected(): Promise<net.Socket> {
    if (socket && !socket.destroyed) return Promise.resolve(socket);
    if (connecting) return connecting;
    connecting = new Promise<net.Socket>((resolve, reject) => {
      const s = net.createConnection({ host: opts.host, port: opts.port });
      s.once('connect', () => {
        s.removeAllListeners('error');
        socket = s;
        connecting = null;
        s.on('data', (chunk) => {
          buffer = Buffer.concat([buffer, chunk]);
          drainBuffer();
        });
        s.on('close', () => {
          socket = null;
          // Reject all pending — the api will treat this as a timeout/decline.
          while (pending.length > 0) {
            const cb = pending.shift()!;
            cb(buildMessage('0110', { 39: '96' /* system malfunction */ }));
          }
        });
        s.on('error', () => {
          // swallowed; close handler fires next.
        });
        resolve(s);
      });
      s.once('error', (err) => {
        connecting = null;
        reject(err);
      });
    });
    return connecting;
  }

  function drainBuffer(): void {
    while (buffer.length >= FRAME_LEN_BYTES) {
      const lenStr = buffer.subarray(0, FRAME_LEN_BYTES).toString('ascii');
      if (!/^\d{4}$/.test(lenStr)) {
        // desync — discard and close
        buffer = Buffer.alloc(0);
        socket?.destroy();
        return;
      }
      const len = Number.parseInt(lenStr, 10);
      if (buffer.length < FRAME_LEN_BYTES + len) return;
      const body = buffer.subarray(FRAME_LEN_BYTES, FRAME_LEN_BYTES + len).toString('ascii');
      buffer = buffer.subarray(FRAME_LEN_BYTES + len);
      const cb = pending.shift();
      if (cb) {
        try {
          cb(decode(body));
        } catch {
          cb(buildMessage('0110', { 39: '96' }));
        }
      }
    }
  }

  return {
    async send(req) {
      const s = await ensureConnected();
      const body = encode(req);
      const frame = Buffer.from(body.length.toString().padStart(FRAME_LEN_BYTES, '0') + body, 'ascii');
      const timeoutMs = opts.timeoutMs ?? 15_000;
      return await new Promise<Iso8583Message>((resolve, reject) => {
        const timer = setTimeout(() => {
          // Pull our pending out and reject. Note: this leaves the simulator
          // potentially responding to a late request; the natural-ordering
          // pending queue won't be in sync. Real PSPs use STAN-keyed maps;
          // Phase 6 upgrades.
          const idx = pending.indexOf(resolveOnce);
          if (idx >= 0) pending.splice(idx, 1);
          reject(new Error('scheme timeout'));
        }, timeoutMs);
        const resolveOnce = (msg: Iso8583Message): void => {
          clearTimeout(timer);
          resolve(msg);
        };
        pending.push(resolveOnce);
        s.write(frame);
      });
    },
    close() {
      socket?.destroy();
    },
    isConnected() {
      return !!socket && !socket.destroyed;
    },
  };
}
