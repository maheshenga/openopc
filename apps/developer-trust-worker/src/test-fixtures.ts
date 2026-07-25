import type { RegistryModuleVerificationProfile } from '@kortix/registry';

import type { DeveloperTrustPolicyInput, SandboxProfilePolicy } from './policy';

export const fixtureDigest = (character: string) =>
  `sha256:${character.repeat(64)}` as `sha256:${string}`;

const profiles: readonly RegistryModuleVerificationProfile[] = [
  'declarative',
  'agent-project',
  'sandboxed-web',
  'server-conformance',
  'desktop-package',
];

function sandboxProfiles(): Record<RegistryModuleVerificationProfile, SandboxProfilePolicy> {
  const profileDigests = ['1', '2', '3', '4', '5'] as const;
  const imageDigests = ['6', '7', '8', '9', 'a'] as const;
  return Object.fromEntries(
    profiles.map((profile, index) => [
      profile,
      {
        profile,
        profileDigest: fixtureDigest(profileDigests[index]),
        imageDigest: fixtureDigest(imageDigests[index]),
        network: profile === 'declarative' ? 'none' : 'egress-proxy',
        timeoutMs: 60_000,
        memoryBytes: 512 * 1024 * 1024,
        cpuMillis: 1_000,
        pidsLimit: 128,
      },
    ]),
  ) as Record<RegistryModuleVerificationProfile, SandboxProfilePolicy>;
}

export function policyInput(): DeveloperTrustPolicyInput {
  const scannerNames = ['gitleaks', 'syft', 'osv-scanner', 'semgrep', 'license-policy'] as const;
  const imageDigests = ['a', 'b', 'c', 'd', 'e'] as const;
  const ruleDigests = ['5', '6', '7', '8', '9'] as const;
  return {
    schema: 1,
    policyId: 'openopc-developer-trust-2026-07',
    scanners: scannerNames.map((name, index) => ({
      name,
      executable: `/opt/openopc/scanners/${name}`,
      imageDigest: fixtureDigest(imageDigests[index]),
      version: `1.${index}.0`,
      ruleDigest: fixtureDigest(ruleDigests[index]),
      timeoutMs: 30_000,
      maxOutputBytes: 1_048_576,
    })),
    advisorySnapshot: 'osv-2026-07-24T00:00:00Z',
    sandboxProfiles: sandboxProfiles(),
    blockingSeverities: ['critical', 'high'],
  };
}
