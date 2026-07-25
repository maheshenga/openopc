import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { S3Client } from '@aws-sdk/client-s3';
import { parseRuntimeDescriptor } from '@openopc/module-runtime-contracts';
import postgres from 'postgres';

import type { EvidenceSigner } from './attestation';
import { createEd25519FileAttestationSigner } from './attestation/ed25519-file-signer';
import { createPostgresVerificationClaims } from './claims/postgres-claims';
import {
  type DeveloperTrustWorkerConfig,
  type DeveloperTrustWorkerEnabledConfig,
  loadDeveloperTrustWorkerConfig,
} from './config';
import { createDeveloperTrustHealthHandler } from './health';
import { createDeveloperTrustWorker } from './index';
import { DeveloperTrustPipeline, type DeveloperTrustWorkItem } from './pipeline';
import {
  type DeveloperTrustPolicyInput,
  type DeveloperTrustPolicyV1,
  defineDeveloperTrustPolicy,
} from './policy';
import { createDeveloperTrustReadiness } from './readiness';
import { createOciSandboxControl } from './sandbox/oci-control';
import { createDefaultSandboxProfile, createSandboxInput } from './sandbox/profile';
import type { DeveloperModuleSandboxInput, DeveloperModuleSandboxPort } from './sandbox/types';
import { createWasmtimeDryRun } from './sandbox/wasmtime-dry-run';
import { createGitleaksScanner } from './scanners/gitleaks';
import { createLicensePolicyScanner } from './scanners/license-policy';
import { createOsvScanner } from './scanners/osv';
import { createPinnedScannerCommandRunner } from './scanners/process-adapter';
import { createSemgrepScanner } from './scanners/semgrep';
import { createSyftScanner } from './scanners/syft';
import { type DeveloperScannerAdapter, evidenceDigest } from './scanners/types';
import { createS3ArtifactReader } from './storage/s3-artifacts';

interface AdapterState<T> {
  value: T | null;
}

export interface DeveloperTrustRuntime {
  config: DeveloperTrustWorkerConfig;
  readiness: ReturnType<typeof createDeveloperTrustReadiness>;
  worker: ReturnType<typeof createDeveloperTrustWorker> | null;
}

function portFromEnvironment(value: string | undefined): number {
  if (value === undefined) return 8080;
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('DEVELOPER_TRUST_PORT_INVALID');
  }
  return port;
}

function capture<T>(factory: () => T): AdapterState<T> {
  try {
    return { value: factory() };
  } catch {
    return { value: null };
  }
}

function requireAdapter<T>(state: AdapterState<T>): T {
  if (!state.value) throw new Error('DEVELOPER_TRUST_ADAPTER_UNAVAILABLE');
  return state.value;
}

