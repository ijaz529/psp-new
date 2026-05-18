/**
 * The narrow KMS surface we use everywhere. Concrete providers (local, AWS, GCP)
 * implement this interface. App code depends on the interface, not a provider.
 *
 * Why a tiny surface? Because the same interface should work for:
 *   - encrypt-at-rest of vault tokens (vaultful path, deferred)
 *   - HMAC keys for vaultless tokenization (Phase 2)
 *   - signing webhook secrets per merchant
 *   - signing service-to-service auth tokens
 *
 * If a method belongs only to one use case, it does NOT live here.
 */
export interface KmsProvider {
  /** Identifier of the master key currently in active rotation. */
  activeKeyId(): Promise<string>;

  /** AES-256-GCM with an embedded nonce. Output: keyId|nonce|ciphertext|tag, base64url. */
  encrypt(plaintext: Uint8Array, opts?: EncryptOptions): Promise<EncryptedBlob>;
  /**
   * Decrypt a blob. If the blob was encrypted with AAD, the same AAD bytes
   * must be supplied here — the GCM tag will fail otherwise.
   */
  decrypt(blob: EncryptedBlob, opts?: DecryptOptions): Promise<Uint8Array>;

  /** HMAC-SHA256. Used for vaultless tokenization and signing. */
  hmac(data: Uint8Array, opts?: HmacOptions): Promise<Uint8Array>;
  verifyHmac(data: Uint8Array, signature: Uint8Array, opts?: HmacOptions): Promise<boolean>;
}

export interface EncryptOptions {
  /** Optional Associated Data for AEAD; included in MAC, not in ciphertext. */
  readonly aad?: Uint8Array;
}

export interface DecryptOptions {
  /** Must match the AAD used at encryption time. */
  readonly aad?: Uint8Array;
}

export interface HmacOptions {
  /** Allow a specific key id (e.g., a previous rotation); defaults to activeKeyId. */
  readonly keyId?: string;
}

export interface EncryptedBlob {
  /** Wire format: `{keyId}.{nonceB64}.{ciphertextB64}.{tagB64}` */
  readonly value: string;
  /** Key id used. Useful when rotating. */
  readonly keyId: string;
}
