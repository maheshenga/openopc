import { describe, expect, test } from 'bun:test';

import {
  type ModuleServiceCapabilityClaimsV1,
  ModuleServiceCapabilityClaimsV1Schema,
  ModuleServiceCapabilityRequestSchema,
  ModuleServiceConsentDeleteInputSchema,
  ModuleServiceErrorResponseSchema,
  OpenOpcServiceOperationSchema,
  parseModuleServiceCapabilityClaims,
  parseModuleServiceConsentPutInput,
} from './module-services';

const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const PROJECT_ID = '20000000-0000-4000-a000-000000000001';
const INSTALLATION_ID = '30000000-0000-4000-a000-000000000001';
const RELEASE_ID = '40000000-0000-4000-a000-000000000001';
const CONSENT_ID = '50000000-0000-4000-a000-000000000001';

function claims(): ModuleServiceCapabilityClaimsV1 {
  return {
    schemaVersion: 1,
    iss: 'openopc-control-plane',
    aud: 'openopc:module-service',
    jti: '00000000-0000-4000-8000-000000000001',
    iat: '2026-08-01T00:00:00.000Z',
    exp: '2026-08-01T00:05:00.000Z',
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    installationId: INSTALLATION_ID,
    installRevision: 4,
    releaseId: RELEASE_ID,
    moduleId: 'example.weather-station',
    moduleVersion: '1.2.3',
    consentId: CONSENT_ID,
    grantId: '00000000-0000-4000-8000-000000000002',
    service: 'ai',
    operations: ['models.read', 'text.generate'],
  };
}

describe('module service wire contract', () => {
  test('accepts only the six public operation identifiers', () => {
    for (const operation of [
      'models.read',
      'text.generate',
      'text.stream',
      'orders.create',
      'orders.read',
      'refunds.create',
    ]) {
      expect(OpenOpcServiceOperationSchema.safeParse(operation).success).toBe(true);
    }
    expect(OpenOpcServiceOperationSchema.safeParse('orders.close').success).toBe(false);
  });

  test('rejects a payment operation requested through the AI service', () => {
    expect(
      ModuleServiceCapabilityRequestSchema.safeParse({
        service: 'ai',
        operations: ['models.read', 'text.generate'],
      }).success,
    ).toBe(true);
    expect(
      ModuleServiceCapabilityRequestSchema.safeParse({
        service: 'ai',
        operations: ['orders.create'],
      }).success,
    ).toBe(false);
  });

  test('rejects an AI operation requested through the payment service', () => {
    expect(
      ModuleServiceCapabilityRequestSchema.safeParse({
        service: 'payment',
        operations: ['orders.create', 'orders.read', 'refunds.create'],
      }).success,
    ).toBe(true);
    expect(
      ModuleServiceCapabilityRequestSchema.safeParse({
        service: 'payment',
        operations: ['text.generate'],
      }).success,
    ).toBe(false);
  });

  test('requires a non-empty unique operation set', () => {
    expect(
      ModuleServiceCapabilityRequestSchema.safeParse({ service: 'ai', operations: [] }).success,
    ).toBe(false);
    expect(
      ModuleServiceCapabilityRequestSchema.safeParse({
        service: 'ai',
        operations: ['models.read', 'models.read'],
      }).success,
    ).toBe(false);
  });

  test('parses the exact v1 capability claim and rejects cross-service or extra data', () => {
    expect(parseModuleServiceCapabilityClaims(claims())).toEqual(claims());
    expect(
      ModuleServiceCapabilityClaimsV1Schema.safeParse({
        ...claims(),
        operations: ['orders.read'],
      }).success,
    ).toBe(false);
    expect(
      ModuleServiceCapabilityClaimsV1Schema.safeParse({
        ...claims(),
        provider_url: 'https://new-api.example.com',
      }).success,
    ).toBe(false);
  });

  test('parses consent input against the path service without accepting an account id', () => {
    expect(
      parseModuleServiceConsentPutInput('ai', {
        operations: ['models.read', 'text.generate'],
        expected_install_revision: 4,
      }),
    ).toEqual({
      operations: ['models.read', 'text.generate'],
      expected_install_revision: 4,
    });
    expect(() =>
      parseModuleServiceConsentPutInput('ai', {
        operations: ['orders.create'],
        expected_install_revision: 4,
      }),
    ).toThrow();
    expect(() =>
      parseModuleServiceConsentPutInput('ai', {
        operations: ['models.read'],
        expected_install_revision: 4,
        account_id: ACCOUNT_ID,
      }),
    ).toThrow();
  });

  test('requires a positive revision for consent revocation', () => {
    expect(
      ModuleServiceConsentDeleteInputSchema.safeParse({ expected_install_revision: 4 }).success,
    ).toBe(true);
    expect(
      ModuleServiceConsentDeleteInputSchema.safeParse({ expected_install_revision: 0 }).success,
    ).toBe(false);
  });

  test('recognizes stable module service errors and rejects provider-shaped errors', () => {
    expect(
      ModuleServiceErrorResponseSchema.safeParse({
        error: 'MODULE_SERVICE_CAPABILITY_EXPIRED',
      }).success,
    ).toBe(true);
    expect(
      ModuleServiceErrorResponseSchema.safeParse({
        error: 'NEW_API_KEY_INVALID',
        provider_url: 'https://new-api.example.com',
      }).success,
    ).toBe(false);
  });
});
