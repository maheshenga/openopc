import { expect, test } from 'bun:test';

import ociTagFixture from '../fixtures/invalid/oci-tag.json';
import ociFixture from '../fixtures/valid/oci.json';
import wasiFixture from '../fixtures/valid/wasi.json';
import {
  canonicalDigest,
  canonicalJsonBytes,
  parseRuntimeDescriptor,
  parseWorkEnvelope,
  sha256Digest,
} from './index';

const workEnvelopeFixture = {
  envelopeVersion: 1,
  executionId: '10000000-0000-4000-8000-000000000001',
  accountId: '10000000-0000-4000-8000-000000000002',
  projectId: '10000000-0000-4000-8000-000000000003',
  installationId: '10000000-0000-4000-8000-000000000004',
  idempotencyKey: 'module-execution-op-1',
  installRevision: 3,
  releaseId: '10000000-0000-4000-8000-000000000007',
  releaseDigest: `sha256:${'1'.repeat(64)}`,
  consentRevisionId: '10000000-0000-4000-8000-000000000008',
  permissionDigest: `sha256:${'4'.repeat(64)}`,
  runtimeDescriptorId: '10000000-0000-4000-8000-000000000009',
  runtimeDescriptorDigest: `sha256:${'2'.repeat(64)}`,
  inputDigest: `sha256:${'7'.repeat(64)}`,
  runtimeArtifactDigest: `sha256:${'8'.repeat(64)}`,
  runtimeArtifactBytes: 4096,
  runtimeKind: 'oci-image',
  runtimeProfile: 'openopc-oci-v1',
  policyDigest: `sha256:${'3'.repeat(64)}`,
  killSwitchGeneration: 7,
  executionDeadline: '2026-07-25T10:30:00.000Z',
  bindingDigest: `sha256:${'6'.repeat(64)}`,
  resourceCeilings: {
    cpuMillis: 60_000,
    memoryMiB: 512,
    wallTimeMs: 120_000,
    costMicro: 50_000,
  },
  lease: {
    id: '10000000-0000-4000-8000-000000000005',
    generation: 1,
    deadline: '2026-07-25T10:00:00.000Z',
  },
  grants: [
    {
      id: '10000000-0000-4000-8000-000000000006',
      audience: 'openopc:module/http',
      tokenHash: `sha256:${'4'.repeat(64)}`,
    },
  ],
};

test('accepts a strict WASI component runtime descriptor', () => {
  expect(parseRuntimeDescriptor(wasiFixture).runtime.kind).toBe('wasi-component');
});

test('accepts an OCI runtime pinned to an immutable image digest', () => {
  expect(parseRuntimeDescriptor(ociFixture).runtime.kind).toBe('oci-image');
});

test('rejects OCI tags with a stable immutable-image error', () => {
  expect(() => parseRuntimeDescriptor(ociTagFixture)).toThrow('OCI_IMAGE_DIGEST_REQUIRED');
});

test('rejects unknown fields, unsafe paths, unsorted imports, empty commands, and excessive limits', () => {
  const invalidDescriptors = [
    { ...ociFixture, extra: true },
    {
      ...wasiFixture,
      runtime: { ...wasiFixture.runtime, component: '../runtime/main.wasm' },
    },
    {
      ...wasiFixture,
      runtime: {
        ...wasiFixture.runtime,
        imports: ['openopc:module/output', 'openopc:module/input'],
      },
    },
    { ...ociFixture, runtime: { ...ociFixture.runtime, command: [] } },
    {
      ...ociFixture,
      runtime: {
        ...ociFixture.runtime,
        limits: { ...ociFixture.runtime.limits, memoryMiB: 4097 },
      },
    },
  ];

  for (const descriptor of invalidDescriptors) {
    expect(() => parseRuntimeDescriptor(descriptor)).toThrow('RUNTIME_DESCRIPTOR_INVALID');
  }
});

test('accepts a strict leased work envelope', () => {
  expect(parseWorkEnvelope(workEnvelopeFixture).lease.generation).toBe(1);
});

