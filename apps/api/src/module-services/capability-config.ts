import { timingSafeEqual } from 'node:crypto';

import {
  ModuleServiceCapabilityBroker,
  type ModuleServiceCapabilityRepository,
} from './capability-grants';

const MAX_ENCODED_KEY_BYTES = 512;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export type ModuleServiceCapabilityEnvironment = Readonly<{
  OPENOPC_MODULE_SERVICE_CAPABILITY_KEY_ID?: string;
  OPENOPC_MODULE_SERVICE_CAPABILITY_PRIVATE_KEY_BASE64?: string;
  OPENOPC_MODULE_SERVICE_CAPABILITY_PUBLIC_KEY_BASE64?: string;
}>;

function decodePaserk(
  value: string | undefined,
  prefix: 'k4.secret.' | 'k4.public.',
  expectedBytes: number,
): { encoded: string; bytes: Buffer } | null {
  if (
    !value ||
    value.length > MAX_ENCODED_KEY_BYTES ||
    value.length % 4 !== 0 ||
    !BASE64.test(value)
  ) {
    return null;
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length === 0 || decoded.toString('base64') !== value) return null;
  const encoded = decoded.toString('utf8');
  const encodedBytes = Buffer.from(encoded, 'utf8');
  if (
    decoded.length !== encodedBytes.length ||
    !timingSafeEqual(decoded, encodedBytes) ||
    !encoded.startsWith(prefix)
  ) {
    return null;
  }
  const payload = encoded.slice(prefix.length);
  if (!/^[A-Za-z0-9_-]+$/.test(payload)) return null;
  const bytes = Buffer.from(payload, 'base64url');
  if (bytes.length !== expectedBytes || bytes.toString('base64url') !== payload) return null;
  return { encoded, bytes };
}

export function createConfiguredModuleServiceCapabilityBroker(
  repository: ModuleServiceCapabilityRepository,
  environment: ModuleServiceCapabilityEnvironment,
): ModuleServiceCapabilityBroker | null {
  const keyId = environment.OPENOPC_MODULE_SERVICE_CAPABILITY_KEY_ID;
  const secretKey = decodePaserk(
    environment.OPENOPC_MODULE_SERVICE_CAPABILITY_PRIVATE_KEY_BASE64,
    'k4.secret.',
    64,
  );
  const publicKey = decodePaserk(
    environment.OPENOPC_MODULE_SERVICE_CAPABILITY_PUBLIC_KEY_BASE64,
    'k4.public.',
    32,
  );
  if (
    !keyId ||
    !secretKey ||
    !publicKey ||
    !timingSafeEqual(secretKey.bytes.subarray(32), publicKey.bytes)
  ) {
    return null;
  }
  try {
    return new ModuleServiceCapabilityBroker({
      repository,
      keyId,
      secretKey: secretKey.encoded,
      publicKey: publicKey.encoded,
    });
  } catch {
    return null;
  }
}
