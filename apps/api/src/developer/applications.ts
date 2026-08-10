import type { DeveloperOrganization } from './publishers';

export const DEVELOPER_APPLICATION_STATES = [
  'draft',
  'submitted',
  'under_review',
  'approved',
  'rejected',
  'suspended',
] as const;
export type DeveloperApplicationState = (typeof DEVELOPER_APPLICATION_STATES)[number];

export const DEVELOPER_APPLICATION_REVIEW_PERMISSION = 'developer.application.review' as const;

export interface DeveloperApplicationPolicyVersions {
  moduleRules: string;
  acceptableUse: string;
}

export interface DeveloperApplication {
  application_id: string;
  account_id: string;
  organization_id: string;
  state: DeveloperApplicationState;
  revision: number;
  policy_versions: DeveloperApplicationPolicyVersions;
  submitted_at: string | null;
  decided_at: string | null;
  suspended_at: string | null;
  decision_reason: string | null;
  created_by: string;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface DeveloperApplicationAuditEvent {
  action:
    | 'developer_application.submitted'
    | 'developer_application.approved'
    | 'developer_application.rejected'
    | 'developer_application.suspended';
  account_id: string;
  application_id: string;
  actor_user_id: string;
  from_state: { state: DeveloperApplicationState; revision: number } | null;
  to_state: { state: DeveloperApplicationState; revision: number };
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface DeveloperApplicationPolicyAcceptance {
  account_id: string;
  user_id: string;
  policy: 'acceptable_use' | 'module_rules';
  version: string;
  source: 'developer_application';
  accepted_at: string;
}

export interface DeveloperApplicationAdminListItem {
  application: DeveloperApplication;
  organization: DeveloperOrganization;
}

export interface DeveloperApplicationAdminPage {
  applications: DeveloperApplicationAdminListItem[];
  next_cursor: string | null;
}

export interface DeveloperApplicationAdminDetail extends DeveloperApplicationAdminListItem {
  policy_acceptances: DeveloperApplicationPolicyAcceptance[];
  history: DeveloperApplicationAuditEvent[];
}

export interface DeveloperApplicationAdminCursor {
  updatedAt: string;
  applicationId: string;
}

export interface DeveloperApplicationAdminRepositoryPage {
  applications: DeveloperApplicationAdminListItem[];
  hasMore: boolean;
}

export type DeveloperApplicationMutationFailure = 'not_found' | 'conflict' | 'invalid_state';

export type DeveloperApplicationMutation<T> =
  | { ok: true; value: T }
  | { ok: false; reason: DeveloperApplicationMutationFailure };

export interface DeveloperApplicationRepository {
  submit(input: {
    accountId: string;
    userId: string;
    organizationName: string;
    policyVersions: DeveloperApplicationPolicyVersions;
    now: string;
  }): Promise<
    DeveloperApplicationMutation<{ application: DeveloperApplication; created: boolean }>
  >;
  current(input: {
    accountId: string;
    userId: string;
  }): Promise<DeveloperApplicationMutation<DeveloperApplication | null>>;
  decide(input: {
    applicationId: string;
    actorUserId: string;
    decision: 'approve' | 'reject';
    expectedRevision: number;
    reason: string;
    now: string;
  }): Promise<DeveloperApplicationMutation<DeveloperApplication>>;
  suspend(input: {
    applicationId: string;
    actorUserId: string;
    expectedRevision: number;
    reason: string;
    now: string;
  }): Promise<DeveloperApplicationMutation<DeveloperApplication>>;
  getOrganization(accountId: string, organizationId: string): Promise<DeveloperOrganization | null>;
  getAuditHistory(applicationId: string): Promise<readonly DeveloperApplicationAuditEvent[]>;
  listPolicyAcceptances(
    accountId: string,
    userId: string,
  ): Promise<readonly DeveloperApplicationPolicyAcceptance[]>;
  adminList(input: {
    state: DeveloperApplicationState;
    limit: number;
    cursor: DeveloperApplicationAdminCursor | null;
  }): Promise<DeveloperApplicationAdminRepositoryPage>;
  adminGet(applicationId: string): Promise<DeveloperApplicationAdminListItem | null>;
}

export type DeveloperApplicationErrorCode =
  | 'DEVELOPER_APPLICATION_INPUT_INVALID'
  | 'DEVELOPER_APPLICATION_POLICY_STALE'
  | 'DEVELOPER_APPLICATION_NOT_FOUND'
  | 'DEVELOPER_APPLICATION_FORBIDDEN'
  | 'DEVELOPER_APPLICATION_STEP_UP_REQUIRED'
  | 'DEVELOPER_APPLICATION_CONFLICT'
  | 'DEVELOPER_APPLICATION_DEPENDENCY_UNAVAILABLE';

export class DeveloperApplicationError extends Error {
  constructor(
    readonly code: DeveloperApplicationErrorCode,
    readonly status: 400 | 403 | 404 | 409 | 503,
  ) {
    super(code);
    this.name = 'DeveloperApplicationError';
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const FORBIDDEN_VERSIONS = new Set(['latest', 'current', 'draft', 'unpublished']);

function fail(
  code: DeveloperApplicationErrorCode,
  status: DeveloperApplicationError['status'],
): never {
  throw new DeveloperApplicationError(code, status);
}

function validVersion(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    VERSION_RE.test(value) &&
    !FORBIDDEN_VERSIONS.has(value.toLowerCase())
  );
}

function normalizeOrganizationName(value: unknown): string {
  if (typeof value !== 'string') fail('DEVELOPER_APPLICATION_INPUT_INVALID', 400);
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > 255 ||
    Buffer.byteLength(normalized, 'utf8') > 1_020 ||
    [...normalized].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })
  ) {
    fail('DEVELOPER_APPLICATION_INPUT_INVALID', 400);
  }
  return normalized;
}

