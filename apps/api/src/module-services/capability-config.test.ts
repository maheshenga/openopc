import { describe, expect, test } from 'bun:test';
import { generateKeys } from 'paseto-ts/v4';

import { createConfiguredModuleServiceCapabilityBroker } from './capability-config';
import type { ModuleServiceCapabilityRepository } from './capability-grants';
import { ModuleServiceCapabilityBroker } from './capability-grants';

const repository = {} as ModuleServiceCapabilityRepository;

function encode(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

function configuredEnvironment(keys = generateKeys('public')) {
  return {
    OPENOPC_MODULE_SERVICE_CAPABILITY_KEY_ID: 'openopc-module-service-test-primary',
    OPENOPC_MODULE_SERVICE_CAPABILITY_PRIVATE_KEY_BASE64: encode(keys.secretKey),
    OPENOPC_MODULE_SERVICE_CAPABILITY_PUBLIC_KEY_BASE64: encode(keys.publicKey),
  };
}

describe('module service capability configuration', () => {
  test('enables the broker only for a canonical matching PASETO v4.public key pair', () => {
    const broker = createConfiguredModuleServiceCapabilityBroker(
      repository,
      configuredEnvironment(),
    );

    expect(broker).toBeInstanceOf(ModuleServiceCapabilityBroker);
  });

  test('keeps service capabilities unavailable for missing, malformed, or mismatched keys', () => {
    const first = generateKeys('public');
    const second = generateKeys('public');
    const valid = configuredEnvironment(first);
    const invalidEnvironments = [
      {},
      { OPENOPC_MODULE_SERVICE_CAPABILITY_KEY_ID: valid.OPENOPC_MODULE_SERVICE_CAPABILITY_KEY_ID },
      {
        ...valid,
        OPENOPC_MODULE_SERVICE_CAPABILITY_PRIVATE_KEY_BASE64: 'not-base64',
      },
      {
        ...valid,
        OPENOPC_MODULE_SERVICE_CAPABILITY_PRIVATE_KEY_BASE64: Buffer.from([0xff]).toString(
          'base64',
        ),
      },
      {
        ...valid,
        OPENOPC_MODULE_SERVICE_CAPABILITY_PUBLIC_KEY_BASE64: encode(second.publicKey),
      },
      {
        ...valid,
        OPENOPC_MODULE_SERVICE_CAPABILITY_KEY_ID: 'developer-release-signing-key',
      },
    ];

    for (const environment of invalidEnvironments) {
      expect(createConfiguredModuleServiceCapabilityBroker(repository, environment)).toBeNull();
    }
  });
});
