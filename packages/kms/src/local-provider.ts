import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DecryptOptions, EncryptOptions, EncryptedBlob, HmacOptions, KmsProvider } from './types.js';

/**
 * Local KMS — a software-only provider that holds a 32-byte master key in memory.
 * For dev and tests. Production should swap in an `AwsKmsProvider` (stub today)
 * via the `KMS_PROVIDER` env switch in `KmsFactory`.
 *
 * Format conventions:
 *   - AES-256-GCM: 12-byte nonce, 16-byte tag
 *   - HMAC-SHA256
 *   - Encoding: base64url, no padding
 *   - Blob value: `keyId.nonce.ciphertext.tag`
 */
export interface LocalKmsConfig {
  /** 32-byte key, base64-encoded. Multiple keys allowed for rotation. */
  readonly masterKeysB64: ReadonlyMap<string, string>;
  /** Which keyId is currently used for new operations. */
  readonly activeKeyId: string;
}

const KEY_LENGTH = 32;
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;

function b64url(buf: Uint8Array): string {
  return Buffer.from(buf).toString('base64url');
}

function fromB64url(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'base64url'));
}

export class LocalKmsProvider implements KmsProvider {
  private readonly keys: ReadonlyMap<string, Uint8Array>;
  private readonly activeKey: string;

  constructor(cfg: LocalKmsConfig) {
    const keys = new Map<string, Uint8Array>();
    for (const [id, b64] of cfg.masterKeysB64) {
      const buf = new Uint8Array(Buffer.from(b64, 'base64'));
      if (buf.length !== KEY_LENGTH) {
        throw new Error(`KMS key '${id}' must be ${KEY_LENGTH} bytes after base64 decode (got ${buf.length})`);
      }
      keys.set(id, buf);
    }
    if (!keys.has(cfg.activeKeyId)) {
      throw new Error(`active key id '${cfg.activeKeyId}' not present in masterKeysB64`);
    }
    this.keys = keys;
    this.activeKey = cfg.activeKeyId;
  }

  async activeKeyId(): Promise<string> {
    return this.activeKey;
  }

  async encrypt(plaintext: Uint8Array, opts: EncryptOptions = {}): Promise<EncryptedBlob> {
    const keyId = this.activeKey;
    const key = this.keys.get(keyId);
    if (!key) throw new Error('invariant: active key missing from key set');
    const nonce = randomBytes(NONCE_LENGTH);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    if (opts.aad) cipher.setAAD(Buffer.from(opts.aad));
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return { value: `${keyId}.${b64url(nonce)}.${b64url(ct)}.${b64url(tag)}`, keyId };
  }

  async decrypt(blob: EncryptedBlob, opts: DecryptOptions = {}): Promise<Uint8Array> {
    const parts = blob.value.split('.');
    if (parts.length !== 4) throw new Error('malformed KMS blob');
    const [keyId, nonceB, ctB, tagB] = parts as [string, string, string, string];
    const key = this.keys.get(keyId);
    if (!key) throw new Error(`unknown key id: ${keyId}`);
    const nonce = fromB64url(nonceB);
    const ct = fromB64url(ctB);
    const tag = fromB64url(tagB);
    if (tag.length !== TAG_LENGTH) throw new Error('bad GCM tag length');
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(tag);
    if (opts.aad) decipher.setAAD(Buffer.from(opts.aad));
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return new Uint8Array(pt);
  }

  async hmac(data: Uint8Array, opts: HmacOptions = {}): Promise<Uint8Array> {
    const keyId = opts.keyId ?? this.activeKey;
    const key = this.keys.get(keyId);
    if (!key) throw new Error(`unknown key id: ${keyId}`);
    return new Uint8Array(createHmac('sha256', key).update(data).digest());
  }

  async verifyHmac(data: Uint8Array, signature: Uint8Array, opts: HmacOptions = {}): Promise<boolean> {
    const expected = await this.hmac(data, opts);
    if (expected.length !== signature.length) return false;
    return timingSafeEqual(expected, signature);
  }
}

/**
 * Build a LocalKmsProvider from the env-shaped single-key form used in dev.
 *   KMS_LOCAL_MASTER_KEY=<base64 of 32 bytes>
 *   KMS_LOCAL_ACTIVE_KEY_ID=local-v1   (optional; defaults to 'local-v1')
 */
export function localKmsFromEnv(env: NodeJS.ProcessEnv = process.env): LocalKmsProvider {
  const b64 = env.KMS_LOCAL_MASTER_KEY;
  if (!b64) throw new Error('KMS_LOCAL_MASTER_KEY is required when KMS_PROVIDER=local');
  const id = env.KMS_LOCAL_ACTIVE_KEY_ID ?? 'local-v1';
  return new LocalKmsProvider({ masterKeysB64: new Map([[id, b64]]), activeKeyId: id });
}
