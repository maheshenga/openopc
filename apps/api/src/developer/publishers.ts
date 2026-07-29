import { createHash, randomBytes, randomUUID } from 'node:crypto';

import type { DeveloperApplicationState } from './applications';

export const DEVELOPER_PUBLISHER_ROLES = [
  'owner',
  'developer',
  'release_manager',
  'finance_viewer',
  'support_viewer',
] as const;
export type DeveloperPublisherRole = (typeof DEVELOPER_PUBLISHER_ROLES)[number];

export const DEVELOPER_ORGANIZATION_VERIFICATION_STATES = [
  'pending',
  'verified',
  'rejected',
  'suspended',
] as const;
export type DeveloperOrganizationVerificationState =
  (typeof DEVELOPER_ORGANIZATION_VERIFICATION_STATES)[number];

export type DeveloperPublisherPermission =
  | 'upload'
  | 'release'
  | 'finance'
  | 'support'
  | 'platform_review';

export interface DeveloperPublisherActor {
  accountId: string;
  userId: string;
  email?: string;
  platformAdmin?: boolean;
}

export interface DeveloperInvitation {
  invitation_id: string;
  account_id: string;
  organization_id: string | null;
  email: string;
  state: 'pending' | 'accepted' | 'expired' | 'revoked';
  expires_at: string;
  accepted_by: string | null;
  accepted_at: string | null;
  revoked_by: string | null;
  revoked_at: string | null;
  created_by: string;
  created_at: string;
}

