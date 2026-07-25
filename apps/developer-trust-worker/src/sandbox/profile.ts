import type { SandboxProfilePolicy } from '../policy';
import type {
  DeveloperModuleNetworkPolicy,
  DeveloperModuleSandboxInput,
  DeveloperModuleSandboxProfile,
  SandboxResourceLimits,
} from './types';

export function createDefaultSandboxProfile(
  input: SandboxProfilePolicy,
): DeveloperModuleSandboxProfile {
  validateProfilePolicy(input);
  const limits: SandboxResourceLimits = {
    cpuMillis: input.cpuMillis,
    memoryBytes: input.memoryBytes,
    pids: input.pidsLimit,
    fileDescriptors: 256,
    maxFileBytes: Math.min(128 * 1024 * 1024, Math.floor(input.memoryBytes / 4)),
    maxOutputBytes: 1024 * 1024,
    wallTimeMs: input.timeoutMs,
  };
  return deepFreeze({
    profile: input.profile,
    profileDigest: input.profileDigest,
    imageDigest: input.imageDigest,
    networkMode: input.network,
    identity: { uid: 65_532, gid: 65_532 },
    rootFilesystem: { readOnly: true },
    scratch: {
      kind: 'tmpfs',
      sizeBytes: Math.min(256 * 1024 * 1024, Math.floor(input.memoryBytes / 4)),
    },
    security: {
      capabilities: [] as const,
      noNewPrivileges: true,
      seccompProfile: 'openopc-verification-v1',
      hostIpc: false,
      hostPid: false,
      hostNetwork: false,
    },
    limits,
  });
}

export function createSandboxInput(
  input: DeveloperModuleSandboxInput,
): DeveloperModuleSandboxInput {
  if (
    !DIGEST.test(input.artifactDigest) ||
    input.artifactMount.digest !== input.artifactDigest ||
    input.artifactMount.target !== '/artifact' ||
    input.artifactMount.readOnly !== true ||
    !safeArtifactSource(input.artifactMount.source) ||
    typeof input.verificationCapability !== 'string' ||
    input.verificationCapability.length < 16 ||
    input.verificationCapability.length > 4096 ||
    /[\0\r\n]/.test(input.verificationCapability) ||
    !validLimits(input.limits) ||
    !validNetworkPolicy(input.networkPolicy) ||
    !Array.isArray(input.fixtures) ||
    input.fixtures.length > 100 ||
    !validRuntimeCoordinates(input)
  ) {
    throw new TypeError('DEVELOPER_SANDBOX_INPUT_INVALID');
  }
  const fixtures = input.fixtures.map((fixture) => {
    if (
      !fixture ||
      typeof fixture.action !== 'string' ||
      !/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(fixture.action)
    ) {
      throw new TypeError('DEVELOPER_SANDBOX_FIXTURE_INVALID');
    }
    const response = structuredClone(fixture.response);
    const serialized = JSON.stringify(response);
    if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > 64 * 1024) {
      throw new TypeError('DEVELOPER_SANDBOX_FIXTURE_INVALID');
    }
    return { action: fixture.action, response };
  });
  return deepFreeze({
    ...(input.runId === undefined
      ? {}
      : {
          runId: input.runId,
          sandboxInstanceId: input.sandboxInstanceId,
          sandboxProfileDigest: input.sandboxProfileDigest,
        }),
    artifactDigest: input.artifactDigest,
    artifactMount: { ...input.artifactMount },
    profile: input.profile,
    fixtures,
    verificationCapability: input.verificationCapability,
    limits: { ...input.limits },
    networkPolicy: {
      ...input.networkPolicy,
      allowedOrigins: [...input.networkPolicy.allowedOrigins],
      allowedMethods: [...input.networkPolicy.allowedMethods],
    },
    ...(input.runtime === undefined ? {} : { runtime: structuredClone(input.runtime) }),
  });
}

const DIGEST = /^sha256:[0-9a-f]{64}$/;

function validateProfilePolicy(input: SandboxProfilePolicy): void {
  if (
    !input ||
    !DIGEST.test(input.profileDigest) ||
    !DIGEST.test(input.imageDigest) ||
    !positiveInteger(input.timeoutMs) ||
    !positiveInteger(input.memoryBytes) ||
    !positiveInteger(input.cpuMillis) ||
    !positiveInteger(input.pidsLimit) ||
    (input.network !== 'none' && input.network !== 'egress-proxy')
  ) {
    throw new TypeError('DEVELOPER_SANDBOX_PROFILE_INVALID');
  }
}

function safeArtifactSource(value: string): boolean {
  return (
    typeof value === 'string' &&
    /^\/[A-Za-z0-9._/-]+$/.test(value) &&
    !value.split('/').includes('..') &&
    !/docker\.sock|docker_engine/i.test(value)
  );
}

function positiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function validLimits(limits: SandboxResourceLimits): boolean {
  return Object.values(limits).every(positiveInteger);
}

function validNetworkPolicy(policy: DeveloperModuleNetworkPolicy): boolean {
  return (
    (policy.mode === 'none' || policy.mode === 'egress-proxy') &&
    Array.isArray(policy.allowedOrigins) &&
    Array.isArray(policy.allowedMethods) &&
    policy.allowedMethods.every((method) => ['GET', 'HEAD', 'POST'].includes(method)) &&
    positiveInteger(policy.maxRequestBytes) &&
    positiveInteger(policy.maxResponseBytes) &&
    Number.isSafeInteger(policy.maxRedirects) &&
    policy.maxRedirects >= 0 &&
    policy.maxRedirects <= 3 &&
    (policy.mode !== 'none' || (policy.allowedOrigins.length === 0 && policy.maxRedirects === 0))
  );
}

function validRuntimeCoordinates(input: DeveloperModuleSandboxInput): boolean {
  const coordinates = [input.runId, input.sandboxInstanceId, input.sandboxProfileDigest];
  if (coordinates.every((value) => value === undefined) && input.runtime === undefined) return true;
  if (
    typeof input.runId !== 'string' ||
    input.runId.length < 1 ||
    input.runId.length > 128 ||
    /[\0\r\n]/.test(input.runId) ||
    typeof input.sandboxInstanceId !== 'string' ||
    input.sandboxInstanceId.length < 1 ||
    input.sandboxInstanceId.length > 128 ||
    /[\0\r\n]/.test(input.sandboxInstanceId) ||
    typeof input.sandboxProfileDigest !== 'string' ||
    !DIGEST.test(input.sandboxProfileDigest) ||
    input.runtime === undefined
  ) {
    return false;
  }
  if (input.runtime.kind === 'wasi-component') {
    return (
      safeRuntimePath(input.runtime.componentPath) &&
      safeRuntimeText(input.runtime.world, 256) &&
      safeRuntimeText(input.runtime.operation, 128)
    );
  }
  return (
    DIGEST.test(input.runtime.image) &&
    input.runtime.command.length > 0 &&
    input.runtime.command.length <= 64 &&
    input.runtime.args.length <= 128 &&
    [...input.runtime.command, ...input.runtime.args].every((value) =>
      safeRuntimeText(value, 1024),
    ) &&
    safeRuntimeText(input.runtime.profile, 128)
  );
}

function safeRuntimePath(value: string): boolean {
  return (
    safeRuntimeText(value, 512) &&
    !value.startsWith('/') &&
    !value.includes('\\') &&
    !/^[A-Za-z]:/.test(value) &&
    value.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
  );
}

function safeRuntimeText(value: string, maxLength: number): boolean {
  return value.length > 0 && value.length <= maxLength && !/[\0\r\n]/.test(value);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
