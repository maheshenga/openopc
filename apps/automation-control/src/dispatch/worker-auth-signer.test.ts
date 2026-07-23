import { expect, test } from 'bun:test';
import { createWorkerServiceSigner } from './worker-auth';

const JOB_ID = '40000000-0000-4000-a000-000000000001';
const NOW = new Date('2099-07-22T08:00:00.000Z');

test('signs outbound Control proofs with its dedicated identity', () => {
  const signer = createWorkerServiceSigner({
    serviceId: 'automation-control',
    certificateFingerprint256: 'AA:BB:CC',
    sharedSecret: 'control-worker-secret-at-least-32-bytes',
    nextNonce: () => 101,
  });

  expect(signer.sign({ job_id: JOB_ID }, NOW)).toMatchObject({
    service_id: 'automation-control',
    nonce: 101,
    timestamp: NOW.toISOString(),
  });
});

test('rejects a repeated outbound signer nonce', () => {
  const signer = createWorkerServiceSigner({
    serviceId: 'automation-control',
    certificateFingerprint256: 'AA:BB:CC',
    sharedSecret: 'control-worker-secret-at-least-32-bytes',
    nextNonce: () => 101,
  });

  signer.sign({ job_id: JOB_ID }, NOW);

  expect(() => signer.sign({ job_id: JOB_ID }, NOW)).toThrow(/nonce.*invalid/i);
});
