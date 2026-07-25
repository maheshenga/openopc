import type { RegistryModuleVerificationProfile } from '@kortix/registry';

export interface ReadonlyArtifactMount {
  source: string;
  target: '/artifact';
  digest: `sha256:${string}`;
  readOnly: true;
}

export interface SyntheticCapabilityFixture {
  action: string;
  response: unknown;
}

export interface SandboxResourceLimits {
  cpuMillis: number;
  memoryBytes: number;
  pids: number;
  fileDescriptors: number;
  maxFileBytes: number;
  maxOutputBytes: number;
  wallTimeMs: number;
}

export interface DeveloperModuleNetworkPolicy {
  mode: 'none' | 'egress-proxy';
  allowedOrigins: readonly string[];
  allowedMethods: readonly ('GET' | 'HEAD' | 'POST')[];
  maxRequestBytes: number;
  maxResponseBytes: number;
  maxRedirects: number;
}

export interface DeveloperModuleSandboxInput {
  runId?: string;
  sandboxInstanceId?: string;
  sandboxProfileDigest?: `sha256:${string}`;
  artifactDigest: `sha256:${string}`;
  artifactMount: ReadonlyArtifactMount;
  profile: RegistryModuleVerificationProfile;
  fixtures: readonly SyntheticCapabilityFixture[];
  verificationCapability: string;
  limits: SandboxResourceLimits;
  networkPolicy: DeveloperModuleNetworkPolicy;
  runtime?:
    | {
        kind: 'wasi-component';
        componentPath: string;
        world: string;
        operation: string;
      }
    | {
        kind: 'oci-image';
        image: `sha256:${string}`;
        command: readonly string[];
        args: readonly string[];
        profile: string;
      };
}

export interface DeveloperModuleSandboxProfile {
  profile: RegistryModuleVerificationProfile;
  profileDigest: `sha256:${string}`;
  imageDigest: `sha256:${string}`;
  networkMode: 'none' | 'egress-proxy';
  identity: { uid: number; gid: number };
  rootFilesystem: { readOnly: true };
  scratch: { kind: 'tmpfs'; sizeBytes: number };
  security: {
    capabilities: readonly [];
    noNewPrivileges: true;
    seccompProfile: string;
    hostIpc: false;
    hostPid: false;
    hostNetwork: false;
  };
  limits: SandboxResourceLimits;
}

export interface DeveloperModuleSandboxResult {
  runId: string;
  sandboxInstanceId: string;
  artifactDigest: `sha256:${string}`;
  sandboxProfileDigest: `sha256:${string}`;
  state: 'passed' | 'failed' | 'inconclusive' | 'cancelled';
  terminalReason: string;
  stdoutDigest: `sha256:${string}`;
  stderrDigest: `sha256:${string}`;
  evidenceDigest: `sha256:${string}`;
  resourceUsage: {
    cpuMillis: number;
    peakMemoryBytes: number;
    pids: number;
    outputBytes: number;
  };
  tests: ReadonlyArray<{ id: string; outcome: 'passed' | 'failed'; summary: string }>;
  capabilityAttempts: ReadonlyArray<{
    action: string;
    outcome: 'allowed' | 'denied';
  }>;
  networkAttempts: ReadonlyArray<{
    origin: string;
    method: string;
    outcome: 'allowed' | 'denied';
  }>;
}

export interface DeveloperModuleSandboxPort {
  run(
    input: DeveloperModuleSandboxInput,
    signal: AbortSignal,
  ): Promise<DeveloperModuleSandboxResult>;
}
