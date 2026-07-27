import { expect, test } from 'bun:test';

import wasiFixture from '../fixtures/valid/wasi.json';
import {
  MODULE_EXECUTION_INPUT_MAX_BYTES,
  RUNTIME_ARTIFACT_FETCH_PATH,
  WASI_RUNTIME_ARTIFACT_MAX_BYTES,
  parseRunnerClaimBundle,
} from './index';

const validBundle = {
  signedEnvelope: 'e30.e30.e30',
  capabilityTokens: [
    {
      grantId: '10000000-0000-4000-8000-000000000006',
      audience: 'egress',
      token: 'bounded-capability-token',
    },
  ],
  runtimeDescriptor: wasiFixture,
  inputBase64: Buffer.from('{"a":1}').toString('base64url'),
  runtimeArtifact: {
    fetchPath: 'module-runtime/artifacts/fetch',
    digest: `sha256:${'8'.repeat(64)}`,
    bytes: 4096,
  },
};

test('accepts the strict server-owned execution bundle', () => {
  const parsed = parseRunnerClaimBundle(validBundle);

  expect(parsed.inputBase64).toBe('eyJhIjoxfQ');
  expect(parsed.runtimeArtifact).toEqual({
    fetchPath: RUNTIME_ARTIFACT_FETCH_PATH,
    digest: `sha256:${'8'.repeat(64)}`,
    bytes: 4096,
  });
  expect(MODULE_EXECUTION_INPUT_MAX_BYTES).toBe(262_144);
  expect(WASI_RUNTIME_ARTIFACT_MAX_BYTES).toBe(33_554_432);
});

test('rejects bundle substitution, ambiguous input encoding, and artifact limit bypasses', () => {
  const invalidBundles = [
    { ...validBundle, unexpected: true },
    { ...validBundle, inputBase64: `${validBundle.inputBase64}=` },
    { ...validBundle, inputBase64: 'Zh' },
    {
      ...validBundle,
      inputBase64: Buffer.alloc(MODULE_EXECUTION_INPUT_MAX_BYTES + 1).toString('base64url'),
    },
    {
      ...validBundle,
      runtimeArtifact: { ...validBundle.runtimeArtifact, fetchPath: 'alternate/path' },
    },
    {
      ...validBundle,
      runtimeArtifact: {
        ...validBundle.runtimeArtifact,
        digest: `sha256:${'A'.repeat(64)}`,
      },
    },
    {
      ...validBundle,
      runtimeArtifact: { ...validBundle.runtimeArtifact, bytes: 0 },
    },
    {
      ...validBundle,
      runtimeArtifact: {
        ...validBundle.runtimeArtifact,
        bytes: WASI_RUNTIME_ARTIFACT_MAX_BYTES + 1,
      },
    },
    {
      ...validBundle,
      capabilityTokens: [{ ...validBundle.capabilityTokens[0], audience: 'unknown-audience' }],
    },
    {
      ...validBundle,
      capabilityTokens: [
        validBundle.capabilityTokens[0],
        { ...validBundle.capabilityTokens[0], token: 'substituted-token' },
      ],
    },
  ];

  for (const bundle of invalidBundles) {
    expect(() => parseRunnerClaimBundle(bundle)).toThrow('RUNNER_CLAIM_BUNDLE_INVALID');
  }
});
