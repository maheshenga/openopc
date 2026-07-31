import { readFile } from 'node:fs/promises';

import {
  type DisabledCapabilityRecordV1,
  type DisabledStateAssessmentV1,
  RELEASE_PROFILE_UNAVAILABLE,
  RESTRICTED_DISABLED_CAPABILITIES,
  type RestrictedRuntimeCapability,
} from '../../packages/api-contract/src/release-profile';
import { computeCanonicalPublicBetaDigest } from './public-beta-canonical-json';
import { createDisabledStateAssessment } from './public-beta-disabled-state';
import {
  OPENOPC_RESTRICTED_PUBLIC_BETA_PROFILE,
  OPENOPC_RESTRICTED_PUBLIC_BETA_PROFILE_DIGEST,
} from './public-beta-release-profile';

const HTTP_SURFACES = new Set(['api', 'legacy', 'direct']);
const EXPECTED_DEPLOYMENT_SERVICES = OPENOPC_RESTRICTED_PUBLIC_BETA_PROFILE.artifacts;
const EXPECTED_IAM_PRINCIPALS = ['public-beta-users', 'public-beta-developers'] as const;
const EXPECTED_UI_ROUTES = [
  '/projects',
  '/projects/:id/modules',
  '/developer/apply',
  '/developer/modules',
  '/developer/modules/submit',
] as const;
const EXPECTED_ENABLED_RUNTIME_CAPABILITIES = [
  'studio.text.generate',
  'studio.image.generate',
  'studio.video.generate',
  'module.wasi.execute',
] as const satisfies readonly RestrictedRuntimeCapability[];

export interface ProtectedDisabledStateRawEvidence {
  commit: string;
  releaseProfileId: string;
  releaseProfileDigest: string;
  sourceDigest: string;
  artifacts: readonly unknown[];
  deploymentInventory: readonly unknown[];
  runtimeProbe: readonly unknown[];
  iamExport: readonly unknown[];
  routeCliProbes: readonly unknown[];
  uiRoutes: readonly unknown[];
}

export interface DisabledStateRawEvidence {
  commit: string;
  controlSha: string;
  rawEvidence: ProtectedDisabledStateRawEvidence;
}

export function auditDisabledStateEvidence(
  input: DisabledStateRawEvidence,
): DisabledStateAssessmentV1 {
  const evidence = protectedRawEvidence(input);
  const disabled = new Set<RestrictedRuntimeCapability>(RESTRICTED_DISABLED_CAPABILITIES);
  for (const entry of evidence.routeCliProbes) {
    const capability = objectRecord(entry).capability;
    if (
      typeof capability !== 'string' ||
      !disabled.has(capability as RestrictedRuntimeCapability)
    ) {
      invalidRawEvidence();
    }
  }
  const records = RESTRICTED_DISABLED_CAPABILITIES.map((capability) =>
    auditDisabledCapabilityEvidence({
      capability,
      artifacts: evidence.artifacts,
      deploymentInventory: evidence.deploymentInventory,
      runtimeProbe: evidence.runtimeProbe,
      iamExport: evidence.iamExport,
      routeCliProbes: evidence.routeCliProbes.filter(
        (entry) => objectRecord(entry).capability === capability,
      ),
      uiRoutes: evidence.uiRoutes,
    }),
  );
  return createDisabledStateAssessment({
    commit: input.commit,
    controlSha: input.controlSha,
    records,
  });
}

export async function runDisabledStateAuditCli(
  args: readonly string[],
  write: (value: string) => void = (value) => console.log(value),
): Promise<DisabledStateAssessmentV1> {
  const values = parseCliArguments(args);
  const rawEvidence = await readEvidenceObject(values.evidence);
  const assessment = auditDisabledStateEvidence({
    commit: values.commit,
    controlSha: values['control-sha'],
    rawEvidence,
  });
  write(JSON.stringify(assessment));
  return assessment;
}

