import { timingSafeEqual } from 'node:crypto';
import type { Context } from 'hono';
import { CompactSign, importPKCS8, jwtVerify } from 'jose';

import { supabaseAuth } from '../middleware/auth';
import { assertProjectCapability, loadProjectForUser } from '../projects/lib/access';
import { db } from '../shared/db';
import { getDefaultStudioApiRuntime } from '../studio/default-routes';
import type { AppEnv } from '../types';
import { createModuleRuntimeApp } from './app';
import { ModuleExecutionService } from './executions';
import {
  createDrizzleModuleExecutionBindingResolver,
  createDrizzleModuleExecutionInputStore,
  createDrizzleModuleExecutionRepository,
  createDrizzleModuleRunnerRepository,
} from './executions.drizzle';
import {
  RuntimeArtifactService,
  createUnavailableRuntimeArtifactStore,
} from './runtime-artifacts';
import { createDrizzleRuntimeArtifactLeaseStore } from './runtime-artifacts.drizzle';
import { createRuntimeArtifactS3Store } from './runtime-artifacts.s3';
import {
  type ModuleRunnerIdentity,
  ModuleRunnerProtocol,
  ModuleRunnerProtocolError,
  type RunnerRegistrationIdentity,
} from './runner-protocol';

export * from './app';
export * from './execution-inputs';
export * from './executions';
export * from './executions.drizzle';
export * from './runtime-artifacts';
export * from './runtime-artifacts.drizzle';
export * from './runtime-artifacts.s3';
export * from './runner-protocol';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const THUMBPRINT = /^[0-9a-f]{64}$/;
const encoder = new TextEncoder();

function secret(name: string): Uint8Array | null {
  const value = process.env[name];
  return value && value.length >= 32 ? encoder.encode(value) : null;
}

function hasTrustedRunnerProxySecret(context: Context<AppEnv>): boolean {
  const expected = secret('OPENOPC_RUNNER_MTLS_PROXY_SECRET');
  const supplied = context.req.header('x-openopc-runner-proxy-secret');
  if (!expected || !supplied) return false;
  const actual = encoder.encode(supplied);
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
}

function trustedCertificateThumbprint(context: Context<AppEnv>): string {
  const verified = context.req.header('x-openopc-mtls-verified');
  const thumbprint = context.req.header('x-openopc-client-cert-sha256')?.toLowerCase();
  if (
    process.env.OPENOPC_TRUST_RUNNER_MTLS_HEADERS !== 'true' ||
    !hasTrustedRunnerProxySecret(context) ||
    verified !== 'SUCCESS' ||
    !thumbprint ||
    !THUMBPRINT.test(thumbprint)
  ) {
    throw new ModuleRunnerProtocolError('RUNNER_AUTHENTICATION_FAILED', 401);
  }
  return thumbprint;
}

async function runnerIdentity(context: Context<AppEnv>): Promise<ModuleRunnerIdentity> {
  const runnerId = context.req.header('x-openopc-runner-id');
  const accountId = context.req.header('x-openopc-runner-account-id');
  if (!runnerId || !accountId || !UUID.test(runnerId) || !UUID.test(accountId)) {
    throw new ModuleRunnerProtocolError('RUNNER_AUTHENTICATION_FAILED', 401);
  }
  return {
    runnerId,
    accountId,
    certificateThumbprint: trustedCertificateThumbprint(context),
  };
}

async function registrationIdentity(context: Context<AppEnv>): Promise<RunnerRegistrationIdentity> {
  return { certificateThumbprint: trustedCertificateThumbprint(context) };
}

export const moduleExecutionRepository = createDrizzleModuleExecutionRepository(db);
export const moduleExecutionInputStore = createDrizzleModuleExecutionInputStore(db);
export const moduleExecutionBindingResolver = createDrizzleModuleExecutionBindingResolver(db);
export const moduleExecutionService = new ModuleExecutionService({
  repository: moduleExecutionRepository,
  executionInputStore: moduleExecutionInputStore,
  bindingResolver: moduleExecutionBindingResolver,
});
export const moduleRunnerRepository = createDrizzleModuleRunnerRepository(db);
const moduleRuntimeStudioRuntime = (() => {
  try {
    return getDefaultStudioApiRuntime();
  } catch {
    return { enabled: false } as const;
  }
})();
export const moduleRuntimeArtifactStore = moduleRuntimeStudioRuntime.enabled
  ? createRuntimeArtifactS3Store(moduleRuntimeStudioRuntime.store)
  : createUnavailableRuntimeArtifactStore();
export const moduleRuntimeArtifactLeaseStore = createDrizzleRuntimeArtifactLeaseStore(db);
export const moduleRuntimeArtifactService = new RuntimeArtifactService({
  leaseStore: moduleRuntimeArtifactLeaseStore,
  artifactStore: moduleRuntimeArtifactStore,
});

export const moduleRunnerProtocol = new ModuleRunnerProtocol({
  executionRepository: moduleExecutionRepository,
  executionInputStore: moduleExecutionInputStore,
  runnerRepository: moduleRunnerRepository,
  bindingResolver: moduleExecutionBindingResolver,
  registrationVerifier: {
    async verify(input) {
      const key = secret('OPENOPC_RUNNER_REGISTRATION_SECRET');
      if (!key) return null;
      try {
        const verified = await jwtVerify(input.registrationToken, key, {
          algorithms: ['HS256'],
          issuer: 'openopc-control-plane',
          audience: 'openopc:runner-registration',
        });
        const accountId = verified.payload.accountId;
        const certificateThumbprint = verified.payload.certificateThumbprint;
        return typeof accountId === 'string' &&
          UUID.test(accountId) &&
          certificateThumbprint === input.certificateThumbprint
          ? { accountId }
          : null;
      } catch {
        return null;
      }
    },
  },
  capabilityIssuer: {
    async issueForClaim() {
      // Task 9 replaces this fail-closed empty issuer with audience-specific,
      // certificate-bound capability tokens.
      return [];
    },
  },
  envelopeSigner: {
    async sign(envelope, metadata) {
      const privateKey = process.env.OPENOPC_EXECUTION_SIGNING_PRIVATE_KEY?.replace(/\\n/g, '\n');
      if (!privateKey) throw new ModuleRunnerProtocolError('RUNNER_CLAIM_UNAVAILABLE', 503);
      const key = await importPKCS8(privateKey, 'EdDSA').catch(() => null);
      if (!key) throw new ModuleRunnerProtocolError('RUNNER_CLAIM_UNAVAILABLE', 503);
      return new CompactSign(encoder.encode(JSON.stringify(envelope)))
        .setProtectedHeader({
          alg: 'EdDSA',
          typ: 'openopc-work-envelope+jwt',
          kid: process.env.OPENOPC_EXECUTION_SIGNING_KEY_ID ?? 'staging-execution-v1',
          traceparent: metadata.traceparent,
        })
        .sign(key);
    },
  },
});

export const moduleRuntimeApp = createModuleRuntimeApp({
  authenticateUser: supabaseAuth,
  loadProjectForUser,
  assertProjectCapability,
  executionService: moduleExecutionService,
  runnerProtocol: moduleRunnerProtocol,
  runtimeArtifactService: moduleRuntimeArtifactService,
  authenticateRunner: runnerIdentity,
  registrationIdentity,
});
