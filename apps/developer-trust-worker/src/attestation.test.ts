import { describe, expect, test } from 'bun:test';
import { generateKeyPairSync, verify } from 'node:crypto';

import {
  DeveloperTrustAttestationError,
  type OpenOpcDeveloperTrustPredicateV1,
  createDeveloperTrustAttestation,
  createEd25519EvidenceSigner,
  dssePreAuthEncoding,
  validateOptionalSigstoreBundle,
  verifyDeveloperTrustAttestation,
} from './attestation';

const digest = (character: string) => `sha256:${character.repeat(64)}` as const;

function predicate() {
  return {
    artifactDigest: digest('a'),
    policyDigest: digest('b'),
    scannerSetDigest: digest('c'),
    sandboxProfileDigest: digest('d'),
    sbomDigest: digest('e'),
    runId: '50000000-0000-4000-a000-000000000005',
    attempt: 1,
    result: 'passed' as const,
    scannerIdentities: [`gitleaks@1.0.0#${digest('1')}`],
    scannerIdentityVerified: true,
    evidenceDigests: [digest('f')],
    startedAt: '2026-07-25T00:00:00.000Z',
    finishedAt: '2026-07-25T00:00:01.000Z',
  };
}

describe('developer trust attestation', () => {
  test('uses exact DSSE PAE bytes', () => {
    expect(dssePreAuthEncoding('test', Buffer.from('abc'))).toEqual(
      Buffer.from('DSSEv1 4 test 3 abc'),
    );
  });

  test('creates deterministic Ed25519 DSSE/in-toto evidence bound to the artifact', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const signer = createEd25519EvidenceSigner({
      privateKey,
      keyId: 'openopc-worker-test',
      issuer: 'openopc-developer-trust-worker',
    });
    const input = {
      moduleId: 'acme.clean',
      moduleVersion: '1.0.0',
      predicate: predicate(),
      signer,
    };
    const first = await createDeveloperTrustAttestation(input);
    const second = await createDeveloperTrustAttestation(input);

    expect(first).toEqual(second);
    expect(first.envelope.payloadType).toBe('application/vnd.in-toto+json');
    expect(first.statement.subject).toEqual([
      { name: 'acme.clean@1.0.0', digest: { sha256: 'a'.repeat(64) } },
    ]);
    const payload = Buffer.from(first.envelope.payload, 'base64');
    const signature = Buffer.from(first.envelope.signatures[0].sig, 'base64');
    expect(
      verify(null, dssePreAuthEncoding(first.envelope.payloadType, payload), publicKey, signature),
    ).toBe(true);
    expect(first.attestationDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test('verifies its own Ed25519 signatures and rejects a one-byte mutation', async () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const signer = createEd25519EvidenceSigner({
      privateKey,
      keyId: 'openopc-worker-test',
      issuer: 'openopc-developer-trust-worker',
    });
    const payload = Buffer.from('openopc-invalid-signature-acceptance-v1');
    const signature = await signer.sign(payload);
    const mutated = Buffer.from(signature);
    mutated[0] ^= 1;

    await expect(signer.verify(payload, signature)).resolves.toBe(true);
    await expect(signer.verify(payload, mutated)).resolves.toBe(false);
  });

  test('verifies a complete DSSE envelope and rejects a corrupted signature', async () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const signer = createEd25519EvidenceSigner({
      privateKey,
      keyId: 'openopc-worker-test',
      issuer: 'openopc-developer-trust-worker',
    });
    const signed = await createDeveloperTrustAttestation({
      moduleId: 'acme.clean',
      moduleVersion: '1.0.0',
      predicate: predicate(),
      signer,
    });
    const corrupted = structuredClone(signed.envelope);
    const signature = Buffer.from(corrupted.signatures[0].sig, 'base64');
    signature[0] ^= 1;
    corrupted.signatures[0].sig = signature.toString('base64');

    await expect(
      verifyDeveloperTrustAttestation({ envelope: signed.envelope, signer }),
    ).resolves.toBe(true);
    await expect(verifyDeveloperTrustAttestation({ envelope: corrupted, signer })).resolves.toBe(
      false,
    );
  });

  test('requires a verifier for optional Sigstore bundles and binds a verified bundle digest', async () => {
    const bundle = {
      mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
      verificationMaterial: {},
    };
    await expect(
      validateOptionalSigstoreBundle({ bundle, subjectDigest: digest('a') }),
    ).rejects.toBeInstanceOf(DeveloperTrustAttestationError);
    const verified = await validateOptionalSigstoreBundle({
      bundle,
      subjectDigest: digest('a'),
      verifier: { verify: async () => true },
    });
    await expect(
      validateOptionalSigstoreBundle({
        bundle,
        subjectDigest: digest('a'),
        verifier: { verify: async () => false },
      }),
    ).rejects.toBeInstanceOf(DeveloperTrustAttestationError);

    expect(verified).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test('refuses to sign a predicate with an invalid runtime result', async () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const signer = createEd25519EvidenceSigner({
      privateKey,
      keyId: 'openopc-worker-test',
      issuer: 'openopc-developer-trust-worker',
    });

    await expect(
      createDeveloperTrustAttestation({
        moduleId: 'acme.clean',
        moduleVersion: '1.0.0',
        predicate: { ...predicate(), result: 'unknown' as 'passed' },
        signer,
      }),
    ).rejects.toBeInstanceOf(DeveloperTrustAttestationError);
  });

  test('refuses to sign a predicate with partial acceptance context', async () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const signer = createEd25519EvidenceSigner({
      privateKey,
      keyId: 'openopc-worker-test',
      issuer: 'openopc-developer-trust-worker',
    });

    await expect(
      createDeveloperTrustAttestation({
        moduleId: 'acme.clean',
        moduleVersion: '1.0.0',
        predicate: {
          ...predicate(),
          acceptance: {
            acceptanceRunId: 'module-beta-run-1',
          },
        } as unknown as OpenOpcDeveloperTrustPredicateV1,
        signer,
      }),
    ).rejects.toBeInstanceOf(DeveloperTrustAttestationError);
  });
});
