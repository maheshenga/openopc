import { backendApi } from '../../http/api-client';
import { unwrap } from './shared';

export type AccountRequestKind =
  | 'data_export'
  | 'account_deletion'
  | 'security_report'
  | 'module_report';

export type AccountRequestStatus =
  | 'pending'
  | 'cooling_off'
  | 'processing'
  | 'completed'
  | 'cancelled'
  | 'rejected'
  | 'expired';

export interface AccountRequest {
  request_id: string;
  account_id: string;
  requested_by: string;
  kind: AccountRequestKind;
  status: AccountRequestStatus;
  reason: string | null;
  module_installation_id: string | null;
  requested_at: string;
  not_before_at: string | null;
  processing_started_at: string | null;
  terminal_at: string | null;
  expires_at: string | null;
  result_metadata: Record<string, unknown>;
  updated_at: string;
}

export interface CreateAccountRequestInput {
  accountId: string;
  kind: AccountRequestKind;
  reason?: string;
  moduleInstallationId?: string;
  idempotencyKey: string;
}

export interface AccountRequestScope {
  accountId: string;
}

export interface AccountRequestCreateResponse {
  request: AccountRequest;
  created: boolean;
}

export interface AccountRequestListResponse {
  requests: AccountRequest[];
}

export async function createAccountRequest(
  input: CreateAccountRequestInput,
): Promise<AccountRequestCreateResponse> {
  return unwrap(
    await backendApi.post<AccountRequestCreateResponse>('/account/requests', {
      account_id: input.accountId,
      kind: input.kind,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      ...(input.moduleInstallationId !== undefined
        ? { module_installation_id: input.moduleInstallationId }
        : {}),
      idempotency_key: input.idempotencyKey,
    }),
    'Failed to create account request',
  );
}

export async function listAccountRequests(
  scope: AccountRequestScope,
): Promise<AccountRequestListResponse> {
  return unwrap(
    await backendApi.get<AccountRequestListResponse>(
      `/account/requests?account_id=${encodeURIComponent(scope.accountId)}`,
    ),
    'Failed to list account requests',
  );
}

export async function cancelAccountRequest(
  requestId: string,
  scope: AccountRequestScope,
): Promise<{ request: AccountRequest }> {
  return unwrap(
    await backendApi.post<{ request: AccountRequest }>(
      `/account/requests/${encodeURIComponent(requestId)}/cancel`,
      { account_id: scope.accountId },
    ),
    'Failed to cancel account request',
  );
}