export interface DeveloperOrganization {
  organization_id: string;
  account_id: string;
  name: string;
  verification_state: DeveloperOrganizationVerificationState;
  verification_metadata: Record<string, unknown>;
  verification_revision: number;
  verification_changed_by: string | null;
  verification_changed_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface DeveloperPublisher {
  publisher_id: string;
  account_id: string;
  organization_id: string;
  slug: string;
  display_name: string;
  status: 'active' | 'suspended';
  authority_revision: number;
  suspended_reason: string | null;
  suspended_by: string | null;
  suspended_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface DeveloperPublisherMember {
  member_id: string;
  account_id: string;
  publisher_id: string;
  user_id: string;
  role: DeveloperPublisherRole;
  revision: number;
  created_by: string;
  created_at: string;
  updated_by: string | null;
  updated_at: string;
}

export interface DeveloperPublisherAuditEvent {
  event_id: string;
  account_id: string;
  organization_id: string | null;
  publisher_id: string | null;
  invitation_id: string | null;
  action: string;
  actor_user_id: string;
  subject_user_id: string | null;
  from_state: Record<string, unknown> | null;
  to_state: Record<string, unknown> | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface DeveloperPublisherAuthority {
  publisher: DeveloperPublisher;
  organization: DeveloperOrganization;
  member: DeveloperPublisherMember | null;
}

export interface DeveloperAccess {
  account_id: string;
  user_id: string;
  organization: DeveloperOrganization | null;
  invitations: DeveloperInvitation[];
  publishers: Array<{
    publisher: DeveloperPublisher;
    membership: DeveloperPublisherMember | null;
  }>;
}

export type DeveloperPublisherMutationFailure =
  | 'not_found'
  | 'conflict'
  | 'expired'
  | 'email_mismatch'
  | 'verification_required'
  | 'application_required'
  | 'forbidden';

export type DeveloperPublisherMutation<T> =
  | { ok: true; value: T }
  | { ok: false; reason: DeveloperPublisherMutationFailure };

export interface DeveloperPublisherRepository {
  getAccess(input: {
    accountId: string;
    userId: string;
    email?: string;
  }): Promise<DeveloperAccess>;
  createInvitation(input: {
    accountId: string;
    organizationId?: string;
    organizationName: string;
    email: string;
    tokenHash: string;
    expiresAt: string;
    actorUserId: string;
    now: string;
  }): Promise<DeveloperPublisherMutation<DeveloperInvitation>>;
  acceptInvitation(input: {
    accountId: string;
    userId: string;
    email: string;
    tokenHash: string;
    now: string;
  }): Promise<DeveloperPublisherMutation<DeveloperInvitation>>;
  setVerification(input: {
    accountId: string;
    organizationId: string;
    state: Exclude<DeveloperOrganizationVerificationState, 'pending'>;
    metadata: Record<string, unknown>;
    expectedRevision: number;
    actorUserId: string;
    now: string;
  }): Promise<DeveloperPublisherMutation<DeveloperOrganization>>;
  createPublisher(input: {
    accountId: string;
    organizationId: string;
    slug: string;
    displayName: string;
    actorUserId: string;
    now: string;
  }): Promise<DeveloperPublisherMutation<DeveloperPublisherAuthority>>;
  listPublishers(accountId: string): Promise<readonly DeveloperPublisher[]>;
  getAuthority(input: {
    accountId: string;
    publisherId: string;
    userId: string;
  }): Promise<DeveloperPublisherAuthority | null>;
  setMemberRole(input: {
    accountId: string;
    publisherId: string;
    userId: string;
    role: DeveloperPublisherRole;
    expectedRevision: number | null;
    actorUserId: string;
    now: string;
  }): Promise<DeveloperPublisherMutation<DeveloperPublisherMember>>;
  setPublisherStatus(input: {
    accountId: string;
    publisherId: string;
    status: 'active' | 'suspended';
    reason: string | null;
    expectedRevision: number;
    actorUserId: string;
    now: string;
  }): Promise<DeveloperPublisherMutation<DeveloperPublisher>>;
  getAuditHistory(
    accountId: string,
    publisherId: string,
  ): Promise<readonly DeveloperPublisherAuditEvent[]>;
}

export type DeveloperPublisherErrorCode =
  | 'DEVELOPER_INPUT_INVALID'
  | 'DEVELOPER_INVITATION_INVALID'
  | 'DEVELOPER_INVITATION_EXPIRED'
  | 'DEVELOPER_ORGANIZATION_NOT_FOUND'
  | 'DEVELOPER_PUBLISHER_NOT_FOUND'
  | 'DEVELOPER_PUBLISHER_FORBIDDEN'
  | 'DEVELOPER_PUBLISHER_SUSPENDED'
  | 'DEVELOPER_VERIFICATION_REQUIRED'
  | 'DEVELOPER_APPLICATION_APPROVAL_REQUIRED'
  | 'DEVELOPER_SEGREGATION_OF_DUTIES_REQUIRED'
  | 'DEVELOPER_AUTHORITY_CONFLICT';

export class DeveloperPublisherError extends Error {
  constructor(
    readonly code: DeveloperPublisherErrorCode,
    readonly status: 400 | 403 | 404 | 409,
  ) {
    super(code);
    this.name = 'DeveloperPublisherError';
  }
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ROLE_PERMISSIONS: Readonly<
  Record<DeveloperPublisherRole, ReadonlySet<DeveloperPublisherPermission>>
> = {
  owner: new Set(['upload', 'release', 'finance', 'support']),
  developer: new Set(['upload']),
  release_manager: new Set(['upload', 'release']),
  finance_viewer: new Set(['finance']),
  support_viewer: new Set(['support']),
};

function fail(code: DeveloperPublisherErrorCode, status: DeveloperPublisherError['status']): never {
  throw new DeveloperPublisherError(code, status);
}

function normalizeBounded(value: unknown, maxChars: number): string {
  if (typeof value !== 'string') fail('DEVELOPER_INPUT_INVALID', 400);
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > maxChars ||
    Buffer.byteLength(normalized, 'utf8') > maxChars * 4 ||
    [...normalized].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })
  ) {
    fail('DEVELOPER_INPUT_INVALID', 400);
  }
  return normalized;
}

function normalizeEmail(value: unknown): string {
  const email = normalizeBounded(value, 320).toLowerCase();
  if (!EMAIL.test(email)) fail('DEVELOPER_INPUT_INVALID', 400);
  return email;
}

function boundedJson(value: unknown, maxBytes = 8_192): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('DEVELOPER_INPUT_INVALID', 400);
  }
  let copy: Record<string, unknown>;
  try {
    copy = structuredClone(value as Record<string, unknown>);
    if (Buffer.byteLength(JSON.stringify(copy), 'utf8') > maxBytes) {
      fail('DEVELOPER_INPUT_INVALID', 400);
    }
  } catch (error) {
    if (error instanceof DeveloperPublisherError) throw error;
    fail('DEVELOPER_INPUT_INVALID', 400);
  }
  return copy;
}

