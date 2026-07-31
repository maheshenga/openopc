import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  RELEASE_PROFILE_UNAVAILABLE,
  RESTRICTED_DISABLED_CAPABILITIES,
  type RestrictedRuntimeCapability,
} from '../../packages/api-contract/src/release-profile';
import { computeCanonicalPublicBetaDigest } from './public-beta-canonical-json';
import {
  auditDisabledCapabilityEvidence,
  auditDisabledStateEvidence,
  runDisabledStateAuditCli,
} from './public-beta-disabled-state-audit';
import { OPENOPC_RESTRICTED_PUBLIC_BETA_PROFILE } from './public-beta-release-profile';

function evidence(capability: RestrictedRuntimeCapability = 'commerce.purchase') {
  return {
    capability,
    artifacts: OPENOPC_RESTRICTED_PUBLIC_BETA_PROFILE.artifacts.map((name, index) => ({
      name,
      digest: `sha256:${String(index + 1).repeat(64)}`,
    })),
    deploymentInventory: [
      { service: 'web', capabilities: [] },
      { service: 'admin', capabilities: [] },
      { service: 'api', capabilities: ['studio.text.generate'] },
      { service: 'studio-worker', capabilities: ['studio.image.generate'] },
      { service: 'developer-trust-worker', capabilities: [] },
      { service: 'wasi-runner', capabilities: ['module.wasi.execute'] },
      { service: 'desktop', capabilities: [] },
    ],
    runtimeProbe: [
      {
        releaseProfileId: 'openopc-restricted-public-beta-v1',
        releaseProfileDigest:
          'sha256:e548465c35cb5041b38092b2937164f2abecfb6781ab0e545532ce95f387956c',
        enabledCapabilities: [
          'studio.text.generate',
          'studio.image.generate',
          'studio.video.generate',
          'module.wasi.execute',
        ],
      },
    ],
    iamExport: [
      { principal: 'public-beta-users', capabilities: ['studio.text.generate'] },
      { principal: 'public-beta-developers', capabilities: ['module.wasi.execute'] },
    ],
    routeCliProbes: [
      {
        surface: 'api',
        probeId: `release-profile.${capability}.api`,
        capability,
        httpStatus: 503,
        code: RELEASE_PROFILE_UNAVAILABLE,
      },
      {
        surface: 'legacy',
        probeId: `release-profile.${capability}.legacy`,
        capability,
        httpStatus: 503,
        code: RELEASE_PROFILE_UNAVAILABLE,
      },
      {
        surface: 'direct',
        probeId: `release-profile.${capability}.direct`,
        capability,
        httpStatus: 503,
        code: RELEASE_PROFILE_UNAVAILABLE,
      },
      {
        surface: 'cli',
        probeId: `release-profile.${capability}.cli`,
        capability,
        exitCode: 69,
        code: RELEASE_PROFILE_UNAVAILABLE,
      },
    ],
    uiRoutes: [
      { route: '/projects', advertisedCapabilities: ['studio.text.generate'] },
      { route: '/projects/:id/modules', advertisedCapabilities: ['module.wasi.execute'] },
      { route: '/developer/apply', advertisedCapabilities: [] },
      { route: '/developer/modules', advertisedCapabilities: ['module.wasi.execute'] },
      { route: '/developer/modules/submit', advertisedCapabilities: ['module.wasi.execute'] },
    ],
  };
}

function completeEvidence() {
  const base = evidence(RESTRICTED_DISABLED_CAPABILITIES[0]);
  const source = {
    artifacts: base.artifacts,
    deploymentInventory: base.deploymentInventory,
    runtimeProbe: base.runtimeProbe,
    iamExport: base.iamExport,
    routeCliProbes: RESTRICTED_DISABLED_CAPABILITIES.flatMap(
      (capability) => evidence(capability).routeCliProbes,
    ),
    uiRoutes: base.uiRoutes,
  };
  return {
    commit: 'a'.repeat(40),
    controlSha: 'b'.repeat(40),
    rawEvidence: {
      ...source,
      commit: 'a'.repeat(40),
      releaseProfileId: OPENOPC_RESTRICTED_PUBLIC_BETA_PROFILE.id,
      releaseProfileDigest:
        'sha256:e548465c35cb5041b38092b2937164f2abecfb6781ab0e545532ce95f387956c',
      sourceDigest: computeCanonicalPublicBetaDigest(source),
    },
  };
}

