import type {
  DeveloperModuleSandboxInput,
  DeveloperModuleSandboxPort,
  DeveloperModuleSandboxProfile,
  DeveloperModuleSandboxResult,
} from './types';

export class DeveloperModuleOciControlError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'DeveloperModuleOciControlError';
  }
}

export interface OciControlRequest {
  endpoint: string;
  controlToken: string;
  body: Record<string, unknown>;
  signal: AbortSignal;
}

export function createOciSandboxControl(input: {
  endpoint: string;
  controlToken: string;
  verificationBrokerUrl: string;
  profileResolver(profile: DeveloperModuleSandboxInput['profile']): DeveloperModuleSandboxProfile;
  transport(request: OciControlRequest): Promise<DeveloperModuleSandboxResult>;
}): DeveloperModuleSandboxPort {
  const endpoint = safeControlUrl(input.endpoint);
  const brokerUrl = safeControlUrl(input.verificationBrokerUrl);
  if (
    typeof input.controlToken !== 'string' ||
    input.controlToken.length < 16 ||
    input.controlToken.length > 4096 ||
    /[\0\r\n]/.test(input.controlToken)
  ) {
    fail('DEVELOPER_OCI_CONTROL_CONFIG_INVALID');
  }
  return {
    async run(sandboxInput, signal) {
      if (signal.aborted) fail('DEVELOPER_OCI_CONTROL_CANCELLED');
      const profile = input.profileResolver(sandboxInput.profile);
      validateInput(sandboxInput, profile);
      const body = buildControlBody(sandboxInput, profile, brokerUrl);
      let result: DeveloperModuleSandboxResult;
      try {
        result = await input.transport({
          endpoint,
          controlToken: input.controlToken,
          body,
          signal,
        });
      } catch (error) {
        if (error instanceof DeveloperModuleOciControlError) throw error;
        fail('DEVELOPER_OCI_CONTROL_UNAVAILABLE');
      }
      validateResult(result, sandboxInput, profile);
      return structuredClone(result);
    },
  };
}

const DIGEST = /^sha256:[0-9a-f]{64}$/;

function fail(code: string): never {
  throw new DeveloperModuleOciControlError(code);
}

function safeControlUrl(value: string): string {
  if (/docker\.sock|docker_engine/i.test(value)) fail('DEVELOPER_OCI_CONTROL_ENDPOINT_FORBIDDEN');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail('DEVELOPER_OCI_CONTROL_CONFIG_INVALID');
  }
  const loopback =
    url.hostname === '127.0.0.1' || url.hostname === '::1' || url.hostname === 'localhost';
  const privateService =
    loopback ||
    !url.hostname.includes('.') ||
    /^10\.|^192\.168\.|^172\.(?:1[6-9]|2[0-9]|3[01])\./.test(url.hostname);
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && privateService)) ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== '' ||
    url.search !== ''
  ) {
    fail('DEVELOPER_OCI_CONTROL_CONFIG_INVALID');
  }
  return url.href;
}

function validateInput(
  input: DeveloperModuleSandboxInput,
  profile: DeveloperModuleSandboxProfile,
): void {
  if (
    input.profile !== profile.profile ||
    !DIGEST.test(input.artifactDigest) ||
    input.artifactMount.digest !== input.artifactDigest ||
    input.artifactMount.target !== '/artifact' ||
    input.artifactMount.readOnly !== true ||
    !/^\/[A-Za-z0-9._/-]+$/.test(input.artifactMount.source) ||
    /docker\.sock|docker_engine/i.test(input.artifactMount.source) ||
    (input.networkPolicy.mode === 'egress-proxy' && profile.networkMode !== 'egress-proxy')
  ) {
    fail('DEVELOPER_OCI_CONTROL_INPUT_INVALID');
  }
  for (const key of Object.keys(profile.limits) as Array<keyof typeof profile.limits>) {
    if (input.limits[key] !== profile.limits[key]) fail('DEVELOPER_OCI_CONTROL_LIMIT_MISMATCH');
  }
}

function buildControlBody(
  input: DeveloperModuleSandboxInput,
  profile: DeveloperModuleSandboxProfile,
  brokerUrl: string,
): Record<string, unknown> {
  return {
    schema: 1,
    operation: 'run-verification',
    artifactDigest: input.artifactDigest,
    profile: input.profile,
    profileDigest: profile.profileDigest,
    imageDigest: profile.imageDigest,
    runtime: {
      identity: { ...profile.identity },
      rootFilesystem: { readOnly: true },
      mounts: [
        {
          kind: 'bind',
          source: input.artifactMount.source,
          target: input.artifactMount.target,
          readOnly: true,
        },
      ],
      scratch: { ...profile.scratch },
      capabilities: [],
      noNewPrivileges: true,
      seccompProfile: profile.security.seccompProfile,
      hostIpc: false,
      hostPid: false,
      hostNetwork: false,
      limits: { ...input.limits },
      environment: {
        LANG: 'C',
        TZ: 'UTC',
        SOURCE_DATE_EPOCH: '0',
        OPENOPC_VERIFICATION_BROKER_URL: brokerUrl,
        OPENOPC_VERIFICATION_CAPABILITY: input.verificationCapability,
      },
    },
    harness: {
      fixtures: structuredClone(input.fixtures),
      networkPolicy: structuredClone(input.networkPolicy),
    },
  };
}

function validateResult(
  result: DeveloperModuleSandboxResult,
  input: DeveloperModuleSandboxInput,
  profile: DeveloperModuleSandboxProfile,
): void {
  if (
    !result ||
    typeof result !== 'object' ||
    result.artifactDigest !== input.artifactDigest ||
    (input.runId !== undefined && result.runId !== input.runId) ||
    (input.sandboxInstanceId !== undefined &&
      result.sandboxInstanceId !== input.sandboxInstanceId) ||
    result.sandboxProfileDigest !== profile.profileDigest ||
    !DIGEST.test(result.stdoutDigest) ||
    !DIGEST.test(result.stderrDigest) ||
    !DIGEST.test(result.evidenceDigest) ||
    !['passed', 'failed', 'inconclusive', 'cancelled'].includes(result.state) ||
    !safeText(result.runId, 128) ||
    !safeText(result.sandboxInstanceId, 128) ||
    !safeText(result.terminalReason, 128) ||
    !Array.isArray(result.tests) ||
    result.tests.length > 100 ||
    !Array.isArray(result.capabilityAttempts) ||
    result.capabilityAttempts.length > 1_000 ||
    !Array.isArray(result.networkAttempts) ||
    result.networkAttempts.length > 1_000 ||
    result.resourceUsage.peakMemoryBytes > input.limits.memoryBytes ||
    result.resourceUsage.pids > input.limits.pids ||
    result.resourceUsage.outputBytes > input.limits.maxOutputBytes
  ) {
    fail('DEVELOPER_OCI_CONTROL_RESULT_INVALID');
  }
}

function safeText(value: unknown, maxLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength &&
    !/[\0\r\n]/.test(value)
  );
}