test('rejects duplicate capability grant identifiers', () => {
  const duplicateGrantEnvelope = {
    ...workEnvelopeFixture,
    grants: [
      workEnvelopeFixture.grants[0],
      {
        ...workEnvelopeFixture.grants[0],
        audience: 'openopc:module/output',
        tokenHash: `sha256:${'5'.repeat(64)}`,
      },
    ],
  };

  expect(() => parseWorkEnvelope(duplicateGrantEnvelope)).toThrow('WORK_ENVELOPE_INVALID');
});

test('rejects a work-envelope deadline without an RFC3339 T separator', () => {
  const invalidDeadlineEnvelope = {
    ...workEnvelopeFixture,
    lease: { ...workEnvelopeFixture.lease, deadline: '2026-07-25 10:00:00Z' },
  };

  expect(() => parseWorkEnvelope(invalidDeadlineEnvelope)).toThrow('WORK_ENVELOPE_INVALID');
});

test('rejects unknown work-envelope fields, malformed UUIDs, and non-canonical digests', () => {
  const { inputDigest: _inputDigest, ...withoutInputDigest } = workEnvelopeFixture;
  const { runtimeArtifactDigest: _runtimeArtifactDigest, ...withoutArtifactDigest } =
    workEnvelopeFixture;
  const { runtimeArtifactBytes: _runtimeArtifactBytes, ...withoutArtifactBytes } =
    workEnvelopeFixture;
  const invalidEnvelopes = [
    { ...workEnvelopeFixture, unexpected: true },
    { ...workEnvelopeFixture, executionId: 'not-a-uuid' },
    { ...workEnvelopeFixture, policyDigest: `sha256:${'A'.repeat(64)}` },
    withoutInputDigest,
    withoutArtifactDigest,
    withoutArtifactBytes,
    { ...workEnvelopeFixture, inputDigest: `sha256:${'A'.repeat(64)}` },
    { ...workEnvelopeFixture, runtimeArtifactDigest: `sha256:${'A'.repeat(64)}` },
    { ...workEnvelopeFixture, runtimeArtifactBytes: 0 },
    { ...workEnvelopeFixture, runtimeArtifactBytes: 33_554_433 },
    {
      ...workEnvelopeFixture,
      lease: { ...workEnvelopeFixture.lease, unexpected: true },
    },
  ];

  for (const envelope of invalidEnvelopes) {
    expect(() => parseWorkEnvelope(envelope)).toThrow('WORK_ENVELOPE_INVALID');
  }
});

test('produces a key-order-independent canonical work-envelope digest', async () => {
  const digest = await canonicalDigest({ b: 2, a: 1 });
  expect(digest).toBe(await canonicalDigest({ a: 1, b: 2 }));
  expect(digest).toBe('sha256:43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777');
});

test('exposes the exact canonical bytes that are hashed', async () => {
  const bytes = canonicalJsonBytes({ z: [3, { b: true, a: 'x' }], a: null });

  expect(new TextDecoder().decode(bytes)).toBe('{"a":null,"z":[3,{"a":"x","b":true}]}');
  expect(await sha256Digest(bytes)).toBe(
    'sha256:f39f20b5b275a590ffdbf04446b233ed928b40757f744e70a5e1c0a385aa83f9',
  );
});

test('rejects values that cannot have one canonical JSON byte representation', () => {
  const sparse: unknown[] = [];
  sparse[1] = 'value';

  for (const value of [sparse, Number.POSITIVE_INFINITY, '\ud800', new Date(0)]) {
    expect(() => canonicalJsonBytes(value)).toThrow('CANONICAL_JSON_INVALID');
  }
});

test('binds every runtime descriptor field into the canonical digest', async () => {
  const changedDescriptor = {
    ...wasiFixture,
    runtime: { ...wasiFixture.runtime, operation: 'transform' },
  };

  expect(await canonicalDigest(wasiFixture)).not.toBe(await canonicalDigest(changedDescriptor));
});
