import { createPrivateKey, createPublicKey, timingSafeEqual } from 'node:crypto';

import { DeveloperModuleDistributionError } from './distribution';
import { type ModuleSigningPort, createEd25519ModuleSigningPort } from './module-signing';

const MAX_ENCODED_KEY_BYTES = 8_192;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export type ModuleSignerConfig = {
  enabled: boolean;
  keyId?: string;
  privateKeyBase64?: string;
  publicKeyBase64?: string;
};

export type ModuleSignerEnvironment = Readonly<{
  OPENOPC_DEVELOPER_MODULE_DISTRIBUTION_ENABLED?: string;
  KORTIX_DEVELOPER_MODULE_DISTRIBUTION_ENABLED?: string;
  OPENOPC_DEVELOPER_MODULE_SIGNING_KEY_ID?: string;
  KORTIX_DEVELOPER_MODULE_SIGNING_KEY_ID?: string;
  OPENOPC_DEVELOPER_MODULE_SIGNING_PRIVATE_KEY_BASE64?: string;
  KORTIX_DEVELOPER_MODULE_SIGNING_PRIVATE_KEY_BASE64?: string;
  OPENOPC_DEVELOPER_MODULE_SIGNING_PUBLIC_KEY_BASE64?: string;
  KORTIX_DEVELOPER_MODULE_SIGNING_PUBLIC_KEY_BASE64?: string;
}>;

function enabled(value: string | undefined): boolean {
  return value !== undefined && ['true', '1', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function firstConfigured(
  primary: string | undefined,
  fallback: string | undefined,
): string | undefined {
  return primary !== undefined && primary.length > 0 ? primary : fallback;
}

export function resolveModuleSignerConfig(
  environment: ModuleSignerEnvironment,
): ModuleSignerConfig {
  return {
    enabled: enabled(
      environment.OPENOPC_DEVELOPER_MODULE_DISTRIBUTION_ENABLED ??
        environment.KORTIX_DEVELOPER_MODULE_DISTRIBUTION_ENABLED,
    ),
    keyId: firstConfigured(
      environment.OPENOPC_DEVELOPER_MODULE_SIGNING_KEY_ID,
      environment.KORTIX_DEVELOPER_MODULE_SIGNING_KEY_ID,
    ),
    privateKeyBase64: firstConfigured(
      environment.OPENOPC_DEVELOPER_MODULE_SIGNING_PRIVATE_KEY_BASE64,
      environment.KORTIX_DEVELOPER_MODULE_SIGNING_PRIVATE_KEY_BASE64,
    ),
    publicKeyBase64: firstConfigured(
      environment.OPENOPC_DEVELOPER_MODULE_SIGNING_PUBLIC_KEY_BASE64,
      environment.KORTIX_DEVELOPER_MODULE_SIGNING_PUBLIC_KEY_BASE64,
    ),
  };
}

function unavailable(): never {
  throw new DeveloperModuleDistributionError('DEVELOPER_MODULE_SIGNER_UNAVAILABLE', 503);
}

function decodeBase64(value: string | undefined): Buffer {
  if (
    !value ||
    value.length > MAX_ENCODED_KEY_BYTES ||
    value.length % 4 !== 0 ||
    !BASE64.test(value)
  ) {
    unavailable();
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length === 0 || decoded.toString('base64') !== value) unavailable();
  return decoded;
}

export function createConfiguredModuleSigningPort(
  config: ModuleSignerConfig,
): ModuleSigningPort | null {
  if (!config.enabled) return null;
  try {
    const privateKey = createPrivateKey({
      key: decodeBase64(config.privateKeyBase64),
      format: 'der',
      type: 'pkcs8',
    });
    const publicKey = createPublicKey({
      key: decodeBase64(config.publicKeyBase64),
      format: 'der',
      type: 'spki',
    });
    const derivedPublicKey = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
    const configuredPublicKey = publicKey.export({ format: 'der', type: 'spki' });
    if (
      derivedPublicKey.length !== configuredPublicKey.length ||
      !timingSafeEqual(derivedPublicKey, configuredPublicKey)
    ) {
      unavailable();
    }
    return createEd25519ModuleSigningPort({
      keyId: config.keyId ?? '',
      privateKey,
      publicKey,
    });
  } catch {
    unavailable();
  }
}
