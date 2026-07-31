import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  OPENOPC_RESTRICTED_PUBLIC_BETA_PROFILE,
  OPENOPC_RESTRICTED_PUBLIC_BETA_PROFILE_DIGEST,
  computeOpenOpcRestrictedPublicBetaProfileDigest,
  parseOpenOpcRestrictedPublicBetaProfile,
} from './public-beta-release-profile';

const ARTIFACTS = [
  'web',
  'admin',
  'api',
  'studio-worker',
  'developer-trust-worker',
  'wasi-runner',
  'desktop',
] as const;
const REQUIRED_GATES = [
  'G1',
  'G2',
  'G3',
  'G4',
  'G5',
  'G8',
  'G10',
  'G11',
  'G12',
  'B1',
  'B2',
  'B3',
  'B4',
  'B5',
  'B7',
  'B8',
  'B9',
  'B10',
] as const;
const DEFERRED_GATES = ['G6', 'G7', 'G9', 'B6'] as const;

function profileValue(): Record<string, unknown> {
  return structuredClone(OPENOPC_RESTRICTED_PUBLIC_BETA_PROFILE) as Record<string, unknown>;
}

describe('OpenOpc restricted public beta profile', () => {
  test('owns one immutable seven-artifact restricted profile', () => {
    const profile = parseOpenOpcRestrictedPublicBetaProfile(profileValue());

    expect(profile).toEqual({
      schemaVersion: 1,
      id: 'openopc-restricted-public-beta-v1',
      artifacts: ARTIFACTS,
      requiredGates: REQUIRED_GATES,
      deferredGates: DEFERRED_GATES,
    });
    expect(Object.isFrozen(profile)).toBe(true);
    expect(Object.isFrozen(profile.artifacts)).toBe(true);
    expect(Object.isFrozen(profile.requiredGates)).toBe(true);
    expect(Object.isFrozen(profile.deferredGates)).toBe(true);
    expect(Reflect.set(profile, 'id', 'changed')).toBe(false);
    expect(Reflect.set(profile.artifacts, '0', 'runner')).toBe(false);
    expect(profile.id).toBe('openopc-restricted-public-beta-v1');
    expect(profile.artifacts[0]).toBe('web');
    expect(computeOpenOpcRestrictedPublicBetaProfileDigest(profile)).toBe(
      OPENOPC_RESTRICTED_PUBLIC_BETA_PROFILE_DIGEST,
    );
  });

  test('accepts the exported profile only through an exact canonical shape', () => {
    expect(Object.keys(OPENOPC_RESTRICTED_PUBLIC_BETA_PROFILE).sort()).toEqual([
      'artifacts',
      'deferredGates',
      'id',
      'requiredGates',
      'schemaVersion',
    ]);
    expect(computeOpenOpcRestrictedPublicBetaProfileDigest(profileValue())).toBe(
      OPENOPC_RESTRICTED_PUBLIC_BETA_PROFILE_DIGEST,
    );
  });

  test.each([
    ['missing artifacts', { schemaVersion: 1, id: 'openopc-restricted-public-beta-v1', requiredGates: REQUIRED_GATES, deferredGates: DEFERRED_GATES }],
    ['extra key', { ...profileValue(), extra: true }],
    ['reordered artifacts', { ...profileValue(), artifacts: [...ARTIFACTS].reverse() }],
    ['complete artifact registry', { ...profileValue(), artifacts: [...ARTIFACTS, 'runner'] }],
    ['renamed artifact', { ...profileValue(), artifacts: [...ARTIFACTS.slice(0, 6), 'desktop-installer'] }],
    ['duplicate required gate', { ...profileValue(), requiredGates: [...REQUIRED_GATES.slice(0, -1), 'B9'] }],
    ['reordered required gates', { ...profileValue(), requiredGates: [...REQUIRED_GATES].reverse() }],
    ['deferred gate promoted', { ...profileValue(), requiredGates: [...REQUIRED_GATES, 'B6'], deferredGates: ['G6', 'G7', 'G9'] }],
    ['unknown deferred gate', { ...profileValue(), deferredGates: ['G6', 'G7', 'G9', 'B11'] }],
    ['wrong schema version', { ...profileValue(), schemaVersion: 2 }],
    ['wrong profile id', { ...profileValue(), id: 'openopc-public-beta-v1' }],
  ])('rejects %s', (_name, value) => {
    expect(() => parseOpenOpcRestrictedPublicBetaProfile(value)).toThrow(
      'OPENOPC_RESTRICTED_PUBLIC_BETA_PROFILE_INVALID',
    );
  });

  test('agrees with the checked-in v1 JSON schema', () => {
    const schemaPath = fileURLToPath(
      new URL('../../tests/public-beta/restricted-release-profile.v1.schema.json', import.meta.url),
    );
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as {
      properties: Record<string, { const?: unknown; prefixItems?: Array<{ const?: unknown }> }>;
    };
    expect(schema.properties.schemaVersion.const).toBe(1);
    expect(schema.properties.id.const).toBe('openopc-restricted-public-beta-v1');
    expect(schema.properties.artifacts.prefixItems?.map((item) => item.const)).toEqual([...ARTIFACTS]);
    expect(schema.properties.requiredGates.prefixItems?.map((item) => item.const)).toEqual([
      ...REQUIRED_GATES,
    ]);
    expect(schema.properties.deferredGates.prefixItems?.map((item) => item.const)).toEqual([
      ...DEFERRED_GATES,
    ]);
  });
});