test('requires raw disabled-state evidence instead of self-reported flags', () => {
  expect(() =>
    auditDisabledCapabilityEvidence({
      capability: 'commerce.purchase',
      artifacts: [],
      deploymentInventory: [],
      runtimeProbe: [],
      iamExport: [],
      routeCliProbes: [],
      uiRoutes: [],
    }),
  ).toThrow('OPENOPC_DISABLED_STATE_RAW_EVIDENCE_REQUIRED');
});

test('derives every disabled-state observation from exact raw inventories', () => {
  expect(auditDisabledCapabilityEvidence(evidence())).toEqual({
    capability: 'commerce.purchase',
    artifactAbsent: true,
    deployedServiceAbsent: true,
    serverFlag: false,
    apiCliRejected: true,
    iamCapabilityAbsent: true,
    legacyDirectRouteRejected: true,
    uiAdvertised: false,
  });
});

test('rejects reachable, incomplete, extra, and self-reported raw evidence', () => {
  const cases = [
    { ...evidence(), artifacts: [...evidence().artifacts, { name: 'oci-runner' }] },
    {
      ...evidence(),
      deploymentInventory: [{ service: 'renamed-service', capabilities: ['commerce.purchase'] }],
    },
    {
      ...evidence(),
      runtimeProbe: [
        {
          ...evidence().runtimeProbe[0],
          enabledCapabilities: [
            'studio.text.generate',
            'studio.image.generate',
            'studio.video.generate',
            'module.wasi.execute',
            'module.oci.execute',
          ],
        },
      ],
    },
    { ...evidence(), iamExport: [{ principal: 'users', capabilities: ['commerce.purchase'] }] },
    { ...evidence(), routeCliProbes: evidence().routeCliProbes.slice(0, 3) },
    {
      ...evidence(),
      uiRoutes: [{ route: '/billing', advertisedCapabilities: ['commerce.purchase'] }],
    },
    {
      ...evidence(),
      artifacts: [{ ...evidence().artifacts[0], artifactAbsent: true }],
    },
  ];
  for (const invalid of cases) {
    expect(() => auditDisabledCapabilityEvidence(invalid)).toThrow(
      'OPENOPC_DISABLED_STATE_RAW_EVIDENCE_INVALID',
    );
  }
});

test('assembles the exact ten-record assessment from complete raw evidence', () => {
  const assessment = auditDisabledStateEvidence(completeEvidence());
  expect(assessment.records.map((record) => record.capability)).toEqual([
    ...RESTRICTED_DISABLED_CAPABILITIES,
  ]);
  expect(assessment.commit).toBe('a'.repeat(40));
});

test('rejects an omitted protected deployment service from the complete inventory', () => {
  const input = completeEvidence();
  expect(() =>
    auditDisabledStateEvidence({
      ...input,
      rawEvidence: {
        ...input.rawEvidence,
        deploymentInventory: input.rawEvidence.deploymentInventory.filter(
        (entry) => (entry as { service: string }).service !== 'api',
        ),
      },
    }),
  ).toThrow('OPENOPC_DISABLED_STATE_RAW_EVIDENCE_INVALID');
});

test('requires a protected raw-evidence binding instead of independent arrays', () => {
  const input = completeEvidence();
  expect(() => auditDisabledStateEvidence({ ...input, rawEvidence: undefined as never })).toThrow(
    'OPENOPC_DISABLED_STATE_RAW_EVIDENCE_INVALID',
  );
});

test('rejects a self-reported runtime enabled boolean instead of a capability inventory', () => {
  const input = completeEvidence();
  const runtimeProbe = [
    {
      capability: 'module.oci.execute',
      enabled: false,
      releaseProfileId: input.rawEvidence.releaseProfileId,
      releaseProfileDigest: input.rawEvidence.releaseProfileDigest,
    },
  ];
  const source = {
    artifacts: input.rawEvidence.artifacts,
    deploymentInventory: input.rawEvidence.deploymentInventory,
    runtimeProbe,
    iamExport: input.rawEvidence.iamExport,
    routeCliProbes: input.rawEvidence.routeCliProbes,
    uiRoutes: input.rawEvidence.uiRoutes,
  };
  expect(() =>
    auditDisabledStateEvidence({
      ...input,
      rawEvidence: {
        ...input.rawEvidence,
        runtimeProbe,
        sourceDigest: computeCanonicalPublicBetaDigest(source),
      },
    }),
  ).toThrow('OPENOPC_DISABLED_STATE_RAW_EVIDENCE_INVALID');
});

