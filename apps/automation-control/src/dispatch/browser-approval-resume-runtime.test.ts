import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import type { AutomationControlConfig } from '../config';
import { createBrowserApprovalResumeRuntime } from './browser-approval-resume-runtime';

const enabledConfig: AutomationControlConfig = {
  enabled: true,
  desktopCoordinatorEnabled: false,
  browserHeartbeatEnabled: true,
  browserApprovalResumeEnabled: true,
  browserDispatch: {
    enabled: true,
    workerUrl: 'wss://browser-worker.internal/',
    mtlsCertificatePath: resolve('secrets/control.crt'),
    mtlsPrivateKeyPath: resolve('secrets/control.key'),
    mtlsCaPath: resolve('secrets/ca.crt'),
    requestTimeoutMs: 5_000,
    maxMessageBytes: 64 * 1024,
  },
  port: 4011,
  automationApiUrl: 'https://api.example.test',
  databaseUrl: 'postgresql://db.example.test/automation',
  redisUrl: 'redis://redis.example.test:6379',
  serviceId: 'automation-control',
  sharedSecret: 'control-shared-secret-at-least-thirty-two-bytes',
  browserWorkerPeers: {},
  workerTlsAttestationSecret: 'worker-attestation-secret-at-least-thirty-two-bytes',
  workerProofSkewMs: 60_000,
  workerHeartbeatMaxBodyBytes: 64 * 1024,
  workerHeartbeatBodyReadTimeoutMs: 5_000,
  leaseMs: 30_000,
  coordinatorPollMs: 1_000,
  coordinatorBatchSize: 4,
};

const dependencies = {
  store: {
    async listCandidates() {
      return [];
    },
    async issue() {
      return null;
    },
  },
  leaseManager: {
    async claim() {
      return null;
    },
    async release() {},
  },
  dispatcher: {
    async dispatchResume() {
      throw new Error('not executed by runtime composition test');
    },
  },
  connection: {
    peer: {
      serviceId: 'browser-worker-1',
      role: 'browser-worker' as const,
      certificateFingerprint256: 'AA:BB:CC:DD',
      certificateExpiresAt: '2099-07-24T00:00:00.000Z',
    },
    async send() {
      throw new Error('not executed by runtime composition test');
    },
  },
};

test('keeps Browser approval resume runtime default-disabled behind every gate', () => {
  const disabledConfig: AutomationControlConfig = {
    ...enabledConfig,
    enabled: false,
    browserApprovalResumeEnabled: false,
    browserDispatch: { enabled: false },
  };

  expect(
    createBrowserApprovalResumeRuntime({ ...dependencies, config: disabledConfig }),
  ).toBeNull();
  expect(
    createBrowserApprovalResumeRuntime({
      ...dependencies,
      config: { ...enabledConfig, browserApprovalResumeEnabled: false },
    }),
  ).toBeNull();
  expect(
    createBrowserApprovalResumeRuntime({
      ...dependencies,
      config: { ...enabledConfig, browserApprovalResumeEnabled: true },
    }),
  ).not.toBeNull();
});
