import { describe, expect, test } from 'bun:test';

import { type CapabilityTokenClaimsV1, parseCapabilityTokenClaims } from './capability-token';

const SHA = `sha256:${'a'.repeat(64)}` as const;

function claims(): CapabilityTokenClaimsV1 {
  return {
    capabilityVersion: 1,
    iss: 'openopc-control-plane',
    aud: 'openopc:capability/egress',
    sub: '80000000-0000-4000-a000-000000000001',
    jti: 'a0000000-0000-4000-8000-000000000001',
    iat: '2026-07-27T08:00:00.000Z',
    exp: '2026-07-27T08:00:20.000Z',
    grantId: 'a1000000-0000-4000-8000-000000000001',
    accountId: '10000000-0000-4000-a000-000000000001',
    projectId: '20000000-0000-4000-a000-000000000001',
    installationId: '30000000-0000-4000-a000-000000000001',
    releaseDigest: SHA,
    actor: { type: 'runner', id: '70000000-0000-4000-a000-000000000001' },
    action: 'http.request',
    runtimeKind: 'wasi-component',
    lease: {
      id: '90000000-0000-4000-a000-000000000001',
      generation: 3,
      deadline: '2026-07-27T08:00:30.000Z',
    },
    killSwitchGeneration: 4,
    cnf: { certificateSha256: 'b'.repeat(64) },
    ceilings: {
      maxCalls: 1,
      maxRequestBytes: 65_536,
      maxResponseBytes: 262_144,
      cpuMillis: 2_000,
      wallTimeMs: 5_000,
      costMicro: 50_000,
    },
    egress: {
      origins: ['https://api.example.com'],
      methods: ['POST'],
    },
  };
}

describe('module capability token claims', () => {
  test('parses the exact tenant, release, lease, certificate, and ceiling binding', () => {
    expect(parseCapabilityTokenClaims(claims())).toEqual(claims());
  });

  test.each([
    ['unknown field', { ...claims(), rawSecret: 'must-not-pass' }],
    ['expiry beyond lease', { ...claims(), exp: '2026-07-27T08:00:31.000Z' }],
    [
      'non-https origin',
      { ...claims(), egress: { origins: ['http://api.example.com'], methods: ['POST'] } },
    ],
    [
      'private literal origin',
      { ...claims(), egress: { origins: ['https://127.0.0.1'], methods: ['POST'] } },
    ],
    [
      'duplicate method',
      { ...claims(), egress: { origins: ['https://api.example.com'], methods: ['POST', 'POST'] } },
    ],
    ['zero calls', { ...claims(), ceilings: { ...claims().ceilings, maxCalls: 0 } }],
    ['invalid certificate thumbprint', { ...claims(), cnf: { certificateSha256: 'unsafe' } }],
  ])('rejects %s', (_name, value) => {
    expect(() => parseCapabilityTokenClaims(value)).toThrow('CAPABILITY_TOKEN_CLAIMS_INVALID');
  });
});
