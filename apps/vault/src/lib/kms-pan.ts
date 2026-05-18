import type { KmsProvider } from '@psp-new/kms';

/**
 * Encode a PAN as bytes for KMS operations. Wraps `TextEncoder` so callers
 * don't accidentally pass a raw string into a KMS API. Mark the return type
 * so reviewers can grep for "this byte buffer is PAN-sensitive".
 */
function panToBytes(pan: string): Uint8Array {
  return new TextEncoder().encode(pan);
}

/**
 * Merchant-scoped HMAC of the PAN. Same merchant + same PAN → same HMAC
 * (used for unique-index dedup). Different merchants → different HMACs (no
 * cross-merchant correlation).
 *
 * The scoping is achieved by prepending the merchant_id to the HMAC input;
 * the KMS key is the shared master key.
 */
export async function panHmacScoped(kms: KmsProvider, merchantId: string, pan: string): Promise<string> {
  const buf = new TextEncoder().encode(`${merchantId}|`);
  const data = new Uint8Array(buf.length + pan.length);
  data.set(buf, 0);
  data.set(panToBytes(pan), buf.length);
  const out = await kms.hmac(data);
  return Buffer.from(out).toString('hex');
}

/**
 * Encrypt the PAN bound to the merchant id (AAD). Decryption requires the same
 * merchant id, so a token blob copied across merchants is unrecoverable.
 */
export async function encryptPan(
  kms: KmsProvider,
  merchantId: string,
  pan: string,
): Promise<{ value: string; keyId: string }> {
  const aad = new TextEncoder().encode(merchantId);
  return kms.encrypt(panToBytes(pan), { aad });
}

export async function decryptPan(
  kms: KmsProvider,
  merchantId: string,
  blobValue: string,
  keyId: string,
): Promise<string> {
  // The merchant id was AAD at encryption time. The GCM tag will fail to
  // verify if a different merchant id is passed here — guaranteeing a token
  // ciphertext can't be decrypted out of its merchant context.
  const aad = new TextEncoder().encode(merchantId);
  const out = await kms.decrypt({ value: blobValue, keyId }, { aad });
  return new TextDecoder().decode(out);
}