function normalizeReason(value: unknown): string {
  if (typeof value !== 'string') fail('DEVELOPER_APPLICATION_INPUT_INVALID', 400);
  const normalized = value.trim();
  if (!normalized || normalized.length > 4_000 || Buffer.byteLength(normalized, 'utf8') > 8_192) {
    fail('DEVELOPER_APPLICATION_INPUT_INVALID', 400);
  }
  return normalized;
}

function validatePolicies(value: unknown): DeveloperApplicationPolicyVersions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('DEVELOPER_APPLICATION_INPUT_INVALID', 400);
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(',') !== 'acceptableUse,moduleRules' ||
    !validVersion(record.moduleRules) ||
    !validVersion(record.acceptableUse)
  ) {
    fail('DEVELOPER_APPLICATION_INPUT_INVALID', 400);
  }
  return { moduleRules: record.moduleRules, acceptableUse: record.acceptableUse };
}

function mutationValue<T>(result: DeveloperApplicationMutation<T>): T {
  if (result.ok) return result.value;
  if (result.reason === 'not_found') fail('DEVELOPER_APPLICATION_NOT_FOUND', 404);
  fail('DEVELOPER_APPLICATION_CONFLICT', 409);
}

function validIdentity(...values: string[]): boolean {
  return values.every((value) => UUID_RE.test(value));
}

function encodeAdminCursor(value: DeveloperApplicationAdminCursor): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeAdminCursor(value: string | null | undefined): DeveloperApplicationAdminCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      Object.keys(parsed).sort().join(',') !== 'applicationId,updatedAt' ||
      typeof (parsed as { updatedAt?: unknown }).updatedAt !== 'string' ||
      !Number.isFinite(Date.parse((parsed as { updatedAt: string }).updatedAt)) ||
      new Date((parsed as { updatedAt: string }).updatedAt).toISOString() !==
        (parsed as { updatedAt: string }).updatedAt ||
      typeof (parsed as { applicationId?: unknown }).applicationId !== 'string' ||
      !UUID_RE.test((parsed as { applicationId: string }).applicationId)
    ) {
      fail('DEVELOPER_APPLICATION_INPUT_INVALID', 400);
    }
    return parsed as DeveloperApplicationAdminCursor;
  } catch (error) {
    if (error instanceof DeveloperApplicationError) throw error;
    fail('DEVELOPER_APPLICATION_INPUT_INVALID', 400);
  }
}

export class DeveloperApplicationService {
  private readonly now: () => Date;
  readonly currentPolicyVersions: Readonly<DeveloperApplicationPolicyVersions>;

  constructor(
    private readonly input: {
      repository: DeveloperApplicationRepository;
      currentPolicyVersions: DeveloperApplicationPolicyVersions;
      now?: () => Date;
    },
  ) {
    this.currentPolicyVersions = Object.freeze(validatePolicies(input.currentPolicyVersions));
    this.now = input.now ?? (() => new Date());
  }