export function buildDeveloperTrustRuntime(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): DeveloperTrustRuntime {
  const config = loadDeveloperTrustWorkerConfig(environment);
  if (!config.enabled) return disabledRuntime(config);

  const policy = capture(() =>
    defineDeveloperTrustPolicy(JSON.parse(config.policyJson) as DeveloperTrustPolicyInput),
  );
  const s3Client = capture(
    () =>
      new S3Client({
        endpoint: config.s3.endpoint,
        region: config.s3.region,
        forcePathStyle: config.s3.forcePathStyle,
        credentials: {
          accessKeyId: readSecret(config.s3.accessKeyIdFile, 1_024),
          secretAccessKey: readSecret(config.s3.secretAccessKeyFile, 4_096),
        },
      }),
  );
  const artifactReader = capture(() =>
    createS3ArtifactReader({
      client: requireAdapter(s3Client),
      bucket: config.s3.bucket,
      workspaceRoot: config.workspaceRoot,
      maxArtifactBytes: config.maxArtifactBytes,
    }),
  );
  const database = capture(() => {
    const databaseUrl = readSecret(config.databaseUrlFile, 4_096);
    const target = new URL(databaseUrl);
    if ((target.protocol !== 'postgres:' && target.protocol !== 'postgresql:') || target.hash) {
      throw new Error('DEVELOPER_TRUST_DATABASE_URL_INVALID');
    }
    return postgres(databaseUrl, {
      max: 4,
      connect_timeout: 5,
      idle_timeout: 30,
      prepare: true,
    });
  });
  const claims = capture(() => createPostgresVerificationClaims({ sql: requireAdapter(database) }));
  const signer = capture(() =>
    createEd25519FileAttestationSigner({
      environment: config.environment,
      keyId: config.attestation.keyId,
      issuer: config.attestation.issuer,
      privateKeyFile: config.attestation.privateKeyFile,
      publicKeyFile: config.attestation.publicKeyFile,
    }),
  );
  const wasmtime = capture(() =>
    createWasmtimeDryRun({
      executable: config.wasmtime.executable,
      expectedExecutableDigest: config.wasmtime.expectedDigest,
      expectedVersion: config.wasmtime.expectedVersion,
    }),
  );
  const oci = capture(() => {
    const base = `${config.oci.controlEndpoint}/`;
    const control = createOciSandboxControl({
      endpoint: new URL('v1/verification/run', base).href,
      controlToken: readSecret(config.oci.controlTokenFile, 4_096),
      verificationBrokerUrl: config.oci.verificationBrokerUrl,
      profileResolver: (profileName) => {
        const trustPolicy = requireAdapter(policy);
        return createDefaultSandboxProfile(trustPolicy.sandboxProfiles[profileName]);
      },
      transport: async (request) => {
        const response = await fetch(request.endpoint, {
          method: 'POST',
          redirect: 'error',
          headers: {
            authorization: `Bearer ${request.controlToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(request.body),
          signal: request.signal,
        });
        if (!response.ok) throw new Error('OCI_CONTROL_REJECTED');
        return (await readBoundedJson(response, 1024 * 1024)) as never;
      },
    });
    return {
      control,
      async assertReady() {
        const response = await fetch(new URL('readyz', base), {
          method: 'GET',
          redirect: 'error',
          signal: AbortSignal.timeout(2_000),
        });
        if (!response.ok) throw new Error('OCI_CONTROL_UNAVAILABLE');
      },
    };
  });
  const sandboxControl = capture(() => {
    const wasi = requireAdapter(wasmtime);
    const remote = requireAdapter(oci);
    return {
      port: {
        run(input, signal) {
          return input.runtime?.kind === 'wasi-component'
            ? wasi.run(input, signal)
            : remote.control.run(input, signal);
        },
      } satisfies DeveloperModuleSandboxPort,
      async assertReady() {
        await Promise.all([wasi.assertReady(), remote.assertReady()]);
      },
    };
  });

  const scannerRunner = createPinnedScannerCommandRunner();
  const scanners = capture(() => createScanners(config, requireAdapter(policy), scannerRunner));
  const readiness = createDeveloperTrustReadiness({
    enabled: true,
    components: {
      objectStorage: {
        probe: async () => {
          await requireAdapter(artifactReader).assertReady();
          return undefined;
        },
      },
      postgresClaims: {
        probe: async () => {
          await requireAdapter(claims).assertReady();
          return undefined;
        },
      },
      policy: {
        probe: async () => {
          requireAdapter(policy);
          return undefined;
        },
        unavailableReason: 'invalid',
      },
      gitleaks: scannerProbe(scanners, policy, 'gitleaks'),
      syft: scannerProbe(scanners, policy, 'syft'),
      osv: scannerProbe(scanners, policy, 'osv-scanner'),
      semgrep: scannerProbe(scanners, policy, 'semgrep'),
      licensePolicy: scannerProbe(scanners, policy, 'license-policy'),
      attestationSigner: {
        probe: async () => {
          await requireAdapter(signer).sign(Buffer.from('openopc-readiness-v1'));
          return undefined;
        },
        unavailableReason: 'not_configured',
      },
      sandboxControl: {
        probe: async () => {
          await requireAdapter(sandboxControl).assertReady();
          return undefined;
        },
      },
    },
  });

  const worker = capture(() =>
    createConcreteWorker({
      config,
      policy: requireAdapter(policy),
      scanners: requireAdapter(scanners),
      signer: requireAdapter(signer),
      claims: requireAdapter(claims),
      artifactReader: requireAdapter(artifactReader),
      sandboxControl: requireAdapter(sandboxControl).port,
    }),
  ).value;
  return { config, readiness, worker };
}

function disabledRuntime(
  config: Extract<DeveloperTrustWorkerConfig, { enabled: false }>,
): DeveloperTrustRuntime {
  const unavailable = async (): Promise<undefined> => {
    throw new Error('DEVELOPER_TRUST_DISABLED');
  };
  return {
    config,
    worker: null,
    readiness: createDeveloperTrustReadiness({
      enabled: false,
      components: {
        objectStorage: { probe: unavailable },
        postgresClaims: { probe: unavailable },
        policy: { probe: unavailable },
        gitleaks: { probe: unavailable },
        syft: { probe: unavailable },
        osv: { probe: unavailable },
        semgrep: { probe: unavailable },
        licensePolicy: { probe: unavailable },
        attestationSigner: { probe: unavailable },
        sandboxControl: { probe: unavailable },
      },
    }),
  };
}

function createScanners(
  config: DeveloperTrustWorkerEnabledConfig,
  policy: DeveloperTrustPolicyV1,
  runner: ReturnType<typeof createPinnedScannerCommandRunner>,
): DeveloperScannerAdapter[] {
  const licenseRuleDigest = evidenceDigest(config.allowedLicenses);
  const configuredLicenseRule = policy.scanners.find(
    (scanner) => scanner.name === 'license-policy',
  );
  const configuredSemgrepRule = policy.scanners.find((scanner) => scanner.name === 'semgrep');
  const semgrepRuleDigest = `sha256:${createHash('sha256')
    .update(readFileSync(config.semgrepRulesFile))
    .digest('hex')}`;
  if (!configuredLicenseRule || configuredLicenseRule.ruleDigest !== licenseRuleDigest) {
    throw new Error('LICENSE_POLICY_IDENTITY_MISMATCH');
  }
  if (!configuredSemgrepRule || configuredSemgrepRule.ruleDigest !== semgrepRuleDigest) {
    throw new Error('SEMGREP_POLICY_IDENTITY_MISMATCH');
  }
  return [
    createGitleaksScanner(runner),
    createSyftScanner(runner),
    createOsvScanner(runner),
    createSemgrepScanner(runner, { configPath: config.semgrepRulesFile }),
    createLicensePolicyScanner({ allowedLicenses: config.allowedLicenses }),
  ];
}

function scannerProbe(
  scanners: AdapterState<DeveloperScannerAdapter[]>,
  policy: AdapterState<DeveloperTrustPolicyV1>,
  name: DeveloperScannerAdapter['name'],
) {
  return {
    async probe() {
      const scanner = requireAdapter(scanners).find((candidate) => candidate.name === name);
      if (!scanner) return { ready: false as const, reason: 'not_configured' as const };
      try {
        await scanner.verifyIdentity(requireAdapter(policy));
      } catch {
        return { ready: false as const, reason: 'identity_mismatch' as const };
      }
    },
  };
}

function createConcreteWorker(input: {
  config: DeveloperTrustWorkerEnabledConfig;
  policy: DeveloperTrustPolicyV1;
  scanners: DeveloperScannerAdapter[];
  signer: EvidenceSigner;
  claims: ReturnType<typeof createPostgresVerificationClaims>;
  artifactReader: ReturnType<typeof createS3ArtifactReader>;
  sandboxControl: DeveloperModuleSandboxPort;
}) {
  const pipeline = new DeveloperTrustPipeline({
    policy: input.policy,
    scanners: input.scanners,
    signer: input.signer,
    sandbox: {
      port: input.sandboxControl,
      prepare: (item) => prepareSandbox(item, input.policy),
    },
  });
  return createDeveloperTrustWorker({
    workerId: input.config.workerId,
    leaseMs: input.config.leaseMs,
    control: input.claims,
    artifactProvider: {
      async prepare(claim) {
        if (!claim.artifactStorageKey || !claim.artifactSizeBytes) {
          throw new Error('DEVELOPER_TRUST_ARTIFACT_COORDINATE_MISSING');
        }
        const prepared = await input.artifactReader.prepare({
          storageKey: claim.artifactStorageKey,
          expectedDigest: claim.artifactDigest,
          expectedSize: claim.artifactSizeBytes,
        });
        return { ...claim, ...prepared };
      },
      async release(item) {
        await input.artifactReader.release(item.workspacePath);
      },
    },
    pipeline,
  });
}

async function prepareSandbox(item: DeveloperTrustWorkItem, policy: DeveloperTrustPolicyV1) {
  const sandboxInstanceId = `sandbox-${randomUUID()}`;
  const profile = createDefaultSandboxProfile(policy.sandboxProfiles[item.verificationProfile]);
  const runtime = await sandboxRuntime(item, profile.imageDigest);
  const wasi = runtime.kind === 'wasi-component';
  const input: DeveloperModuleSandboxInput = createSandboxInput({
    runId: item.runId,
    sandboxInstanceId,
    sandboxProfileDigest: item.sandboxProfileDigest,
    artifactDigest: item.artifactDigest,
    artifactMount: {
      source: item.workspacePath,
      target: '/artifact',
      digest: item.artifactDigest,
      readOnly: true,
    },
    profile: item.verificationProfile,
    fixtures: [],
    verificationCapability: randomBytes(32).toString('base64url'),
    limits: profile.limits,
    networkPolicy: {
      mode: wasi ? 'none' : profile.networkMode,
      allowedOrigins: [],
      allowedMethods: ['GET', 'HEAD', 'POST'],
      maxRequestBytes: 1024 * 1024,
      maxResponseBytes: 4 * 1024 * 1024,
      maxRedirects: 0,
    },
    runtime,
  });
  return { sandboxInstanceId, input };
}

async function sandboxRuntime(
  item: DeveloperTrustWorkItem,
  verificationImageDigest: `sha256:${string}`,
): Promise<NonNullable<DeveloperModuleSandboxInput['runtime']>> {
  if (item.runtimeDescriptorPath) {
    const path = safeArtifactPath(item.workspacePath, item.runtimeDescriptorPath);
    const bytes = await Bun.file(path).arrayBuffer();
    if (bytes.byteLength < 1 || bytes.byteLength > 1024 * 1024) {
      throw new Error('RUNTIME_DESCRIPTOR_INVALID');
    }
    const descriptor = parseRuntimeDescriptor(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
    );
    if (descriptor.runtime.kind !== item.runtimeKind)
      throw new Error('RUNTIME_DESCRIPTOR_MISMATCH');
    return descriptor.runtime.kind === 'wasi-component'
      ? {
          kind: 'wasi-component',
          componentPath: descriptor.runtime.component,
          world: descriptor.runtime.world,
          operation: descriptor.runtime.operation,
        }
      : {
          kind: 'oci-image',
          image: descriptor.runtime.image,
          command: descriptor.runtime.command,
          args: descriptor.runtime.args,
          profile: descriptor.runtime.profile,
        };
  }
  return {
    kind: 'oci-image',
    image: verificationImageDigest,
    command: ['/openopc/bin/verify-module'],
    args: [item.verificationProfile],
    profile: 'openopc-verification-v1',
  };
}

function safeArtifactPath(workspacePath: string, relativePath: string): string {
  if (
    relativePath.startsWith('/') ||
    relativePath.includes('\\') ||
    relativePath.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new Error('RUNTIME_DESCRIPTOR_PATH_INVALID');
  }
  return join(workspacePath, relativePath);
}

function readSecret(path: string, maxBytes: number): string {
  const bytes = readFileSync(path);
  if (bytes.byteLength < 1 || bytes.byteLength > maxBytes) {
    throw new Error('DEVELOPER_TRUST_SECRET_INVALID');
  }
  const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim();
  if (!value || /[\0\r\n]/.test(value)) throw new Error('DEVELOPER_TRUST_SECRET_INVALID');
  return value;
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  if (!response.body) throw new Error('RESPONSE_BODY_MISSING');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > maxBytes) throw new Error('RESPONSE_BODY_TOO_LARGE');
    chunks.push(next.value);
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
}

export function startDeveloperTrustWorkerServer(
  environment: Readonly<Record<string, string | undefined>> = process.env,
) {
  const runtime = buildDeveloperTrustRuntime(environment);
  if (runtime.config.enabled && runtime.worker) {
    const poll = async () => {
      try {
        const readiness = await runtime.readiness.check();
        if (readiness.ready) await runtime.worker?.runOnce();
      } catch {
        // A failed claim remains leased until PostgreSQL expiry and is retried by a later poll.
      } finally {
        const timeout = setTimeout(poll, runtime.config.pollMs);
        timeout.unref?.();
      }
    };
    void poll();
  }
  return Bun.serve({
    hostname: '0.0.0.0',
    port: portFromEnvironment(environment.DEVELOPER_TRUST_PORT),
    fetch: createDeveloperTrustHealthHandler(runtime.readiness),
  });
}

if (import.meta.main) startDeveloperTrustWorkerServer();
