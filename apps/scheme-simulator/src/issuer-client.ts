import net from 'node:net';

/**
 * Persistent TCP client to issuer-host. Mirrors the acquirer-host → scheme-sim
 * client (apps/acquirer-host/src/client.ts): one socket, sequential requests,
 * 4-byte ASCII length framing. Re-connects on disconnect with a small backoff.
 */

export interface IssuerClient {
  send(reqBytes: string): Promise<string>;
  close(): void;
  isConnected(): boolean;
}

interface Pending {
  resolve: (response: string) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

const FRAME_HEADER_LEN = 4;
const DEFAULT_TIMEOUT_MS = 15_000;

export function createIssuerClient(opts: { host: string; port: number }): IssuerClient {
  let socket: net.Socket | null = null;
  let connected = false;
  let queue: Pending | null = null;
  let buf = Buffer.alloc(0);
  let reconnectTimer: NodeJS.Timeout | null = null;

  function failPending(err: Error): void {
    if (queue) {
      clearTimeout(queue.timer);
      queue.reject(err);
      queue = null;
    }
  }

  function connect(): void {
    if (socket) return;
    const s = net.createConnection({ host: opts.host, port: opts.port });
    s.on('connect', () => {
      connected = true;
    });
    s.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= FRAME_HEADER_LEN) {
        const lenStr = buf.subarray(0, FRAME_HEADER_LEN).toString('ascii');
        const len = Number.parseInt(lenStr, 10);
        if (!Number.isFinite(len) || len <= 0) {
          failPending(new Error(`bad frame length: ${lenStr}`));
          s.destroy();
          return;
        }
        if (buf.length < FRAME_HEADER_LEN + len) return;
        const body = buf.subarray(FRAME_HEADER_LEN, FRAME_HEADER_LEN + len).toString('ascii');
        buf = buf.subarray(FRAME_HEADER_LEN + len);
        if (queue) {
          clearTimeout(queue.timer);
          queue.resolve(body);
          queue = null;
        }
      }
    });
    s.on('error', (err) => {
      connected = false;
      failPending(err);
    });
    s.on('close', () => {
      connected = false;
      socket = null;
      failPending(new Error('issuer-host connection closed'));
      // Backoff reconnect
      if (!reconnectTimer) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          connect();
        }, 1_000);
      }
    });
    socket = s;
  }

  connect();

  return {
    send(reqBytes) {
      if (!socket || !connected) {
        return Promise.reject(new Error('issuer-host not connected'));
      }
      if (queue) {
        return Promise.reject(new Error('issuer-host client is busy (concurrent request)'));
      }
      const frame = Buffer.from(reqBytes.length.toString().padStart(FRAME_HEADER_LEN, '0') + reqBytes, 'ascii');
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          failPending(new Error(`issuer-host timeout after ${DEFAULT_TIMEOUT_MS}ms`));
        }, DEFAULT_TIMEOUT_MS);
        queue = { resolve, reject, timer };
        socket?.write(frame);
      });
    },
    isConnected() {
      return connected;
    },
    close() {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.destroy();
    },
  };
}
