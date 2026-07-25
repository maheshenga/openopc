import { describe, expect, test } from 'bun:test';

import { defineDeveloperTrustPolicy } from '../policy';
import { policyInput } from '../test-fixtures';
import { createDefaultSandboxProfile, createSandboxInput } from './profile';

const digest = (character: string) => `sha256:${character.repeat(64)}` as const;

describe('developer module sandbox profile', () => {
  test('creates an immutable non-root deny-by-default OCI profile', () => {
    const policy = defineDeveloperTrustPolicy(policyInput());
    const profile = createDefaultSandboxProfile(policy.sandboxProfiles['desktop-package']);

    expect(Object.isFrozen(profile)).toBe(true);
    expect(profile).toMatchObject({
      identity: { uid: 65532, gid: 65532 },
      rootFilesystem: { readOnly: true },
      scratch: { kind: 'tmpfs' },
      security: {
        capabilities: [],
        noNewPrivileges: true,
        seccompProfile: 'openopc-verification-v1',
        hostIpc: false,
        hostPid: false,
        hostNetwork: false,
      },
      limits: {
        cpuMillis: 1_000,
        memoryBytes: 512 * 1024 * 1024,
        pids: 128,
      },
    });
    expect(Object.isFrozen(profile.security)).toBe(true);
    expect(Object.isFrozen(profile.limits)).toBe(true);
  });

  test('sandbox input carries only artifact, synthetic, verification, limit, and network fields', () => {
    const policy = defineDeveloperTrustPolicy(policyInput());
    const profile = createDefaultSandboxProfile(policy.sandboxProfiles['desktop-package']);
    const input = createSandboxInput({
      artifactDigest: digest('a'),
      artifactMount: {
        source: '/var/lib/openopc/artifacts/aa/fixture',
        target: '/artifact',
        digest: digest('a'),
        readOnly: true,
      },
      profile: 'desktop-package',
      fixtures: [{ action: 'synthetic.search', response: { items: [] } }],
      verificationCapability: 'verification-capability-fixture',
      limits: profile.limits,
      networkPolicy: {
        mode: 'none',
        allowedOrigins: [],
        allowedMethods: ['GET'],
        maxRequestBytes: 1_024,
        maxResponseBytes: 4_096,
        maxRedirects: 0,
      },
    });

    expect(Object.keys(input)).toEqual([
      'artifactDigest',
      'artifactMount',
      'profile',
      'fixtures',
      'verificationCapability',
      'limits',
      'networkPolicy',
    ]);
    expect(JSON.stringify(input)).not.toMatch(
      /accountId|projectId|sessionId|accessToken|refreshToken|secretKey|connector/i,
    );
  });
});
