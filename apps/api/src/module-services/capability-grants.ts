import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { sign, verify as verifyPaseto } from 'paseto-ts/v4';

import {
  type ModuleServiceCapabilityClaimsV1,
  ModuleServiceCapabilityRequestSchema,
  type OpenOpcServiceName,
  type OpenOpcServiceOperation,
  parseModuleServiceCapabilityClaims,
} from '@kortix/api-contract';
import { type RegistryModuleManifest, moduleServiceOperations } from '@kortix/registry';

const MAX_CAPABILITY_LIFETIME_MS = 5 * 60 * 1000;
const MAX_TOKEN_LENGTH = 16_384;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ModuleServiceCapabilityErrorCode =
  | 'MODULE_SERVICE_INPUT_INVALID'
  | 'MODULE_SERVICE_UNAVAILABLE'
  | 'MODULE_SERVICE_INSTALLATION_NOT_FOUND'
  | 'MODULE_SERVICE_INSTALLATION_STALE'
  | 'MODULE_SERVICE_RELEASE_REVOKED'
  | 'MODULE_SERVICE_NOT_DECLARED'
  | 'MODULE_SERVICE_CONSENT_REQUIRED'
  | 'MODULE_SERVICE_CONSENT_REVOKED'
  | 'MODULE_SERVICE_CAPABILITY_INVALID'
  | 'MODULE_SERVICE_CAPABILITY_EXPIRED'
  | 'MODULE_SERVICE_CAPABILITY_REVOKED'
  | 'MODULE_SERVICE_CAPABILITY_SCOPE_MISMATCH'
  | 'MODULE_SERVICE_OPERATION_DENIED'
  | 'MODULE_SERVICE_CONFLICT'
  | 'MODULE_AI_PROVIDER_UNAVAILABLE';

export class ModuleServiceCapabilityError extends Error {
  constructor(
    readonly code: ModuleServiceCapabilityErrorCode,
    readonly status: 400 | 401 | 403 | 404 | 409 | 503,
  ) {
    super(code);
    this.name = 'ModuleServiceCapabilityError';
  }
}

export interface ModuleServiceInstallationContext {
  accountId: string;
  projectId: string;
  installationId: string;
  installRevision: number;
  releaseId: string;
  moduleId: string;
  moduleVersion: string;
  installationStatus: 'active' | 'blocked';
  releaseStatus: string;
  signatureAlgorithm: string | null;
  signature: string | null;
  signedAt: string | null;
  manifest: RegistryModuleManifest;
}

export interface ModuleServiceConsent {
  consentId: string;
  accountId: string;
  projectId: string;
  installationId: string;
  releaseId: string;
  installRevision: number;
  service: OpenOpcServiceName;
  operations: OpenOpcServiceOperation[];
  consentDigest: `sha256:${string}`;
  acceptedBy: string;
  acceptedAt: string;
  revokedBy: string | null;
  revokedAt: string | null;
}

export interface ModuleServiceCapabilityGrant {
  grantId: string;
  accountId: string;
  projectId: string;
  installationId: string;
  releaseId: string;
  consentId: string;
  service: OpenOpcServiceName;
  operations: OpenOpcServiceOperation[];
  tokenHash: `sha256:${string}`;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
}

export type ModuleServiceAuditOutcome =
  | 'consent_granted'
  | 'issued'
  | 'authorized'
  | 'denied'
  | 'revoked';

export interface AppendModuleServiceAuditInput {
  eventId: string;
  accountId: string;
  projectId: string;
  installationId: string;
  releaseId: string;
  grantId: string | null;
  service: OpenOpcServiceName;
  operation: OpenOpcServiceOperation | null;
  outcome: ModuleServiceAuditOutcome;
  code: ModuleServiceCapabilityErrorCode | null;
  requestId: string;
  createdAt: string;
}

export interface CreateModuleServiceConsentInput {
  consent: ModuleServiceConsent;
  audit: AppendModuleServiceAuditInput;
}

export interface PersistModuleServiceCapabilityGrantInput {
  grantId: string;
  accountId: string;
  projectId: string;
  installationId: string;
  installRevision: number;
  releaseId: string;
  consentId: string;
  service: OpenOpcServiceName;
  operations: readonly OpenOpcServiceOperation[];
  tokenHash: `sha256:${string}`;
  expiresAt: string;
  createdAt: string;
  audit: AppendModuleServiceAuditInput;
}