  async submit(input: {
    actor: { accountId: string; userId: string };
    organizationName: unknown;
    policyVersions: unknown;
  }): Promise<{ application: DeveloperApplication; created: boolean }> {
    if (!validIdentity(input.actor.accountId, input.actor.userId)) {
      fail('DEVELOPER_APPLICATION_INPUT_INVALID', 400);
    }
    const policyVersions = validatePolicies(input.policyVersions);
    if (
      policyVersions.moduleRules !== this.currentPolicyVersions.moduleRules ||
      policyVersions.acceptableUse !== this.currentPolicyVersions.acceptableUse
    ) {
      fail('DEVELOPER_APPLICATION_POLICY_STALE', 409);
    }
    const now = this.now();
    if (!Number.isFinite(now.getTime())) fail('DEVELOPER_APPLICATION_INPUT_INVALID', 400);
    try {
      return mutationValue(
        await this.input.repository.submit({
          accountId: input.actor.accountId,
          userId: input.actor.userId,
          organizationName: normalizeOrganizationName(input.organizationName),
          policyVersions,
          now: now.toISOString(),
        }),
      );
    } catch (error) {
      if (error instanceof DeveloperApplicationError) throw error;
      fail('DEVELOPER_APPLICATION_DEPENDENCY_UNAVAILABLE', 503);
    }
  }

  async current(actor: {
    accountId: string;
    userId: string;
  }): Promise<DeveloperApplication | null> {
    if (!validIdentity(actor.accountId, actor.userId)) {
      fail('DEVELOPER_APPLICATION_INPUT_INVALID', 400);
    }
    try {
      return mutationValue(await this.input.repository.current(actor));
    } catch (error) {
      if (error instanceof DeveloperApplicationError) throw error;
      fail('DEVELOPER_APPLICATION_DEPENDENCY_UNAVAILABLE', 503);
    }
  }

  async decide(input: {
    actorUserId: string;
    applicationId: string;
    decision: 'approve' | 'reject';
    expectedRevision: number;
    reason: unknown;
  }): Promise<DeveloperApplication> {
    if (
      !validIdentity(input.actorUserId, input.applicationId) ||
      (input.decision !== 'approve' && input.decision !== 'reject') ||
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 0
    ) {
      fail('DEVELOPER_APPLICATION_INPUT_INVALID', 400);
    }
    const now = this.now();
    if (!Number.isFinite(now.getTime())) fail('DEVELOPER_APPLICATION_INPUT_INVALID', 400);
    try {
      return mutationValue(
        await this.input.repository.decide({
          ...input,
          reason: normalizeReason(input.reason),
          now: now.toISOString(),
        }),
      );
    } catch (error) {
      if (error instanceof DeveloperApplicationError) throw error;
      fail('DEVELOPER_APPLICATION_DEPENDENCY_UNAVAILABLE', 503);
    }
  }

  async suspend(input: {
    actorUserId: string;
    applicationId: string;
    expectedRevision: number;
    reason: unknown;
  }): Promise<DeveloperApplication> {
    if (
      !validIdentity(input.actorUserId, input.applicationId) ||
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 0
    ) {
      fail('DEVELOPER_APPLICATION_INPUT_INVALID', 400);
    }
    const now = this.now();
    if (!Number.isFinite(now.getTime())) fail('DEVELOPER_APPLICATION_INPUT_INVALID', 400);
    try {
      return mutationValue(
        await this.input.repository.suspend({
          ...input,
          reason: normalizeReason(input.reason),
          now: now.toISOString(),
        }),
      );
    } catch (error) {
      if (error instanceof DeveloperApplicationError) throw error;
      fail('DEVELOPER_APPLICATION_DEPENDENCY_UNAVAILABLE', 503);
    }
  }

  async adminList(
    input: { state?: DeveloperApplicationState; limit?: number; cursor?: string | null } = {},
  ): Promise<DeveloperApplicationAdminPage> {
    const state = input.state ?? 'submitted';
    if (!DEVELOPER_APPLICATION_STATES.includes(state)) {
      fail('DEVELOPER_APPLICATION_INPUT_INVALID', 400);
    }
    const limit = Math.min(Math.max(Math.trunc(input.limit ?? 50), 1), 100);
    try {
      const page = await this.input.repository.adminList({
        state,
        limit,
        cursor: decodeAdminCursor(input.cursor),
      });
      const last = page.applications.at(-1)?.application;
      return {
        applications: clone(page.applications),
        next_cursor:
          page.hasMore && last
            ? encodeAdminCursor({ updatedAt: last.updated_at, applicationId: last.application_id })
            : null,
      };
    } catch (error) {
      if (error instanceof DeveloperApplicationError) throw error;
      fail('DEVELOPER_APPLICATION_DEPENDENCY_UNAVAILABLE', 503);
    }
  }