function assertAdmin(actor: DeveloperPublisherActor): void {
  if (!actor.platformAdmin) fail('DEVELOPER_PUBLISHER_FORBIDDEN', 403);
}

function mutationValue<T>(
  result: DeveloperPublisherMutation<T>,
  mapping: Partial<Record<DeveloperPublisherMutationFailure, DeveloperPublisherErrorCode>>,
): T {
  if (result.ok) return result.value;
  const code = mapping[result.reason] ?? 'DEVELOPER_AUTHORITY_CONFLICT';
  if (code.endsWith('_NOT_FOUND') || code === 'DEVELOPER_INVITATION_INVALID') fail(code, 404);
  if (
    code === 'DEVELOPER_PUBLISHER_FORBIDDEN' ||
    code === 'DEVELOPER_VERIFICATION_REQUIRED' ||
    code === 'DEVELOPER_APPLICATION_APPROVAL_REQUIRED'
  ) {
    fail(code, 403);
  }
  fail(code, 409);
}

export interface DeveloperPublisherPermissionPort {
  requirePermission(
    publisherId: string,
    actor: DeveloperPublisherActor,
    permission: DeveloperPublisherPermission,
  ): Promise<DeveloperPublisherAuthority>;
}

export class DeveloperPublisherService implements DeveloperPublisherPermissionPort {
  private readonly now: () => Date;
  private readonly createToken: () => string;

  constructor(
    private readonly input: {
      repository: DeveloperPublisherRepository;
      now?: () => Date;
      createToken?: () => string;
    },
  ) {
    this.now = input.now ?? (() => new Date());
    this.createToken = input.createToken ?? (() => randomBytes(32).toString('base64url'));
  }

  getDeveloperAccess(actor: DeveloperPublisherActor): Promise<DeveloperAccess> {
    return this.input.repository.getAccess({
      accountId: actor.accountId,
      userId: actor.userId,
      email: actor.email ? normalizeEmail(actor.email) : undefined,
    });
  }

