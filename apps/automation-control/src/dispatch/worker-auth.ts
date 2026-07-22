import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { canonicalAutomationRequestJson } from '@kortix/intelligence-contracts';

export type WorkerServiceRole = 'automation-control' | 'browser-worker';

export type TlsPeerCertificate = Readonly<{
  /** Evidence reported by the trusted TLS adapter; this value does not itself perform TLS. */
  authorized: boolean;
  serviceId: string;
  fingerprint256: string;
  validTo: string;
}>;

export type VerifiedWorkerPeer = Readonly<{
  serviceId: string;
  role: WorkerServiceRole;
  certificateFingerprint256: string;
  certificateExpiresAt: string;
}>;

export type WorkerServiceProof = Readonly<{
  service_id: string;
  timestamp: string;
  nonce: number;
  signature: string;
}>;

export interface WorkerNonceStore {
  /**
   * Atomically consumes a nonce for a service identity. Production stores must be shared across
   * replicas and durable for at least the configured proof-skew window so replay protection
   * survives process restarts and replica changes.
   */
  consume(serviceId: string, nonce: number): Promise<boolean>;
}

export class WorkerAuthenticationError extends Error {
  override readonly name = 'WorkerAuthenticationError';
}

export class MemoryWorkerNonceStore implements WorkerNonceStore {
  /** Test/local-only storage; it is neither shared across replicas nor durable. */
  readonly #lastNonce = new Map<string, number>();

  async consume(serviceId: string, nonce: number): Promise<boolean> {
    const previous = this.#lastNonce.get(serviceId) ?? 0;
    if (!Number.isSafeInteger(nonce) || nonce <= previous) return false;
    this.#lastNonce.set(serviceId, nonce);
    return true;
  }
}

export function createMemoryWorkerNonceStore(): WorkerNonceStore {
  return new MemoryWorkerNonceStore();
}

type TrustedPeer = Readonly<{
  role: WorkerServiceRole;
  fingerprints: readonly string[];
  sharedSecret: string;
}>;

type AuthenticatorOptions = Readonly<{
  trustedPeers: Readonly<Record<string, TrustedPeer>>;
  nonceStore: WorkerNonceStore;
  now?: () => Date;
  maxSkewMs?: number;
}>;

type SignInput = Readonly<{
  serviceId: string;
  certificateFingerprint256: string;
  timestamp: Date;
  nonce: number;
  body: unknown;
}>;

function bodyHash(body: unknown): string {
  return createHash('sha256').update(canonicalAutomationRequestJson(body)).digest('hex');
}

function canonicalProof(input: {
  serviceId: string;
  certificateFingerprint256: string;
  timestamp: string;
  nonce: number;
  body: unknown;
}): string {
  return [
    input.timestamp,
    input.serviceId,
    input.certificateFingerprint256,
    input.nonce,
    bodyHash(input.body),
  ].join('\n');
}

function signatureFor(input: SignInput, secret: string): string {
  const timestamp = input.timestamp.toISOString();
  const digest = createHmac('sha256', secret)
    .update(
      canonicalProof({
        serviceId: input.serviceId,
        certificateFingerprint256: input.certificateFingerprint256,
        timestamp,
        nonce: input.nonce,
        body: input.body,
      }),
    )
    .digest('hex');
  return `hmac-sha256:${digest}`;
}

function signaturesEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function assertServiceId(serviceId: string): void {
  if (!/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(serviceId)) {
    throw new WorkerAuthenticationError('worker service identity is invalid');
  }
}

export type WorkerServiceAuthenticator = ReturnType<typeof createWorkerServiceAuthenticator>;

