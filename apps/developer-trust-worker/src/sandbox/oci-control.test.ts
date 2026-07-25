import { describe, expect, test } from 'bun:test';

import { defineDeveloperTrustPolicy } from '../policy';
import { policyInput } from '../test-fixtures';
import { DeveloperModuleOciControlError, createOciSandboxControl } from './oci-control';
import { createDefaultSandboxProfile, createSandboxInput } from './profile';
import type { DeveloperModuleSandboxResult } from './types';

const digest = (character: string) => `sha256:${character.repeat(64)}` as const;

function sandboxInput() {
  const policy = defineDeveloperTrustPolicy(policyInput());
  const profile = createDefaultSandboxProfile(policy.sandboxProfiles['desktop-package']);
  return {
    profile,
    input: createSandboxInput({
      artifactDigest: digest('a'),
      artifactMount: {
        source: '/var/lib/openopc/artifacts/aa/fixture',
        target: '/artifact',
        digest: digest('a'),
        readOnly: true,
      },
      profile: 'desktop-package',
      fixtures: [],
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
    }),
  };
}

function result(): DeveloperModuleSandboxResult {
  return {
    runId: '50000000-0000-4000-a000-000000000005',
    sandboxInstanceId: 'sandbox-instance-1',
    artifactDigest: digest('a'),
    sandboxProfileDigest: digest('5'),
    state: 'passed',
    terminalReason: 'sandbox_verification_completed',
    stdoutDigest: digest('1'),
    stderrDigest: digest('2'),
    evidenceDigest: digest('3'),
    resourceUsage: { cpuMillis: 50, peakMemoryBytes: 1024, pids: 2, outputBytes: 32 },
    tests: [{ id: 'load-entry', outcome: 'passed', summary: 'Entry loaded' }],
    capabilityAttempts: [],
    networkAttempts: [],
  };
}

describe('OCI sandbox control adapter', () => {
  test('sends a narrow hardened request with no host namespace or ordinary token', async () => {
    const fixture = sandboxInput();
    const captured: unknown[] = [];
    const sandbox = createOciSandboxControl({
      endpoint: 'https://sandbox-control.internal/v1/verification/run',
      controlToken: 'control-channel-fixture',
      verificationBrokerUrl: 'https://verification-broker.internal',
      profileResolver: () => fixture.profile,
      transport: async (request) => {
        captured.push(request);
        return result();
      },
    });

    await expect(sandbox.run(fixture.input, new AbortController().signal)).resolves.toEqual(
      result(),
    );
    expect(captured).toHaveLength(1);
    const serialized = JSON.stringify(captured[0]);
    expect(serialized).toContain('openopc-verification-v1');
    expect(serialized).toContain('verification-capability-fixture');
    expect(serialized).not.toMatch(/docker\.sock|"host(?:Pid|Ipc|Network)":true/);
    expect(serialized).not.toMatch(/projectToken|sessionToken|accessToken|refreshToken|secretKey/i);
  });

  test.each(['unix:///var/run/docker.sock', 'npipe:////./pipe/docker_engine'])(
    'rejects broad container control endpoint %s',
    (endpoint) => {
      const fixture = sandboxInput();
      expect(() =>
        createOciSandboxControl({
          endpoint,
          controlToken: 'control-channel-fixture',
          verificationBrokerUrl: 'https://verification-broker.internal',
          profileResolver: () => fixture.profile,
          transport: async () => result(),
        }),
      ).toThrow(DeveloperModuleOciControlError);
    },
  );
});
