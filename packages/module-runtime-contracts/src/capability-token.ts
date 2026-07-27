import addFormats from 'ajv-formats';
import Ajv2020 from 'ajv/dist/2020';

import capabilityTokenSchema from '../schema/capability-token.v1.schema.json';

export type CapabilityAudience = 'secret' | 'egress' | 'model' | 'desktop' | 'paid-call';

export interface CapabilityTokenClaimsV1 {
  capabilityVersion: 1;
  iss: 'openopc-control-plane';
  aud: `openopc:capability/${CapabilityAudience}`;
  sub: string;
  jti: string;
  iat: string;
  exp: string;
  grantId: string;
  accountId: string;
  projectId: string;
  installationId: string;
  releaseDigest: `sha256:${string}`;
  actor: { type: 'runner' | 'user' | 'system'; id: string };
  action: string;
  runtimeKind: 'wasi-component' | 'oci-image';
  lease: { id: string; generation: number; deadline: string };
  killSwitchGeneration: number;
  cnf: { certificateSha256: string };
  ceilings: {
    maxCalls: number;
    maxRequestBytes: number;
    maxResponseBytes: number;
    cpuMillis: number;
    wallTimeMs: number;
    costMicro: number;
  };
  egress?: { origins: string[]; methods: string[] };
}

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validateCapabilityToken = ajv.compile<CapabilityTokenClaimsV1>(capabilityTokenSchema);

function invalid(): never {
  throw new Error('CAPABILITY_TOKEN_CLAIMS_INVALID');
}

function validOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.username === '' &&
      url.password === '' &&
      url.pathname === '/' &&
      url.search === '' &&
      url.hash === '' &&
      url.origin === value &&
      !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(url.hostname) &&
      !url.hostname.startsWith('[')
    );
  } catch {
    return false;
  }
}

function sortedUnique(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || values[index - 1] < value);
}

export function parseCapabilityTokenClaims(value: unknown): CapabilityTokenClaimsV1 {
  if (!validateCapabilityToken(value)) invalid();
  const issuedAt = Date.parse(value.iat);
  const expiresAt = Date.parse(value.exp);
  const leaseDeadline = Date.parse(value.lease.deadline);
  if (
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > 15 * 60 * 1000 ||
    expiresAt > leaseDeadline ||
    (value.aud === 'openopc:capability/egress') !== Boolean(value.egress) ||
    (value.egress &&
      (!value.egress.origins.every(validOrigin) ||
        !sortedUnique(value.egress.origins) ||
        !sortedUnique(value.egress.methods)))
  ) {
    invalid();
  }
  return value;
}