export function createWorkerServiceAuthenticator(options: AuthenticatorOptions) {
  const now = options.now ?? (() => new Date());
  const maxSkewMs = options.maxSkewMs ?? 60_000;
  if (!Number.isSafeInteger(maxSkewMs) || maxSkewMs < 1 || maxSkewMs > 5 * 60_000) {
    throw new WorkerAuthenticationError('worker authentication skew is invalid');
  }
  for (const [serviceId, peer] of Object.entries(options.trustedPeers)) {
    assertServiceId(serviceId);
    if (peer.fingerprints.length === 0 || peer.sharedSecret.length < 32) {
      throw new WorkerAuthenticationError('trusted worker configuration is invalid');
    }
  }
  const verifiedPeers = new WeakSet<object>();

  const assertPeer = (peer: VerifiedWorkerPeer, expectedRole: WorkerServiceRole): TrustedPeer => {
    if (!verifiedPeers.has(peer)) {
      throw new WorkerAuthenticationError('worker peer was not bound by the TLS adapter');
    }
    const trusted = options.trustedPeers[peer.serviceId];
    if (
      trusted === undefined ||
      trusted.role !== expectedRole ||
      peer.role !== expectedRole ||
      !trusted.fingerprints.includes(peer.certificateFingerprint256)
    ) {
      throw new WorkerAuthenticationError('worker service identity or certificate is not trusted');
    }
    if (Date.parse(peer.certificateExpiresAt) <= now().getTime()) {
      throw new WorkerAuthenticationError('worker certificate is expired');
    }
    return trusted;
  };

  return {
    /**
     * Records certificate evidence already verified by a trusted TLS adapter. This method does
     * not establish or validate a TLS connection merely because `authorized` is true.
     */
    bindTlsPeer(certificate: TlsPeerCertificate): VerifiedWorkerPeer {
      assertServiceId(certificate.serviceId);
      const trusted = options.trustedPeers[certificate.serviceId];
      const certificateExpiry = Date.parse(certificate.validTo);
      if (
        !certificate.authorized ||
        trusted === undefined ||
        !trusted.fingerprints.includes(certificate.fingerprint256) ||
        !Number.isFinite(certificateExpiry) ||
        certificateExpiry <= now().getTime()
      ) {
        throw new WorkerAuthenticationError('worker TLS certificate is not trusted or is expired');
      }
      const peer: VerifiedWorkerPeer = Object.freeze({
        serviceId: certificate.serviceId,
        role: trusted.role,
        certificateFingerprint256: certificate.fingerprint256,
        certificateExpiresAt: new Date(certificateExpiry).toISOString(),
      });
      verifiedPeers.add(peer);
      return peer;
    },

    assertPeer(peer: VerifiedWorkerPeer, expectedRole: WorkerServiceRole): void {
      assertPeer(peer, expectedRole);
    },

    sign(input: SignInput): WorkerServiceProof {
      const trusted = options.trustedPeers[input.serviceId];
      assertServiceId(input.serviceId);
      if (
        trusted === undefined ||
        !trusted.fingerprints.includes(input.certificateFingerprint256) ||
        !Number.isSafeInteger(input.nonce) ||
        input.nonce < 1 ||
        !Number.isFinite(input.timestamp.getTime())
      ) {
        throw new WorkerAuthenticationError('worker service signing input is invalid');
      }
      return Object.freeze({
        service_id: input.serviceId,
        timestamp: input.timestamp.toISOString(),
        nonce: input.nonce,
        signature: signatureFor(input, trusted.sharedSecret),
      });
    },

    async verify(input: {
      peer: VerifiedWorkerPeer;
      expectedRole: WorkerServiceRole;
      proof: WorkerServiceProof;
      body: unknown;
    }): Promise<void> {
      const trusted = assertPeer(input.peer, input.expectedRole);
      const timestamp = new Date(input.proof.timestamp);
      if (
        input.proof.service_id !== input.peer.serviceId ||
        !Number.isSafeInteger(input.proof.nonce) ||
        input.proof.nonce < 1 ||
        !Number.isFinite(timestamp.getTime()) ||
        Math.abs(now().getTime() - timestamp.getTime()) > maxSkewMs ||
        !/^hmac-sha256:[a-f0-9]{64}$/.test(input.proof.signature)
      ) {
        throw new WorkerAuthenticationError('worker service proof is malformed or stale');
      }
      const expected = signatureFor(
        {
          serviceId: input.proof.service_id,
          certificateFingerprint256: input.peer.certificateFingerprint256,
          timestamp,
          nonce: input.proof.nonce,
          body: input.body,
        },
        trusted.sharedSecret,
      );
      if (!signaturesEqual(expected, input.proof.signature)) {
        throw new WorkerAuthenticationError('worker service signature is invalid');
      }
      if (!(await options.nonceStore.consume(input.peer.serviceId, input.proof.nonce))) {
        throw new WorkerAuthenticationError('worker service proof replay was rejected');
      }
    },
  };
}