export function auditDisabledCapabilityEvidence(input: {
  capability: DisabledCapabilityRecordV1['capability'];
  artifacts: readonly unknown[];
  deploymentInventory: readonly unknown[];
  runtimeProbe: readonly unknown[];
  iamExport: readonly unknown[];
  routeCliProbes: readonly unknown[];
  uiRoutes: readonly unknown[];
}): DisabledCapabilityRecordV1 {
  if (
    input.artifacts.some(
      (entry) =>
        entry !== null &&
        typeof entry === 'object' &&
        Object.hasOwn(entry as object, 'artifactAbsent'),
    )
  ) {
    invalidRawEvidence();
  }
  const evidence = [
    input.artifacts,
    input.deploymentInventory,
    input.runtimeProbe,
    input.iamExport,
    input.routeCliProbes,
    input.uiRoutes,
  ];
  if (evidence.some((entries) => entries.length === 0)) rawEvidenceRequired();
  try {
    assertArtifacts(input.artifacts);
    assertDeploymentInventory(input.deploymentInventory, input.capability);
    assertRuntimeProbe(input.runtimeProbe, input.capability);
    assertIamExport(input.iamExport, input.capability);
    assertRouteCliProbes(input.routeCliProbes, input.capability);
    assertUiRoutes(input.uiRoutes, input.capability);
    const artifactAbsent = input.artifacts.every(
      (entry, index) =>
        objectRecord(entry).name === OPENOPC_RESTRICTED_PUBLIC_BETA_PROFILE.artifacts[index],
    );
    const deployedServiceAbsent = input.deploymentInventory.every(
      (entry) => !stringArray(objectRecord(entry).capabilities) || !objectRecord(entry).capabilities.includes(input.capability),
    );
    const serverFlag = stringArray(objectRecord(input.runtimeProbe[0]).enabledCapabilities)
      ? objectRecord(input.runtimeProbe[0]).enabledCapabilities.includes(input.capability)
      : true;
    const apiCliRejected = input.routeCliProbes.every((entry) => {
      const probe = objectRecord(entry);
      return (
        probe.code === RELEASE_PROFILE_UNAVAILABLE &&
        (probe.surface === 'cli' ? probe.exitCode === 69 : probe.httpStatus === 503)
      );
    });
    const iamCapabilityAbsent = input.iamExport.every(
      (entry) =>
        stringArray(objectRecord(entry).capabilities) &&
        !objectRecord(entry).capabilities.includes(input.capability),
    );
    const legacyDirectRouteRejected = input.routeCliProbes
      .filter((entry) => {
        const surface = objectRecord(entry).surface;
        return surface === 'legacy' || surface === 'direct';
      })
      .every((entry) => objectRecord(entry).httpStatus === 503);
    const uiAdvertised = input.uiRoutes.some(
      (entry) =>
        stringArray(objectRecord(entry).advertisedCapabilities) &&
        objectRecord(entry).advertisedCapabilities.includes(input.capability),
    );
    if (
      !artifactAbsent ||
      !deployedServiceAbsent ||
      serverFlag ||
      !apiCliRejected ||
      !iamCapabilityAbsent ||
      !legacyDirectRouteRejected ||
      uiAdvertised
    ) {
      invalidRawEvidence();
    }
    return Object.freeze({
      capability: input.capability,
      artifactAbsent,
      deployedServiceAbsent,
      serverFlag,
      apiCliRejected,
      iamCapabilityAbsent,
      legacyDirectRouteRejected,
      uiAdvertised,
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'OPENOPC_DISABLED_STATE_RAW_EVIDENCE_REQUIRED'
    ) {
      throw error;
    }
    invalidRawEvidence();
  }
}

function assertArtifacts(entries: readonly unknown[]): void {
  if (entries.length !== OPENOPC_RESTRICTED_PUBLIC_BETA_PROFILE.artifacts.length)
    invalidRawEvidence();
  entries.forEach((entry, index) => {
    if (
      entry === null ||
      typeof entry !== 'object' ||
      Array.isArray(entry) ||
      Object.keys(entry as Record<string, unknown>).length !== 2
    ) {
      invalidRawEvidence();
    }
    const record = exactRecord(entry, ['digest', 'name']);
    if (
      record.name !== OPENOPC_RESTRICTED_PUBLIC_BETA_PROFILE.artifacts[index] ||
      typeof record.digest !== 'string' ||
      !/^sha256:[a-f0-9]{64}$/.test(record.digest)
    ) {
      invalidRawEvidence();
    }
  });
}

function assertDeploymentInventory(
  entries: readonly unknown[],
  capability: RestrictedRuntimeCapability,
): void {
  const services = entries.map((entry) => {
    const record = exactRecord(entry, ['capabilities', 'service']);
    if (
      typeof record.service !== 'string' ||
      record.service.trim() !== record.service ||
      !record.service ||
      !stringArray(record.capabilities) ||
      record.capabilities.includes(capability)
    ) {
      invalidRawEvidence();
    }
    return record.service;
  });
  if (
    services.length !== EXPECTED_DEPLOYMENT_SERVICES.length ||
    services.some((service, index) => service !== EXPECTED_DEPLOYMENT_SERVICES[index]) ||
    new Set(services).size !== services.length
  ) {
    invalidRawEvidence();
  }
}

function assertRuntimeProbe(
  entries: readonly unknown[],
  capability: RestrictedRuntimeCapability,
): void {
  if (entries.length !== 1) invalidRawEvidence();
  const record = exactRecord(entries[0], [
    'enabledCapabilities',
    'releaseProfileDigest',
    'releaseProfileId',
  ]);
  if (
    record.releaseProfileId !== OPENOPC_RESTRICTED_PUBLIC_BETA_PROFILE.id ||
    record.releaseProfileDigest !== OPENOPC_RESTRICTED_PUBLIC_BETA_PROFILE_DIGEST ||
    !stringArray(record.enabledCapabilities) ||
    record.enabledCapabilities.length !== EXPECTED_ENABLED_RUNTIME_CAPABILITIES.length ||
    record.enabledCapabilities.some(
      (entry, index) => entry !== EXPECTED_ENABLED_RUNTIME_CAPABILITIES[index],
    ) ||
    record.enabledCapabilities.includes(capability)
  ) {
    invalidRawEvidence();
  }
}

function assertIamExport(
  entries: readonly unknown[],
  capability: RestrictedRuntimeCapability,
): void {
  const principals: string[] = [];
  for (const entry of entries) {
    const record = exactRecord(entry, ['capabilities', 'principal']);
    if (
      typeof record.principal !== 'string' ||
      !record.principal ||
      principals.includes(record.principal)
    )
      invalidRawEvidence();
    principals.push(record.principal);
    if (!stringArray(record.capabilities) || record.capabilities.includes(capability))
      invalidRawEvidence();
  }
  if (
    principals.length !== EXPECTED_IAM_PRINCIPALS.length ||
    principals.some((principal, index) => principal !== EXPECTED_IAM_PRINCIPALS[index])
  ) {
    invalidRawEvidence();
  }
}

function assertRouteCliProbes(
  entries: readonly unknown[],
  capability: RestrictedRuntimeCapability,
): void {
  if (entries.length !== 4) invalidRawEvidence();
  const surfaces = new Set<string>();
  for (const entry of entries) {
    const candidate = objectRecord(entry);
    const surface = candidate.surface;
    if (typeof surface !== 'string' || surfaces.has(surface)) invalidRawEvidence();
    surfaces.add(surface);
    const keys =
      surface === 'cli'
        ? ['capability', 'code', 'exitCode', 'probeId', 'surface']
        : ['capability', 'code', 'httpStatus', 'probeId', 'surface'];
    const record = exactRecord(entry, keys);
    if (
      record.capability !== capability ||
      record.probeId !== `release-profile.${capability}.${surface}` ||
      record.code !== RELEASE_PROFILE_UNAVAILABLE ||
      (surface === 'cli'
        ? record.exitCode !== 69
        : !HTTP_SURFACES.has(surface) || record.httpStatus !== 503)
    ) {
      invalidRawEvidence();
    }
  }
  if (![...HTTP_SURFACES, 'cli'].every((surface) => surfaces.has(surface))) invalidRawEvidence();
}

function assertUiRoutes(
  entries: readonly unknown[],
  capability: RestrictedRuntimeCapability,
): void {
  const routes: string[] = [];
  for (const entry of entries) {
    const record = exactRecord(entry, ['advertisedCapabilities', 'route']);
    if (
      typeof record.route !== 'string' ||
      !record.route.startsWith('/') ||
      routes.includes(record.route)
    )
      invalidRawEvidence();
    routes.push(record.route);
    if (
      !stringArray(record.advertisedCapabilities) ||
      record.advertisedCapabilities.includes(capability)
    )
      invalidRawEvidence();
  }
  if (
    routes.length !== EXPECTED_UI_ROUTES.length ||
    routes.some((route, index) => route !== EXPECTED_UI_ROUTES[index])
  ) {
    invalidRawEvidence();
  }
}

function exactRecord(value: unknown, expectedKeys: readonly string[]): Record<string, unknown> {
  const record = objectRecord(value);
  const keys = Object.keys(record).sort();
  const expected = [...expectedKeys].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index]))
    invalidRawEvidence();
  return record;
}

