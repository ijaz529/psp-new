import { AwsKmsProvider } from './aws-provider.js';
import { localKmsFromEnv } from './local-provider.js';
import type { KmsProvider } from './types.js';

export * from './types.js';
export { LocalKmsProvider, localKmsFromEnv } from './local-provider.js';
export { AwsKmsProvider } from './aws-provider.js';

/**
 * Factory that picks the provider from env. Apps construct this once at boot.
 */
export function createKmsProviderFromEnv(env: NodeJS.ProcessEnv = process.env): KmsProvider {
  const which = (env.KMS_PROVIDER ?? 'local').toLowerCase();
  switch (which) {
    case 'local':
      return localKmsFromEnv(env);
    case 'aws':
      if (!env.AWS_REGION || !env.KMS_AWS_KEY_ARN) {
        throw new Error('AWS_REGION and KMS_AWS_KEY_ARN required when KMS_PROVIDER=aws');
      }
      return new AwsKmsProvider({ region: env.AWS_REGION, keyArn: env.KMS_AWS_KEY_ARN });
    default:
      throw new Error(`unknown KMS_PROVIDER: ${which}`);
  }
}