  async invite(input: {
    actor: DeveloperPublisherActor;
    accountId: string;
    organizationId?: string;
    organizationName: unknown;
    email: unknown;
    expiresAt?: string;
  }): Promise<{ invitation: DeveloperInvitation; token: string }> {
    assertAdmin(input.actor);
    const organizationName = normalizeBounded(input.organizationName, 255);
    const email = normalizeEmail(input.email);
    const now = this.now();
    const expiresAt = input.expiresAt
      ? new Date(input.expiresAt)
      : new Date(now.getTime() + 7 * 24 * 60 * 60 * 1_000);
    if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= now.getTime()) {
      fail('DEVELOPER_INPUT_INVALID', 400);
    }
    const token = this.createToken();
    if (!token || token.length > 512) fail('DEVELOPER_INPUT_INVALID', 400);
    const invitation = mutationValue(
      await this.input.repository.createInvitation({
        accountId: input.accountId,
        organizationId: input.organizationId,
        organizationName,
        email,
        tokenHash: createHash('sha256').update(token, 'utf8').digest('hex'),
        expiresAt: expiresAt.toISOString(),
        actorUserId: input.actor.userId,
        now: now.toISOString(),
      }),
      { not_found: 'DEVELOPER_ORGANIZATION_NOT_FOUND' },
    );
    return { invitation, token };
  }

  async acceptInvitation(
    token: unknown,
    actor: DeveloperPublisherActor,
  ): Promise<DeveloperInvitation> {
    if (typeof token !== 'string' || !token || token.length > 512 || !actor.email) {
      fail('DEVELOPER_INVITATION_INVALID', 404);
    }
    return mutationValue(
      await this.input.repository.acceptInvitation({
        accountId: actor.accountId,
        userId: actor.userId,
        email: normalizeEmail(actor.email),
        tokenHash: createHash('sha256').update(token, 'utf8').digest('hex'),
        now: this.now().toISOString(),
      }),
      {
        not_found: 'DEVELOPER_INVITATION_INVALID',
        email_mismatch: 'DEVELOPER_INVITATION_INVALID',
        expired: 'DEVELOPER_INVITATION_EXPIRED',
      },
    );
  }

  async setVerification(input: {
    actor: DeveloperPublisherActor;
    accountId: string;
    organizationId: string;
    state: Exclude<DeveloperOrganizationVerificationState, 'pending'>;
    metadata?: unknown;
    expectedRevision: number;
  }): Promise<DeveloperOrganization> {
    assertAdmin(input.actor);
    if (
      !DEVELOPER_ORGANIZATION_VERIFICATION_STATES.includes(input.state) ||
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 0
    ) {
      fail('DEVELOPER_INPUT_INVALID', 400);
    }
    return mutationValue(
      await this.input.repository.setVerification({
        accountId: input.accountId,
        organizationId: input.organizationId,
        state: input.state,
        metadata: boundedJson(input.metadata ?? {}),
        expectedRevision: input.expectedRevision,
        actorUserId: input.actor.userId,
        now: this.now().toISOString(),
      }),
      { not_found: 'DEVELOPER_ORGANIZATION_NOT_FOUND' },
    );
  }

  async createPublisher(input: {
    actor: DeveloperPublisherActor;
    organizationId: string;
    slug: unknown;
    displayName: unknown;
  }): Promise<DeveloperPublisherAuthority> {
    const slug = typeof input.slug === 'string' ? input.slug.trim().toLowerCase() : '';
    if (!SLUG.test(slug)) fail('DEVELOPER_INPUT_INVALID', 400);
    return mutationValue(
      await this.input.repository.createPublisher({
        accountId: input.actor.accountId,
        organizationId: input.organizationId,
        slug,
        displayName: normalizeBounded(input.displayName, 255),
        actorUserId: input.actor.userId,
        now: this.now().toISOString(),
      }),
      {
        not_found: 'DEVELOPER_ORGANIZATION_NOT_FOUND',
        verification_required: 'DEVELOPER_VERIFICATION_REQUIRED',
        application_required: 'DEVELOPER_APPLICATION_APPROVAL_REQUIRED',
      },
    );
  }

  listPublishers(actor: DeveloperPublisherActor): Promise<readonly DeveloperPublisher[]> {
    return this.input.repository.listPublishers(actor.accountId);
  }

  async setMemberRole(input: {
    actor: DeveloperPublisherActor;
    publisherId: string;
    userId: string;
    role: DeveloperPublisherRole;
    expectedRevision: number | null;
  }): Promise<DeveloperPublisherMember> {
    if (!DEVELOPER_PUBLISHER_ROLES.includes(input.role)) fail('DEVELOPER_INPUT_INVALID', 400);
    if (
      input.expectedRevision !== null &&
      (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0)
    ) {
      fail('DEVELOPER_INPUT_INVALID', 400);
    }
    const authority = await this.input.repository.getAuthority({
      accountId: input.actor.accountId,
      publisherId: input.publisherId,
      userId: input.actor.userId,
    });
    if (!authority) fail('DEVELOPER_PUBLISHER_NOT_FOUND', 404);
    if (authority.member?.role !== 'owner') fail('DEVELOPER_PUBLISHER_FORBIDDEN', 403);
    return mutationValue(
      await this.input.repository.setMemberRole({
        accountId: input.actor.accountId,
        publisherId: input.publisherId,
        userId: input.userId,
        role: input.role,
        expectedRevision: input.expectedRevision,
        actorUserId: input.actor.userId,
        now: this.now().toISOString(),
      }),
      {
        not_found: 'DEVELOPER_PUBLISHER_NOT_FOUND',
        forbidden: 'DEVELOPER_PUBLISHER_FORBIDDEN',
      },
    );
  }

  suspend(input: {
    actor: DeveloperPublisherActor;
    accountId: string;
    publisherId: string;
    reason: unknown;
    expectedRevision: number;
  }): Promise<DeveloperPublisher> {
    assertAdmin(input.actor);
    return this.setStatus({
      ...input,
      status: 'suspended',
      reason: normalizeBounded(input.reason, 1_024),
    });
  }

  reinstate(input: {
    actor: DeveloperPublisherActor;
    accountId: string;
    publisherId: string;
    expectedRevision: number;
  }): Promise<DeveloperPublisher> {
    assertAdmin(input.actor);
    return this.setStatus({ ...input, status: 'active', reason: null });
  }

  private async setStatus(input: {
    actor: DeveloperPublisherActor;
    accountId: string;
    publisherId: string;
    status: 'active' | 'suspended';
    reason: string | null;
    expectedRevision: number;
  }): Promise<DeveloperPublisher> {
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
      fail('DEVELOPER_INPUT_INVALID', 400);
    }
    return mutationValue(
      await this.input.repository.setPublisherStatus({
        accountId: input.accountId,
        publisherId: input.publisherId,
        status: input.status,
        reason: input.reason,
        expectedRevision: input.expectedRevision,
        actorUserId: input.actor.userId,
        now: this.now().toISOString(),
      }),
      { not_found: 'DEVELOPER_PUBLISHER_NOT_FOUND' },
    );
  }

  async requirePermission(
    publisherId: string,
    actor: DeveloperPublisherActor,
    permission: DeveloperPublisherPermission,
  ): Promise<DeveloperPublisherAuthority> {
    const authority = await this.input.repository.getAuthority({
      accountId: actor.accountId,
      publisherId,
      userId: actor.userId,
    });
    if (!authority) fail('DEVELOPER_PUBLISHER_NOT_FOUND', 404);
    if (authority.organization.verification_state !== 'verified') {
      fail('DEVELOPER_VERIFICATION_REQUIRED', 403);
    }
    if (authority.publisher.status === 'suspended') {
      fail('DEVELOPER_PUBLISHER_SUSPENDED', 409);
    }
    if (permission === 'platform_review') {
      if (!actor.platformAdmin) fail('DEVELOPER_PUBLISHER_FORBIDDEN', 403);
      if (authority.member) fail('DEVELOPER_SEGREGATION_OF_DUTIES_REQUIRED', 403);
      return authority;
    }
    if (!authority.member || !ROLE_PERMISSIONS[authority.member.role].has(permission)) {
      fail('DEVELOPER_PUBLISHER_FORBIDDEN', 403);
    }
    return authority;
  }

  async auditHistory(input: {
    actor: DeveloperPublisherActor;
    publisherId: string;
  }): Promise<readonly DeveloperPublisherAuditEvent[]> {
    const authority = await this.input.repository.getAuthority({
      accountId: input.actor.accountId,
      publisherId: input.publisherId,
      userId: input.actor.userId,
    });
    if (!authority) fail('DEVELOPER_PUBLISHER_NOT_FOUND', 404);
    return this.input.repository.getAuditHistory(input.actor.accountId, input.publisherId);
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export function createMemoryDeveloperPublisherRepository(input?: {
  organizations?: readonly DeveloperOrganization[];
  invitations?: ReadonlyArray<DeveloperInvitation & { token_hash: string }>;
  publishers?: readonly DeveloperPublisher[];
  members?: readonly DeveloperPublisherMember[];
  auditEvents?: readonly DeveloperPublisherAuditEvent[];
  applicationStates?: readonly {
    accountId: string;
    organizationId: string;
    state: DeveloperApplicationState;
  }[];
  createId?: () => string;
}): DeveloperPublisherRepository {
  const organizations = new Map(
    (input?.organizations ?? []).map((organization) => [
      organization.organization_id,
      clone(organization),
    ]),
  );
  const invitations = new Map(
    (input?.invitations ?? []).map((invitation) => [invitation.invitation_id, clone(invitation)]),
  );
  const publishers = new Map(
    (input?.publishers ?? []).map((publisher) => [publisher.publisher_id, clone(publisher)]),
  );
  const members = new Map(
    (input?.members ?? []).map((member) => [
      `${member.publisher_id}\0${member.user_id}`,
      clone(member),
    ]),
  );
  const audits = (input?.auditEvents ?? []).map(clone);
  const applicationStates = new Map(
    (input?.applicationStates ?? []).map((application) => [
      `${application.accountId}\0${application.organizationId}`,
      application.state,
    ]),
  );
  const createId = input?.createId ?? randomUUID;

  const publicInvitation = (
    invitation: DeveloperInvitation & { token_hash?: string },
  ): DeveloperInvitation => {
    const { token_hash: _tokenHash, ...safe } = invitation;
    return clone(safe);
  };
  const appendAudit = (event: Omit<DeveloperPublisherAuditEvent, 'event_id'>) => {
    audits.push({ event_id: createId(), ...clone(event) });
  };

  return {
    async getAccess({ accountId, userId, email }) {
      const organization = [...organizations.values()].find((row) => row.account_id === accountId);
      return {
        account_id: accountId,
        user_id: userId,
        organization: organization ? clone(organization) : null,
        invitations: [...invitations.values()]
          .filter(
            (row) =>
              row.account_id === accountId &&
              row.state === 'pending' &&
              (!email || row.email === email),
          )
          .map(publicInvitation),
        publishers: [...publishers.values()]
          .filter((row) => row.account_id === accountId)
          .map((publisher) => ({
            publisher: clone(publisher),
            membership: clone(members.get(`${publisher.publisher_id}\0${userId}`) ?? null),
          })),
      };
    },

    async createInvitation(command) {
      let organization = command.organizationId
        ? organizations.get(command.organizationId)
        : [...organizations.values()].find((row) => row.account_id === command.accountId);
      if (organization && organization.account_id !== command.accountId) {
        return { ok: false, reason: 'not_found' };
      }
      if (!organization) {
        organization = {
          organization_id: createId(),
          account_id: command.accountId,
          name: command.organizationName,
          verification_state: 'pending',
          verification_metadata: {},
          verification_revision: 0,
          verification_changed_by: null,
          verification_changed_at: null,
          created_by: command.actorUserId,
          created_at: command.now,
          updated_at: command.now,
        };
        organizations.set(organization.organization_id, clone(organization));
        appendAudit({
          account_id: command.accountId,
          organization_id: organization.organization_id,
          publisher_id: null,
          invitation_id: null,
          action: 'organization_created',
          actor_user_id: command.actorUserId,
          subject_user_id: null,
          from_state: null,
          to_state: { verification_state: 'pending', verification_revision: 0 },
          metadata: {},
          created_at: command.now,
        });
      }
      if (
        [...invitations.values()].some(
          (row) =>
            row.token_hash === command.tokenHash ||
            (row.email === command.email && row.state === 'pending'),
        )
      ) {
        return { ok: false, reason: 'conflict' };
      }
      const invitation = {
        invitation_id: createId(),
        account_id: command.accountId,
        organization_id: organization.organization_id,
        email: command.email,
        token_hash: command.tokenHash,
        state: 'pending' as const,
        expires_at: command.expiresAt,
        accepted_by: null,
        accepted_at: null,
        revoked_by: null,
        revoked_at: null,
        created_by: command.actorUserId,
        created_at: command.now,
      };
      invitations.set(invitation.invitation_id, clone(invitation));
      appendAudit({
        account_id: command.accountId,
        organization_id: organization.organization_id,
        publisher_id: null,
        invitation_id: invitation.invitation_id,
        action: 'invitation_created',
        actor_user_id: command.actorUserId,
        subject_user_id: null,
        from_state: null,
        to_state: { state: 'pending' },
        metadata: { email: command.email },
        created_at: command.now,
      });
      return { ok: true, value: publicInvitation(invitation) };
    },

    async acceptInvitation(command) {
      const invitation = [...invitations.values()].find(
        (row) => row.token_hash === command.tokenHash && row.account_id === command.accountId,
      );
      if (!invitation) return { ok: false, reason: 'not_found' };
      if (invitation.email !== command.email) return { ok: false, reason: 'email_mismatch' };
      if (invitation.state === 'accepted' && invitation.accepted_by === command.userId) {
        return { ok: true, value: publicInvitation(invitation) };
      }
      if (invitation.state !== 'pending') return { ok: false, reason: 'conflict' };
      if (Date.parse(invitation.expires_at) <= Date.parse(command.now)) {
        invitation.state = 'expired';
        return { ok: false, reason: 'expired' };
      }
      invitation.state = 'accepted';
      invitation.accepted_by = command.userId;
      invitation.accepted_at = command.now;
      appendAudit({
        account_id: command.accountId,
        organization_id: invitation.organization_id,
        publisher_id: null,
        invitation_id: invitation.invitation_id,
        action: 'invitation_accepted',
        actor_user_id: command.userId,
        subject_user_id: command.userId,
        from_state: { state: 'pending' },
        to_state: { state: 'accepted' },
        metadata: {},
        created_at: command.now,
      });
      return { ok: true, value: publicInvitation(invitation) };
    },

    async setVerification(command) {
      const organization = organizations.get(command.organizationId);
      if (!organization || organization.account_id !== command.accountId) {
        return { ok: false, reason: 'not_found' };
      }
      if (organization.verification_revision !== command.expectedRevision) {
        return { ok: false, reason: 'conflict' };
      }
      const fromState = {
        verification_state: organization.verification_state,
        verification_revision: organization.verification_revision,
      };
      organization.verification_state = command.state;
      organization.verification_metadata = clone(command.metadata);
      organization.verification_revision += 1;
      organization.verification_changed_by = command.actorUserId;
      organization.verification_changed_at = command.now;
      organization.updated_at = command.now;
      appendAudit({
        account_id: command.accountId,
        organization_id: command.organizationId,
        publisher_id: null,
        invitation_id: null,
        action: 'organization_verification_changed',
        actor_user_id: command.actorUserId,
        subject_user_id: null,
        from_state: fromState,
        to_state: {
          verification_state: organization.verification_state,
          verification_revision: organization.verification_revision,
        },
        metadata: command.metadata,
        created_at: command.now,
      });
      return { ok: true, value: clone(organization) };
    },

    async createPublisher(command) {
      const organization = organizations.get(command.organizationId);
      if (!organization || organization.account_id !== command.accountId) {
        return { ok: false, reason: 'not_found' };
      }
      if (organization.verification_state !== 'verified') {
        return { ok: false, reason: 'verification_required' };
      }
      if (applicationStates.get(`${command.accountId}\0${command.organizationId}`) !== 'approved') {
        return { ok: false, reason: 'application_required' };
      }
      if (publishers.has(command.slug)) return { ok: false, reason: 'conflict' };
      const publisher: DeveloperPublisher = {
        publisher_id: command.slug,
        account_id: command.accountId,
        organization_id: command.organizationId,
        slug: command.slug,
        display_name: command.displayName,
        status: 'active',
        authority_revision: 0,
        suspended_reason: null,
        suspended_by: null,
        suspended_at: null,
        created_by: command.actorUserId,
        created_at: command.now,
        updated_at: command.now,
      };
      const member: DeveloperPublisherMember = {
        member_id: createId(),
        account_id: command.accountId,
        publisher_id: command.slug,
        user_id: command.actorUserId,
        role: 'owner',
        revision: 0,
        created_by: command.actorUserId,
        created_at: command.now,
        updated_by: null,
        updated_at: command.now,
      };
      publishers.set(publisher.publisher_id, clone(publisher));
      members.set(`${publisher.publisher_id}\0${member.user_id}`, clone(member));
      appendAudit({
        account_id: command.accountId,
        organization_id: command.organizationId,
        publisher_id: publisher.publisher_id,
        invitation_id: null,
        action: 'publisher_created',
        actor_user_id: command.actorUserId,
        subject_user_id: command.actorUserId,
        from_state: null,
        to_state: { status: 'active', authority_revision: 0, owner: command.actorUserId },
        metadata: {},
        created_at: command.now,
      });
      return {
        ok: true,
        value: { publisher: clone(publisher), organization: clone(organization), member },
      };
    },

    async listPublishers(accountId) {
      return [...publishers.values()]
        .filter((publisher) => publisher.account_id === accountId)
        .sort((left, right) => left.slug.localeCompare(right.slug))
        .map(clone);
    },

    async getAuthority({ accountId, publisherId, userId }) {
      const publisher = publishers.get(publisherId);
      if (!publisher || publisher.account_id !== accountId) return null;
      const organization = organizations.get(publisher.organization_id);
      if (!organization || organization.account_id !== accountId) return null;
      return {
        publisher: clone(publisher),
        organization: clone(organization),
        member: clone(members.get(`${publisherId}\0${userId}`) ?? null),
      };
    },

    async setMemberRole(command) {
      const publisher = publishers.get(command.publisherId);
      if (!publisher || publisher.account_id !== command.accountId) {
        return { ok: false, reason: 'not_found' };
      }
      if (members.get(`${command.publisherId}\0${command.actorUserId}`)?.role !== 'owner') {
        return { ok: false, reason: 'forbidden' };
      }
      const key = `${command.publisherId}\0${command.userId}`;
      const existing = members.get(key);
      if (
        (existing && existing.revision !== command.expectedRevision) ||
        (!existing && command.expectedRevision !== null)
      ) {
        return { ok: false, reason: 'conflict' };
      }
      if (existing?.role === 'owner' && command.role !== 'owner') {
        const ownerCount = [...members.values()].filter(
          (member) => member.publisher_id === command.publisherId && member.role === 'owner',
        ).length;
        if (ownerCount <= 1) return { ok: false, reason: 'conflict' };
      }
      const member: DeveloperPublisherMember = existing
        ? {
            ...existing,
            role: command.role,
            revision: existing.revision + 1,
            updated_by: command.actorUserId,
            updated_at: command.now,
          }
        : {
            member_id: createId(),
            account_id: command.accountId,
            publisher_id: command.publisherId,
            user_id: command.userId,
            role: command.role,
            revision: 0,
            created_by: command.actorUserId,
            created_at: command.now,
            updated_by: null,
            updated_at: command.now,
          };
      members.set(key, clone(member));
      appendAudit({
        account_id: command.accountId,
        organization_id: publisher.organization_id,
        publisher_id: command.publisherId,
        invitation_id: null,
        action: existing ? 'publisher_member_role_changed' : 'publisher_member_added',
        actor_user_id: command.actorUserId,
        subject_user_id: command.userId,
        from_state: existing ? { role: existing.role, revision: existing.revision } : null,
        to_state: { role: member.role, revision: member.revision },
        metadata: {},
        created_at: command.now,
      });
      return { ok: true, value: clone(member) };
    },

    async setPublisherStatus(command) {
      const publisher = publishers.get(command.publisherId);
      if (!publisher || publisher.account_id !== command.accountId) {
        return { ok: false, reason: 'not_found' };
      }
      if (publisher.authority_revision !== command.expectedRevision) {
        return { ok: false, reason: 'conflict' };
      }
      const fromState = {
        status: publisher.status,
        authority_revision: publisher.authority_revision,
      };
      publisher.status = command.status;
      publisher.authority_revision += 1;
      publisher.suspended_reason = command.status === 'suspended' ? command.reason : null;
      publisher.suspended_by = command.status === 'suspended' ? command.actorUserId : null;
      publisher.suspended_at = command.status === 'suspended' ? command.now : null;
      publisher.updated_at = command.now;
      appendAudit({
        account_id: command.accountId,
        organization_id: publisher.organization_id,
        publisher_id: publisher.publisher_id,
        invitation_id: null,
        action: command.status === 'suspended' ? 'publisher_suspended' : 'publisher_reinstated',
        actor_user_id: command.actorUserId,
        subject_user_id: null,
        from_state: fromState,
        to_state: { status: publisher.status, authority_revision: publisher.authority_revision },
        metadata: command.reason ? { reason: command.reason } : {},
        created_at: command.now,
      });
      return { ok: true, value: clone(publisher) };
    },

    async getAuditHistory(accountId, publisherId) {
      return audits
        .filter((event) => event.account_id === accountId && event.publisher_id === publisherId)
        .sort((left, right) => left.created_at.localeCompare(right.created_at))
        .map(clone);
    },
  };
}