function objectRecord(value: unknown): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    invalidRawEvidence();
  }
  return value as Record<string, unknown>;
}

function stringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === 'string') &&
    new Set(value).size === value.length
  );
}

function rawEvidenceRequired(): never {
  throw new Error('OPENOPC_DISABLED_STATE_RAW_EVIDENCE_REQUIRED');
}

function invalidRawEvidence(): never {
  throw new Error('OPENOPC_DISABLED_STATE_RAW_EVIDENCE_INVALID');
}

function protectedRawEvidence(input: DisabledStateRawEvidence): ProtectedDisabledStateRawEvidence {
  const record = exactRecord(input.rawEvidence, [
    'artifacts',
    'commit',
    'deploymentInventory',
    'iamExport',
    'releaseProfileDigest',
    'releaseProfileId',
    'routeCliProbes',
    'runtimeProbe',
    'sourceDigest',
    'uiRoutes',
  ]);
  const entries = {
    artifacts: rawArray(record.artifacts),
    deploymentInventory: rawArray(record.deploymentInventory),
    runtimeProbe: rawArray(record.runtimeProbe),
    iamExport: rawArray(record.iamExport),
    routeCliProbes: rawArray(record.routeCliProbes),
    uiRoutes: rawArray(record.uiRoutes),
  };
  if (
    typeof input.commit !== 'string' ||
    !/^[a-f0-9]{40}$/.test(input.commit) ||
    typeof record.commit !== 'string' ||
    record.commit !== input.commit ||
    record.releaseProfileId !== OPENOPC_RESTRICTED_PUBLIC_BETA_PROFILE.id ||
    record.releaseProfileDigest !== OPENOPC_RESTRICTED_PUBLIC_BETA_PROFILE_DIGEST ||
    typeof record.sourceDigest !== 'string' ||
    record.sourceDigest !== computeCanonicalPublicBetaDigest(entries)
  ) {
    invalidRawEvidence();
  }
  return { ...entries, ...record } as ProtectedDisabledStateRawEvidence;
}