export interface ModuleServiceCapabilityRepository {
  resolveInstallation(input: {
    accountId: string;
    projectId: string;
    installationId: string;
  }): Promise<ModuleServiceInstallationContext | null>;
  listConsents(input: {
    accountId: string;
    projectId: string;
    installationId: string;
  }): Promise<readonly ModuleServiceConsent[]>;
  findActiveConsent(input: {
    accountId: string;
    projectId: string;
    installationId: string;
    releaseId: string;
    installRevision: number;
    service: OpenOpcServiceName;
  }): Promise<ModuleServiceConsent | null>;
  createConsent(input: CreateModuleServiceConsentInput): Promise<ModuleServiceConsent>;
  storeGrant(
    input: PersistModuleServiceCapabilityGrantInput,
  ): Promise<ModuleServiceCapabilityGrant>;
  getAuthorization(grantId: string): Promise<{
    grant: ModuleServiceCapabilityGrant;
    consent: ModuleServiceConsent;
    installation: ModuleServiceInstallationContext;
  } | null>;
  revokeByConsent(input: {
    consentId: string;
    actorUserId: string;
    revokedAt: string;
    auditEventId: string;
    requestId: string;
  }): Promise<{ consent: ModuleServiceConsent; revokedGrantCount: number } | null>;
  appendAudit(input: AppendModuleServiceAuditInput): Promise<void>;
}

export interface IssueModuleServiceCapabilityInput {
  accountId: string;
  projectId: string;
  installationId: string;
  installRevision: number;
  service: OpenOpcServiceName;
  operations: readonly OpenOpcServiceOperation[];
  actorUserId: string;
}

export interface RequireModuleServiceCapabilityInput {
  accountId: string;
  projectId: string;
  installationId: string;
  installRevision: number;
  releaseId: string;
  service: OpenOpcServiceName;
  operation: OpenOpcServiceOperation;
}

export interface ManageModuleServiceConsentInput {
  accountId: string;
  projectId: string;
  installationId: string;
  installRevision: number;
  service: OpenOpcServiceName;
  actorUserId: string;
}

function fail(
  code: ModuleServiceCapabilityErrorCode,
  status: ModuleServiceCapabilityError['status'],
): never {
  throw new ModuleServiceCapabilityError(code, status);
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function tokenKeyId(token: string): string | null {
  if (token.length > MAX_TOKEN_LENGTH) return null;
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== 'v4' || parts[1] !== 'public' || !parts[3]) return null;
  try {
    const footer = JSON.parse(Buffer.from(parts[3], 'base64url').toString('utf8')) as unknown;
    if (
      !footer ||
      typeof footer !== 'object' ||
      Array.isArray(footer) ||
      Object.keys(footer).length !== 1 ||
      typeof (footer as { kid?: unknown }).kid !== 'string'
    ) {
      return null;
    }
    return (footer as { kid: string }).kid;
  } catch {
    return null;
  }
}

function sameOperations(
  left: readonly OpenOpcServiceOperation[],
  right: readonly OpenOpcServiceOperation[],
): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertUuid(value: string): void {
  if (!UUID_V4.test(value)) fail('MODULE_SERVICE_INPUT_INVALID', 400);
}

function assertPublishedInstallation(installation: ModuleServiceInstallationContext): void {
  if (installation.installationStatus !== 'active') {
    fail('MODULE_SERVICE_INSTALLATION_STALE', 409);
  }
  if (
    installation.releaseStatus !== 'published' ||
    installation.signatureAlgorithm !== 'ed25519' ||
    !installation.signature ||
    !/^base64url:[A-Za-z0-9_-]{86}$/.test(installation.signature) ||
    !installation.signedAt
  ) {
    fail('MODULE_SERVICE_RELEASE_REVOKED', 409);
  }
}

function assertDeclaredOperations(
  installation: ModuleServiceInstallationContext,
  service: OpenOpcServiceName,
  operations: readonly OpenOpcServiceOperation[],
): void {
  const declared = moduleServiceOperations(installation.manifest, service);
  if (
    installation.manifest.id !== installation.moduleId ||
    installation.manifest.version !== installation.moduleVersion ||
    operations.some((operation) => !declared.includes(operation))
  ) {
    fail('MODULE_SERVICE_NOT_DECLARED', 403);
  }
}

