import type { DecryptOptions, EncryptOptions, EncryptedBlob, HmacOptions, KmsProvider } from './types.js';

/**
 * Interface stub. Wires up to AWS KMS when we're ready to swap in a real HSM-backed
 * provider. Phase 0 deliberately ships only the shape; throwing on use keeps anyone
 * from accidentally relying on it in dev or tests.
 *
 * When implemented, this will lean on @aws-sdk/client-kms with `Encrypt`, `Decrypt`,
 * `GenerateMac`, `VerifyMac` operations. Key id is the AWS KMS key ARN.
 */
export class AwsKmsProvider implements KmsProvider {
  constructor(_opts: { region: string; keyArn: string }) {
    /* params captured for the future implementation; not used yet */
  }

  activeKeyId(): Promise<string> {
    throw new Error('AwsKmsProvider is not implemented in Phase 0. Use LocalKmsProvider in dev.');
  }
  encrypt(_p: Uint8Array, _o?: EncryptOptions): Promise<EncryptedBlob> {
    throw new Error('AwsKmsProvider is not implemented in Phase 0.');
  }
  decrypt(_b: EncryptedBlob, _o?: DecryptOptions): Promise<Uint8Array> {
    throw new Error('AwsKmsProvider is not implemented in Phase 0.');
  }
  hmac(_d: Uint8Array, _o?: HmacOptions): Promise<Uint8Array> {
    throw new Error('AwsKmsProvider is not implemented in Phase 0.');
  }
  verifyHmac(_d: Uint8Array, _s: Uint8Array, _o?: HmacOptions): Promise<boolean> {
    throw new Error('AwsKmsProvider is not implemented in Phase 0.');
  }
}