function rawArray(value: unknown): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    invalidRawEvidence();
  }
  return value;
}

const CLI_FLAGS = [
  'commit',
  'control-sha',
  'evidence',
] as const;

function parseCliArguments(args: readonly string[]): Record<(typeof CLI_FLAGS)[number], string> {
  if (args.length !== CLI_FLAGS.length * 2) invalidCliArguments();
  const parsed = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (
      typeof flag !== 'string' ||
      !flag.startsWith('--') ||
      typeof value !== 'string' ||
      !value ||
      parsed.has(flag.slice(2))
    ) {
      invalidCliArguments();
    }
    parsed.set(flag.slice(2), value);
  }
  if (CLI_FLAGS.some((flag) => !parsed.has(flag))) invalidCliArguments();
  return Object.fromEntries(
    CLI_FLAGS.map((flag) => {
      const value = parsed.get(flag);
      if (value === undefined) invalidCliArguments();
      return [flag, value];
    }),
  ) as Record<(typeof CLI_FLAGS)[number], string>;
}

async function readEvidenceObject(path: string): Promise<ProtectedDisabledStateRawEvidence> {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) invalidCliArguments();
  try {
    const value = JSON.parse(await readFile(path, 'utf8'));
    return value as ProtectedDisabledStateRawEvidence;
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message === 'OPENOPC_DISABLED_STATE_AUDIT_ARGUMENT_INVALID' ||
        error.message === 'OPENOPC_DISABLED_STATE_RAW_EVIDENCE_INVALID')
    ) {
      throw error;
    }
    invalidRawEvidence();
  }
}

function invalidCliArguments(): never {
  throw new Error('OPENOPC_DISABLED_STATE_AUDIT_ARGUMENT_INVALID');
}

if (import.meta.main) {
  runDisabledStateAuditCli(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : 'OPENOPC_DISABLED_STATE_AUDIT_FAILED');
    process.exitCode = 1;
  });
}