export function hashModuleServiceCapabilityToken(token: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(token).digest('hex')}`;
}

function moduleServiceConsentDigest(input: {
  accountId: string;
  projectId: string;
  installationId: string;
  releaseId: string;
  installRevision: number;
  service: OpenOpcServiceName;
  operations: readonly OpenOpcServiceOperation[];
}): `sha256:${string}` {
  const encoded = JSON.stringify({ schemaVersion: 1, ...input });
  return `sha256:${createHash('sha256').update(encoded).digest('hex')}`;
}

export class ModuleServiceConsentManager {
  private readonly repository: ModuleServiceCapabilityRepository;
  private readonly now: () => Date;
  private readonly createConsentId: () => string;
  private readonly createAuditId: () => string;
  private readonly createRequestId: () => string;

  constructor(input: {
    repository: ModuleServiceCapabilityRepository;
    now?: () => Date;
    createConsentId?: () => string;
    createAuditId?: () => string;
    createRequestId?: () => string;
  }) {
    this.repository = input.repository;
    this.now = input.now ?? (() => new Date());
    this.createConsentId = input.createConsentId ?? randomUUID;
    this.createAuditId = input.createAuditId ?? randomUUID;
    this.createRequestId = input.createRequestId ?? randomUUID;
  }

  async currentInstallation(input: {
    accountId: string;
    projectId: string;
    installationId: string;
  }): Promise<ModuleServiceInstallationContext> {
    const current = await this.repository.resolveInstallation(input);
    if (!current) fail('MODULE_SERVICE_INSTALLATION_NOT_FOUND', 404);
    return current;
  }

  async list(input: {
    accountId: string;
    projectId: string;
    installationId: string;
  }): Promise<readonly ModuleServiceConsent[]> {
    await this.currentInstallation(input);
    return this.repository.listConsents(input);
  }

  async grant(
    input: ManageModuleServiceConsentInput & {
      operations: readonly OpenOpcServiceOperation[];
    },
  ): Promise<ModuleServiceConsent> {
    assertUuid(input.accountId);
    assertUuid(input.projectId);
    assertUuid(input.installationId);
    assertUuid(input.actorUserId);
    if (!Number.isSafeInteger(input.installRevision) || input.installRevision <= 0) {
      fail('MODULE_SERVICE_INPUT_INVALID', 400);
    }
    const request = ModuleServiceCapabilityRequestSchema.safeParse({
      service: input.service,
      operations: [...input.operations],
    });
    if (!request.success) fail('MODULE_SERVICE_INPUT_INVALID', 400);
    const current = await this.currentInstallation(input);
    if (current.installRevision !== input.installRevision) {
      fail('MODULE_SERVICE_INSTALLATION_STALE', 409);
    }
    assertPublishedInstallation(current);
    assertDeclaredOperations(current, request.data.service, request.data.operations);
    const requested = new Set<OpenOpcServiceOperation>(request.data.operations);
    const normalized = moduleServiceOperations(current.manifest, request.data.service).filter(
      (operation) => requested.has(operation),
    );
    const existing = await this.repository.findActiveConsent({
      accountId: input.accountId,
      projectId: input.projectId,
      installationId: input.installationId,
      releaseId: current.releaseId,
      installRevision: current.installRevision,
      service: request.data.service,
    });
    if (existing) {
      if (sameOperations(existing.operations, normalized)) return existing;
      fail('MODULE_SERVICE_CONFLICT', 409);
    }

    const acceptedAt = this.now().toISOString();
    const consentId = this.createConsentId();
    const eventId = this.createAuditId();
    const requestId = this.createRequestId();
    assertUuid(consentId);
    assertUuid(eventId);
    assertUuid(requestId);
    const consent: ModuleServiceConsent = {
      consentId,
      accountId: current.accountId,
      projectId: current.projectId,
      installationId: current.installationId,
      releaseId: current.releaseId,
      installRevision: current.installRevision,
      service: request.data.service,
      operations: [...normalized],
      consentDigest: moduleServiceConsentDigest({
        accountId: current.accountId,
        projectId: current.projectId,
        installationId: current.installationId,
        releaseId: current.releaseId,
        installRevision: current.installRevision,
        service: request.data.service,
        operations: normalized,
      }),
      acceptedBy: input.actorUserId,
      acceptedAt,
      revokedBy: null,
      revokedAt: null,
    };
    try {
      return await this.repository.createConsent({
        consent,
        audit: {
          eventId,
          accountId: current.accountId,
          projectId: current.projectId,
          installationId: current.installationId,
          releaseId: current.releaseId,
          grantId: null,
          service: request.data.service,
          operation: null,
          outcome: 'consent_granted',
          code: null,
          requestId,
          createdAt: acceptedAt,
        },
      });
    } catch (error) {
      if (error instanceof ModuleServiceCapabilityError) throw error;
      fail('MODULE_SERVICE_CONFLICT', 409);
    }
  }

  async revoke(
    input: ManageModuleServiceConsentInput,
  ): Promise<{ consent: ModuleServiceConsent; revokedGrantCount: number }> {
    assertUuid(input.accountId);
    assertUuid(input.projectId);
    assertUuid(input.installationId);
    assertUuid(input.actorUserId);
    if (
      !Number.isSafeInteger(input.installRevision) ||
      input.installRevision <= 0 ||
      (input.service !== 'ai' && input.service !== 'payment')
    ) {
      fail('MODULE_SERVICE_INPUT_INVALID', 400);
    }
    const current = await this.currentInstallation(input);
    if (current.installRevision !== input.installRevision) {
      fail('MODULE_SERVICE_INSTALLATION_STALE', 409);
    }
    const active = await this.repository.findActiveConsent({
      accountId: input.accountId,
      projectId: input.projectId,
      installationId: input.installationId,
      releaseId: current.releaseId,
      installRevision: current.installRevision,
      service: input.service,
    });
    if (!active) fail('MODULE_SERVICE_CONSENT_REQUIRED', 404);
    const revokedAt = this.now().toISOString();
    const result = await this.repository.revokeByConsent({
      consentId: active.consentId,
      actorUserId: input.actorUserId,
      revokedAt,
      auditEventId: this.createAuditId(),
      requestId: this.createRequestId(),
    });
    if (!result) fail('MODULE_SERVICE_CONFLICT', 409);
    return result;
  }
}

export class ModuleServiceCapabilityBroker {
  private readonly repository: ModuleServiceCapabilityRepository;
  private readonly secretKey: string;
  private readonly publicKey: string;
  private readonly keyId: string;
  private readonly now: () => Date;
  private readonly createGrantId: () => string;
  private readonly createJti: () => string;
  private readonly createAuditId: () => string;

  constructor(input: {
    repository: ModuleServiceCapabilityRepository;
    secretKey: string;
    publicKey: string;
    keyId: string;
    now?: () => Date;
    createGrantId?: () => string;
    createJti?: () => string;
    createAuditId?: () => string;
  }) {
    if (
      !input.secretKey.startsWith('k4.secret.') ||
      !input.publicKey.startsWith('k4.public.') ||
      !/^openopc-module-service-(?:development|test|staging|prod)-[A-Za-z0-9._-]{1,64}$/.test(
        input.keyId,
      )
    ) {
      fail('MODULE_SERVICE_UNAVAILABLE', 503);
    }
    this.repository = input.repository;
    this.secretKey = input.secretKey;
    this.publicKey = input.publicKey;
    this.keyId = input.keyId;
    this.now = input.now ?? (() => new Date());
    this.createGrantId = input.createGrantId ?? randomUUID;
    this.createJti = input.createJti ?? randomUUID;
    this.createAuditId = input.createAuditId ?? randomUUID;
  }

  async issue(
    input: IssueModuleServiceCapabilityInput,
  ): Promise<{ token: string; grant: ModuleServiceCapabilityGrant }> {
    assertUuid(input.accountId);
    assertUuid(input.projectId);
    assertUuid(input.installationId);
    assertUuid(input.actorUserId);
    if (!Number.isSafeInteger(input.installRevision) || input.installRevision <= 0) {
      fail('MODULE_SERVICE_INPUT_INVALID', 400);
    }
    const request = ModuleServiceCapabilityRequestSchema.safeParse({
      service: input.service,
      operations: [...input.operations],
    });
    if (!request.success) fail('MODULE_SERVICE_INPUT_INVALID', 400);

    const installation = await this.repository.resolveInstallation(input);
    if (!installation) fail('MODULE_SERVICE_INSTALLATION_NOT_FOUND', 404);
    if (installation.installRevision !== input.installRevision) {
      fail('MODULE_SERVICE_INSTALLATION_STALE', 409);
    }
    assertPublishedInstallation(installation);
    assertDeclaredOperations(installation, request.data.service, request.data.operations);

    const consent = await this.repository.findActiveConsent({
      accountId: input.accountId,
      projectId: input.projectId,
      installationId: input.installationId,
      releaseId: installation.releaseId,
      installRevision: installation.installRevision,
      service: request.data.service,
    });
    if (!consent) fail('MODULE_SERVICE_CONSENT_REQUIRED', 403);
    if (request.data.operations.some((operation) => !consent.operations.includes(operation))) {
      fail('MODULE_SERVICE_CONSENT_REQUIRED', 403);
    }

    const now = this.now();
    if (!Number.isFinite(now.getTime())) fail('MODULE_SERVICE_UNAVAILABLE', 503);
    const claims: ModuleServiceCapabilityClaimsV1 = {
      schemaVersion: 1,
      iss: 'openopc-control-plane',
      aud: 'openopc:module-service',
      jti: this.createJti(),
      iat: now.toISOString(),
      exp: new Date(now.getTime() + MAX_CAPABILITY_LIFETIME_MS).toISOString(),
      accountId: installation.accountId,
      projectId: installation.projectId,
      installationId: installation.installationId,
      installRevision: installation.installRevision,
      releaseId: installation.releaseId,
      moduleId: installation.moduleId,
      moduleVersion: installation.moduleVersion,
      consentId: consent.consentId,
      grantId: this.createGrantId(),
      service: request.data.service,
      operations: [...request.data.operations],
    } as ModuleServiceCapabilityClaimsV1;
    try {
      parseModuleServiceCapabilityClaims(claims);
    } catch {
      fail('MODULE_SERVICE_INPUT_INVALID', 400);
    }

    let token: string;
    try {
      token = await sign(this.secretKey, claims, {
        footer: { kid: this.keyId },
        addIat: false,
        addExp: false,
        maxDepth: 4,
        maxKeys: 32,
        validatePayload: false,
      });
    } catch {
      fail('MODULE_SERVICE_UNAVAILABLE', 503);
    }
    const tokenHash = hashModuleServiceCapabilityToken(token);
    try {
      const grant = await this.repository.storeGrant({
        grantId: claims.grantId,
        accountId: claims.accountId,
        projectId: claims.projectId,
        installationId: claims.installationId,
        installRevision: claims.installRevision,
        releaseId: claims.releaseId,
        consentId: claims.consentId,
        service: claims.service,
        operations: claims.operations,
        tokenHash,
        expiresAt: claims.exp,
        createdAt: claims.iat,
        audit: {
          eventId: this.createAuditId(),
          accountId: claims.accountId,
          projectId: claims.projectId,
          installationId: claims.installationId,
          releaseId: claims.releaseId,
          grantId: claims.grantId,
          service: claims.service,
          operation: null,
          outcome: 'issued',
          code: null,
          requestId: claims.jti,
          createdAt: claims.iat,
        },
      });
      return { token, grant };
    } catch (error) {
      if (error instanceof ModuleServiceCapabilityError) throw error;
      fail('MODULE_SERVICE_CONFLICT', 409);
    }
  }

  async verify(
    token: string,
    input: RequireModuleServiceCapabilityInput,
  ): Promise<ModuleServiceCapabilityClaimsV1> {
    const operationRequest = ModuleServiceCapabilityRequestSchema.safeParse({
      service: input.service,
      operations: [input.operation],
    });
    if (!operationRequest.success) fail('MODULE_SERVICE_OPERATION_DENIED', 403);
    const kid = tokenKeyId(token);
    if (!kid || !safeEqual(kid, this.keyId)) fail('MODULE_SERVICE_CAPABILITY_INVALID', 401);

    let claims: ModuleServiceCapabilityClaimsV1;
    try {
      const verified = verifyPaseto(this.publicKey, token, {
        maxDepth: 4,
        maxKeys: 32,
        validatePayload: false,
      });
      if (
        !verified.footer ||
        typeof verified.footer !== 'object' ||
        Array.isArray(verified.footer) ||
        Object.keys(verified.footer).length !== 1 ||
        !safeEqual(String(verified.footer.kid ?? ''), this.keyId)
      ) {
        fail('MODULE_SERVICE_CAPABILITY_INVALID', 401);
      }
      claims = parseModuleServiceCapabilityClaims(verified.payload);
    } catch (error) {
      if (error instanceof ModuleServiceCapabilityError) throw error;
      fail('MODULE_SERVICE_CAPABILITY_INVALID', 401);
    }

    const observedAt = this.now().getTime();
    const issuedAt = Date.parse(claims.iat);
    const expiresAt = Date.parse(claims.exp);
    if (
      !Number.isFinite(observedAt) ||
      !Number.isFinite(issuedAt) ||
      !Number.isFinite(expiresAt) ||
      issuedAt > observedAt ||
      expiresAt <= issuedAt ||
      expiresAt - issuedAt > MAX_CAPABILITY_LIFETIME_MS ||
      observedAt >= expiresAt
    ) {
      fail('MODULE_SERVICE_CAPABILITY_EXPIRED', 401);
    }
    if (claims.installRevision !== input.installRevision) {
      fail('MODULE_SERVICE_INSTALLATION_STALE', 409);
    }
    if (
      claims.accountId !== input.accountId ||
      claims.projectId !== input.projectId ||
      claims.installationId !== input.installationId ||
      claims.releaseId !== input.releaseId ||
      claims.service !== input.service
    ) {
      fail('MODULE_SERVICE_CAPABILITY_SCOPE_MISMATCH', 403);
    }
    const grantedOperations = new Set<OpenOpcServiceOperation>(claims.operations);
    if (!grantedOperations.has(input.operation)) {
      fail('MODULE_SERVICE_OPERATION_DENIED', 403);
    }

    const authorization = await this.repository.getAuthorization(claims.grantId);
    if (!authorization) fail('MODULE_SERVICE_CAPABILITY_REVOKED', 403);
    const { grant, consent, installation } = authorization;
    if (
      grant.grantId !== claims.grantId ||
      grant.tokenHash !== hashModuleServiceCapabilityToken(token) ||
      grant.revokedAt !== null
    ) {
      fail('MODULE_SERVICE_CAPABILITY_REVOKED', 403);
    }
    if (Date.parse(grant.expiresAt) <= observedAt) {
      fail('MODULE_SERVICE_CAPABILITY_EXPIRED', 401);
    }
    if (
      consent.consentId !== claims.consentId ||
      grant.consentId !== claims.consentId ||
      consent.accountId !== claims.accountId ||
      consent.projectId !== claims.projectId ||
      consent.installationId !== claims.installationId ||
      consent.releaseId !== claims.releaseId ||
      consent.installRevision !== claims.installRevision ||
      consent.service !== claims.service ||
      claims.operations.some((operation) => !consent.operations.includes(operation)) ||
      consent.revokedAt !== null
    ) {
      fail('MODULE_SERVICE_CONSENT_REVOKED', 403);
    }
    if (
      grant.accountId !== claims.accountId ||
      grant.projectId !== claims.projectId ||
      grant.installationId !== claims.installationId ||
      grant.releaseId !== claims.releaseId ||
      grant.service !== claims.service ||
      grant.createdAt !== claims.iat ||
      grant.expiresAt !== claims.exp ||
      !sameOperations(grant.operations, claims.operations)
    ) {
      fail('MODULE_SERVICE_CAPABILITY_SCOPE_MISMATCH', 403);
    }
    if (
      installation.accountId !== claims.accountId ||
      installation.projectId !== claims.projectId ||
      installation.installationId !== claims.installationId ||
      installation.installRevision !== claims.installRevision ||
      installation.releaseId !== claims.releaseId
    ) {
      fail('MODULE_SERVICE_INSTALLATION_STALE', 409);
    }
    if (
      installation.moduleId !== claims.moduleId ||
      installation.moduleVersion !== claims.moduleVersion
    ) {
      fail('MODULE_SERVICE_CAPABILITY_SCOPE_MISMATCH', 403);
    }
    assertPublishedInstallation(installation);
    assertDeclaredOperations(installation, claims.service, [input.operation]);
    if (!consent.operations.includes(input.operation)) {
      fail('MODULE_SERVICE_CONSENT_REVOKED', 403);
    }

    await this.repository.appendAudit({
      eventId: this.createAuditId(),
      accountId: claims.accountId,
      projectId: claims.projectId,
      installationId: claims.installationId,
      releaseId: claims.releaseId,
      grantId: claims.grantId,
      service: claims.service,
      operation: input.operation,
      outcome: 'authorized',
      code: null,
      requestId: this.createJti(),
      createdAt: this.now().toISOString(),
    });
    return claims;
  }

  async revokeByConsent(consentId: string, actorUserId: string): Promise<void> {
    assertUuid(consentId);
    assertUuid(actorUserId);
    const revokedAt = this.now().toISOString();
    const result = await this.repository.revokeByConsent({
      consentId,
      actorUserId,
      revokedAt,
      auditEventId: this.createAuditId(),
      requestId: this.createJti(),
    });
    if (!result) fail('MODULE_SERVICE_CONSENT_REQUIRED', 404);
  }
}