  async adminGet(input: { applicationId: string }): Promise<DeveloperApplicationAdminDetail> {
    if (!validIdentity(input.applicationId)) {
      fail('DEVELOPER_APPLICATION_INPUT_INVALID', 400);
    }
    try {
      const item = await this.input.repository.adminGet(input.applicationId);
      if (!item) fail('DEVELOPER_APPLICATION_NOT_FOUND', 404);
      const [policyAcceptances, history] = await Promise.all([
        this.input.repository.listPolicyAcceptances(
          item.application.account_id,
          item.application.created_by,
        ),
        this.input.repository.getAuditHistory(item.application.application_id),
      ]);
      return {
        ...clone(item),
        policy_acceptances: clone([...policyAcceptances]),
        history: clone([...history]),
      };
    } catch (error) {
      if (error instanceof DeveloperApplicationError) throw error;
      fail('DEVELOPER_APPLICATION_DEPENDENCY_UNAVAILABLE', 503);
    }
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export function createMemoryDeveloperApplicationRepository(input?: {
  members?: readonly { accountId: string; userId: string }[];
  organizations?: readonly DeveloperOrganization[];
  applications?: readonly DeveloperApplication[];
  createId?: () => string;
}): DeveloperApplicationRepository {
  const members = new Set(
    (input?.members ?? []).map((member) => `${member.accountId}\0${member.userId}`),
  );
  const organizations = new Map(
    (input?.organizations ?? []).map((organization) => [
      organization.organization_id,
      clone(organization),
    ]),
  );
  const applications = new Map(
    (input?.applications ?? []).map((application) => [
      application.application_id,
      clone(application),
    ]),
  );
  const policyAcceptances: DeveloperApplicationPolicyAcceptance[] = [];
  const audits: DeveloperApplicationAuditEvent[] = [];
  const createId = input?.createId ?? crypto.randomUUID;

  const byAccount = (accountId: string) =>
    [...applications.values()].find((application) => application.account_id === accountId);
  const organizationByAccount = (accountId: string) =>
    [...organizations.values()].find((organization) => organization.account_id === accountId);
  const appendAudit = (event: DeveloperApplicationAuditEvent) => audits.push(clone(event));

  return {
    async submit(command) {
      if (!members.has(`${command.accountId}\0${command.userId}`)) {
        return { ok: false, reason: 'not_found' };
      }
      let organization = organizationByAccount(command.accountId);
      if (organization && organization.name !== command.organizationName) {
        return { ok: false, reason: 'conflict' };
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
          created_by: command.userId,
          created_at: command.now,
          updated_at: command.now,
        };
        organizations.set(organization.organization_id, clone(organization));
      }

      const existing = byAccount(command.accountId);
      if (existing) {
        if (
          ['submitted', 'under_review', 'approved'].includes(existing.state) &&
          existing.organization_id === organization.organization_id &&
          existing.policy_versions.moduleRules === command.policyVersions.moduleRules &&
          existing.policy_versions.acceptableUse === command.policyVersions.acceptableUse
        ) {
          return { ok: true, value: { application: clone(existing), created: false } };
        }
        return { ok: false, reason: 'conflict' };
      }

      const application: DeveloperApplication = {
        application_id: createId(),
        account_id: command.accountId,
        organization_id: organization.organization_id,
        state: 'submitted',
        revision: 0,
        policy_versions: clone(command.policyVersions),
        submitted_at: command.now,
        decided_at: null,
        suspended_at: null,
        decision_reason: null,
        created_by: command.userId,
        updated_by: null,
        created_at: command.now,
        updated_at: command.now,
      };
      applications.set(application.application_id, clone(application));
      for (const acceptance of [
        { policy: 'acceptable_use' as const, version: command.policyVersions.acceptableUse },
        { policy: 'module_rules' as const, version: command.policyVersions.moduleRules },
      ]) {
        if (
          !policyAcceptances.some(
            (row) =>
              row.account_id === command.accountId &&
              row.user_id === command.userId &&
              row.policy === acceptance.policy &&
              row.version === acceptance.version,
          )
        ) {
          policyAcceptances.push({
            account_id: command.accountId,
            user_id: command.userId,
            ...acceptance,
            source: 'developer_application',
            accepted_at: command.now,
          });
        }
      }
      appendAudit({
        action: 'developer_application.submitted',
        account_id: application.account_id,
        application_id: application.application_id,
        actor_user_id: command.userId,
        from_state: null,
        to_state: { state: 'submitted', revision: 0 },
        metadata: { organization_id: application.organization_id },
        created_at: command.now,
      });
      return { ok: true, value: { application: clone(application), created: true } };
    },

    async current(command) {
      if (!members.has(`${command.accountId}\0${command.userId}`)) {
        return { ok: false, reason: 'not_found' };
      }
      return { ok: true, value: clone(byAccount(command.accountId) ?? null) };
    },

    async decide(command) {
      const application = applications.get(command.applicationId);
      if (!application) return { ok: false, reason: 'not_found' };
      if (
        application.revision !== command.expectedRevision ||
        !['submitted', 'under_review'].includes(application.state)
      ) {
        return { ok: false, reason: 'conflict' };
      }
      const organization = organizations.get(application.organization_id);
      if (!organization || organization.account_id !== application.account_id) {
        return { ok: false, reason: 'not_found' };
      }
      if (organization.verification_state === 'suspended') {
        return { ok: false, reason: 'conflict' };
      }
      const fromState = { state: application.state, revision: application.revision };
      application.state = command.decision === 'approve' ? 'approved' : 'rejected';
      application.revision += 1;
      application.decided_at = command.now;
      application.decision_reason = command.decision === 'reject' ? command.reason : null;
      application.updated_by = command.actorUserId;
      application.updated_at = command.now;
      organization.verification_state = command.decision === 'approve' ? 'verified' : 'rejected';
      organization.verification_revision += 1;
      organization.verification_changed_by = command.actorUserId;
      organization.verification_changed_at = command.now;
      organization.updated_at = command.now;
      appendAudit({
        action:
          command.decision === 'approve'
            ? 'developer_application.approved'
            : 'developer_application.rejected',
        account_id: application.account_id,
        application_id: application.application_id,
        actor_user_id: command.actorUserId,
        from_state: fromState,
        to_state: { state: application.state, revision: application.revision },
        metadata: { reason: command.reason },
        created_at: command.now,
      });
      return { ok: true, value: clone(application) };
    },

    async suspend(command) {
      const application = applications.get(command.applicationId);
      if (!application) return { ok: false, reason: 'not_found' };
      if (application.revision !== command.expectedRevision || application.state !== 'approved') {
        return { ok: false, reason: 'conflict' };
      }
      const organization = organizations.get(application.organization_id);
      if (!organization || organization.account_id !== application.account_id) {
        return { ok: false, reason: 'not_found' };
      }
      const fromState = { state: application.state, revision: application.revision };
      application.state = 'suspended';
      application.revision += 1;
      application.suspended_at = command.now;
      application.decision_reason = command.reason;
      application.updated_by = command.actorUserId;
      application.updated_at = command.now;
      organization.verification_state = 'suspended';
      organization.verification_revision += 1;
      organization.verification_changed_by = command.actorUserId;
      organization.verification_changed_at = command.now;
      organization.updated_at = command.now;
      appendAudit({
        action: 'developer_application.suspended',
        account_id: application.account_id,
        application_id: application.application_id,
        actor_user_id: command.actorUserId,
        from_state: fromState,
        to_state: { state: application.state, revision: application.revision },
        metadata: { reason: command.reason },
        created_at: command.now,
      });
      return { ok: true, value: clone(application) };
    },

    async getOrganization(accountId, organizationId) {
      const organization = organizations.get(organizationId);
      return organization?.account_id === accountId ? clone(organization) : null;
    },

    async getAuditHistory(applicationId) {
      return audits
        .filter((event) => event.application_id === applicationId)
        .map((event) => clone(event));
    },

    async listPolicyAcceptances(accountId, userId) {
      return policyAcceptances
        .filter((row) => row.account_id === accountId && row.user_id === userId)
        .sort((left, right) => left.policy.localeCompare(right.policy))
        .map((row) => clone(row));
    },

    async adminList({ state, limit, cursor }) {
      const ordered = [...applications.values()]
        .filter((application) => application.state === state)
        .sort(
          (left, right) =>
            right.updated_at.localeCompare(left.updated_at) ||
            right.application_id.localeCompare(left.application_id),
        )
        .filter(
          (application) =>
            !cursor ||
            application.updated_at < cursor.updatedAt ||
            (application.updated_at === cursor.updatedAt &&
              application.application_id < cursor.applicationId),
        );
      const page = ordered.slice(0, limit);
      return {
        applications: page.map((application) => {
          const organization = organizations.get(application.organization_id);
          if (!organization || organization.account_id !== application.account_id) {
            throw new Error('DEVELOPER_APPLICATION_ORGANIZATION_INCONSISTENT');
          }
          return {
            application: clone(application),
            organization: clone(organization),
          };
        }),
        hasMore: ordered.length > limit,
      };
    },

    async adminGet(applicationId) {
      const application = applications.get(applicationId);
      if (!application) return null;
      const organization = organizations.get(application.organization_id);
      if (!organization || organization.account_id !== application.account_id) return null;
      return { application: clone(application), organization: clone(organization) };
    },
  };
}
