import { randomBytes } from 'node:crypto';
import { LocalKmsProvider } from '@psp-new/kms';
import { describe, expect, it } from 'vitest';
import { decryptPan, encryptPan, panHmacScoped } from './kms-pan.js';

function newKms(): LocalKmsProvider {
  const key = randomBytes(32).toString('base64');
  return new LocalKmsProvider({ masterKeysB64: new Map([['local-test', key]]), activeKeyId: 'local-test' });
}

describe('panHmacScoped', () => {
  it('same merchant + same PAN → same HMAC', async () => {
    const kms = newKms();
    const a = await panHmacScoped(kms, 'mrch_a', '4111111111111111');
    const b = await panHmacScoped(kms, 'mrch_a', '4111111111111111');
    expect(a).toBe(b);
  });

  it('different merchants → different HMACs (no cross-merchant correlation)', async () => {
    const kms = newKms();
    const a = await panHmacScoped(kms, 'mrch_a', '4111111111111111');
    const b = await panHmacScoped(kms, 'mrch_b', '4111111111111111');
    expect(a).not.toBe(b);
  });

  it('different PANs (same merchant) → different HMACs', async () => {
    const kms = newKms();
    const a = await panHmacScoped(kms, 'mrch_a', '4111111111111111');
    const b = await panHmacScoped(kms, 'mrch_a', '5555555555554444');
    expect(a).not.toBe(b);
  });

  it('output is hex', async () => {
    const kms = newKms();
    expect(await panHmacScoped(kms, 'mrch_a', '4111111111111111')).toMatch(/^[a-f0-9]+$/);
  });
});

describe('encryptPan / decryptPan', () => {
  it('roundtrip recovers the PAN', async () => {
    const kms = newKms();
    const enc = await encryptPan(kms, 'mrch_a', '4111111111111111');
    const recovered = await decryptPan(kms, 'mrch_a', enc.value, enc.keyId);
    expect(recovered).toBe('4111111111111111');
  });

  it('different merchants yield different ciphertexts for same PAN', async () => {
    const kms = newKms();
    const a = await encryptPan(kms, 'mrch_a', '4111111111111111');
    const b = await encryptPan(kms, 'mrch_b', '4111111111111111');
    expect(a.value).not.toBe(b.value);
  });

  it('blob value carries keyId', async () => {
    const kms = newKms();
    const enc = await encryptPan(kms, 'mrch_a', '4111111111111111');
    expect(enc.value.startsWith(`${enc.keyId}.`)).toBe(true);
  });
});