test('rejects an omitted protected IAM principal from the complete inventory', () => {
  const input = completeEvidence();
  const iamExport = input.rawEvidence.iamExport.filter(
    (entry) => (entry as { principal: string }).principal !== 'public-beta-developers',
  );
  const source = {
    artifacts: input.rawEvidence.artifacts,
    deploymentInventory: input.rawEvidence.deploymentInventory,
    runtimeProbe: input.rawEvidence.runtimeProbe,
    iamExport,
    routeCliProbes: input.rawEvidence.routeCliProbes,
    uiRoutes: input.rawEvidence.uiRoutes,
  };
  expect(() =>
    auditDisabledStateEvidence({
      ...input,
      rawEvidence: {
        ...input.rawEvidence,
        iamExport,
        sourceDigest: computeCanonicalPublicBetaDigest(source),
      },
    }),
  ).toThrow('OPENOPC_DISABLED_STATE_RAW_EVIDENCE_INVALID');
});

test('rejects an omitted protected UI route from the complete inventory', () => {
  const input = completeEvidence();
  const uiRoutes = input.rawEvidence.uiRoutes.filter(
    (entry) => (entry as { route: string }).route !== '/developer/modules/submit',
  );
  const source = {
    artifacts: input.rawEvidence.artifacts,
    deploymentInventory: input.rawEvidence.deploymentInventory,
    runtimeProbe: input.rawEvidence.runtimeProbe,
    iamExport: input.rawEvidence.iamExport,
    routeCliProbes: input.rawEvidence.routeCliProbes,
    uiRoutes,
  };
  expect(() =>
    auditDisabledStateEvidence({
      ...input,
      rawEvidence: {
        ...input.rawEvidence,
        uiRoutes,
        sourceDigest: computeCanonicalPublicBetaDigest(source),
      },
    }),
  ).toThrow('OPENOPC_DISABLED_STATE_RAW_EVIDENCE_INVALID');
});

test('rejects a substituted API/CLI probe even when its stable rejection is unchanged', () => {
  const input = completeEvidence();
  const routeCliProbes = input.rawEvidence.routeCliProbes.map((entry) =>
    (entry as { capability: string; surface: string }).capability === 'commerce.purchase' &&
    (entry as { capability: string; surface: string }).surface === 'api'
      ? { ...(entry as Record<string, unknown>), probeId: 'another.api.probe' }
      : entry,
  );
  const source = {
    artifacts: input.rawEvidence.artifacts,
    deploymentInventory: input.rawEvidence.deploymentInventory,
    runtimeProbe: input.rawEvidence.runtimeProbe,
    iamExport: input.rawEvidence.iamExport,
    routeCliProbes,
    uiRoutes: input.rawEvidence.uiRoutes,
  };
  expect(() =>
    auditDisabledStateEvidence({
      ...input,
      rawEvidence: {
        ...input.rawEvidence,
        routeCliProbes,
        sourceDigest: computeCanonicalPublicBetaDigest(source),
      },
    }),
  ).toThrow('OPENOPC_DISABLED_STATE_RAW_EVIDENCE_INVALID');
});

test('CLI reads only explicit local evidence files and emits the protected assessment', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openopc-disabled-state-'));
  try {
    const input = completeEvidence();
    const evidencePath = join(directory, 'evidence.json');
    await writeFile(evidencePath, JSON.stringify(input.rawEvidence));
    const args = ['--commit', input.commit, '--control-sha', input.controlSha];
    args.push('--evidence', evidencePath);
    let output = '';
    const assessment = await runDisabledStateAuditCli(args, (value) => {
      output = value;
    });
    expect(JSON.parse(output)).toEqual(assessment);
    expect(assessment.records).toHaveLength(10);
    await expect(
      runDisabledStateAuditCli([...args.slice(0, -1), 'https://example.invalid/evidence.json']),
    ).rejects.toThrow('OPENOPC_DISABLED_STATE_AUDIT_ARGUMENT_INVALID');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
