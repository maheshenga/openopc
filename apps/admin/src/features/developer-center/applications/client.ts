import type {
  DeveloperApplication,
  DeveloperApplicationState,
  DeveloperOrganization,
} from '@kortix/sdk';

import { backendApi } from '@/lib/api-client';

export interface AdminDeveloperApplicationPolicyAcceptance {
  account_id: string;
  user_id: string;
  policy: 'acceptable_use' | 'module_rules';
  version: string;
  source: 'developer_application';
  accepted_at: string;
}

export interface AdminDeveloperApplicationAuditEvent {
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

export interface AdminDeveloperApplicationListItem {
  application: DeveloperApplication;
  organization: DeveloperOrganization;
}

export interface AdminDeveloperApplicationPage {
  applications: AdminDeveloperApplicationListItem[];
  next_cursor: string | null;
}

export interface AdminDeveloperApplicationDetail extends AdminDeveloperApplicationListItem {
  policy_acceptances: AdminDeveloperApplicationPolicyAcceptance[];
  history: AdminDeveloperApplicationAuditEvent[];
}

export interface AdminDeveloperApplicationDecisionBody {
  decision: 'approve' | 'reject';
  expected_revision: number;
  reason: string;
}

export interface AdminDeveloperApplicationSuspensionBody {
  expected_revision: number;
  reason: string;
}

export type AdminDeveloperApplicationErrorCode =
  | 'DEVELOPER_APPLICATION_INPUT_INVALID'
  | 'DEVELOPER_APPLICATION_NOT_FOUND'
  | 'DEVELOPER_APPLICATION_FORBIDDEN'
  | 'DEVELOPER_APPLICATION_STEP_UP_REQUIRED'
  | 'DEVELOPER_APPLICATION_CONFLICT'
  | 'DEVELOPER_APPLICATION_DEPENDENCY_UNAVAILABLE'
  | 'DEVELOPER_APPLICATION_REQUEST_FAILED';

const STABLE_ERROR_CODES = new Set<AdminDeveloperApplicationErrorCode>([
  'DEVELOPER_APPLICATION_INPUT_INVALID',
  'DEVELOPER_APPLICATION_NOT_FOUND',
  'DEVELOPER_APPLICATION_FORBIDDEN',
  'DEVELOPER_APPLICATION_STEP_UP_REQUIRED',
  'DEVELOPER_APPLICATION_CONFLICT',
  'DEVELOPER_APPLICATION_DEPENDENCY_UNAVAILABLE',
]);

export class AdminDeveloperApplicationError extends Error {
  constructor(readonly code: AdminDeveloperApplicationErrorCode) {
    super(code);
    this.name = 'AdminDeveloperApplicationError';
  }
}

function stableCode(value: unknown): AdminDeveloperApplicationErrorCode | null {
  return typeof value === 'string' && STABLE_ERROR_CODES.has(value as AdminDeveloperApplicationErrorCode)
    ? (value as AdminDeveloperApplicationErrorCode)
    : null;
}

export function adminDeveloperApplicationErrorCode(
  error: unknown,
): AdminDeveloperApplicationErrorCode {
  const visited = new Set<object>();

  const visit = (value: unknown): AdminDeveloperApplicationErrorCode | null => {
    const direct = stableCode(value);
    if (direct) return direct;
    if (!value || typeof value !== 'object' || visited.has(value)) return null;
    visited.add(value);

    const record = value as Record<string, unknown>;
    for (const key of ['code', 'error', 'error_code', 'message']) {
      const found = stableCode(record[key]);
      if (found) return found;
    }
    for (const key of ['details', 'data', 'detail', 'body', 'response']) {
      const found = visit(record[key]);
      if (found) return found;
    }
    return null;
  };

  return visit(error) ?? 'DEVELOPER_APPLICATION_REQUEST_FAILED';
}

function unwrapAdmin<T>(response: { data?: T; success: boolean; error?: unknown }): T {
  if (!response.success || response.data === undefined) {
    throw new AdminDeveloperApplicationError(adminDeveloperApplicationErrorCode(response.error));
  }
  return response.data;
}

export async function listAdminDeveloperApplications(input: {
  state: DeveloperApplicationState;
  limit?: number;
  cursor?: string | null;
}): Promise<AdminDeveloperApplicationPage> {
  const query = new URLSearchParams({ state: input.state, limit: String(input.limit ?? 50) });
  if (input.cursor) query.set('cursor', input.cursor);
  return unwrapAdmin(
    await backendApi.get<AdminDeveloperApplicationPage>(
      `/admin/developer/applications?${query.toString()}`,
    ),
  );
}

export async function getAdminDeveloperApplication(
  applicationId: string,
): Promise<AdminDeveloperApplicationDetail> {
  return unwrapAdmin(
    await backendApi.get<AdminDeveloperApplicationDetail>(
      `/admin/developer/applications/${encodeURIComponent(applicationId)}`,
      { adminReason: `Reviewing developer application ${applicationId}` },
    ),
  );
}

export async function decideAdminDeveloperApplication(
  applicationId: string,
  body: AdminDeveloperApplicationDecisionBody,
): Promise<DeveloperApplication> {
  return unwrapAdmin(
    await backendApi.post<DeveloperApplication>(
      `/admin/developer/applications/${encodeURIComponent(applicationId)}/decision`,
      body,
      { adminReason: body.reason },
    ),
  );
}

export async function suspendAdminDeveloperApplication(
  applicationId: string,
  body: AdminDeveloperApplicationSuspensionBody,
): Promise<DeveloperApplication> {
  return unwrapAdmin(
    await backendApi.post<DeveloperApplication>(
      `/admin/developer/applications/${encodeURIComponent(applicationId)}/suspend`,
      body,
      { adminReason: body.reason },
    ),
  );
}
