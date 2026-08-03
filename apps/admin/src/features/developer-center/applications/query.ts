'use client';

import type { DeveloperApplication, DeveloperApplicationState } from '@kortix/sdk';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';

import {
  type AdminDeveloperApplicationDecisionBody,
  type AdminDeveloperApplicationDetail,
  adminDeveloperApplicationErrorCode,
  decideAdminDeveloperApplication,
  getAdminDeveloperApplication,
  listAdminDeveloperApplications,
  suspendAdminDeveloperApplication,
} from './client';

export const adminDeveloperApplicationKeys = {
  all: ['admin-developer-applications'] as const,
  list: (state: DeveloperApplicationState, cursor: string | null) =>
    ['admin-developer-applications', 'list', state, cursor ?? 'first'] as const,
  detail: (applicationId: string) =>
    ['admin-developer-applications', 'detail', applicationId] as const,
};

export function adminDeveloperApplicationQueueQuery(
  state: DeveloperApplicationState = 'submitted',
  cursor: string | null = null,
) {
  return {
    queryKey: adminDeveloperApplicationKeys.list(state, cursor),
    queryFn: () => listAdminDeveloperApplications({ state, cursor }),
    staleTime: 15_000,
  };
}

export function adminDeveloperApplicationDetailQuery(applicationId: string) {
  return {
    queryKey: adminDeveloperApplicationKeys.detail(applicationId),
    queryFn: () => getAdminDeveloperApplication(applicationId),
    staleTime: 15_000,
  };
}

export function useAdminDeveloperApplicationQueue(
  state: DeveloperApplicationState = 'submitted',
  cursor: string | null = null,
  enabled = true,
) {
  return useQuery({ ...adminDeveloperApplicationQueueQuery(state, cursor), enabled });
}

export function useAdminDeveloperApplicationDetail(applicationId: string, enabled = true) {
  return useQuery({
    ...adminDeveloperApplicationDetailQuery(applicationId),
    enabled: Boolean(applicationId) && enabled,
  });
}

export interface AdminDeveloperApplicationDecisionInput {
  application: Pick<DeveloperApplication, 'application_id' | 'state' | 'revision'>;
  decision: 'approve' | 'reject';
  reason: string;
}

export interface AdminDeveloperApplicationSuspensionInput {
  application: Pick<DeveloperApplication, 'application_id' | 'state' | 'revision'>;
  reason: string;
}

export async function submitAdminDeveloperApplicationDecision(
  input: AdminDeveloperApplicationDecisionInput,
) {
  const body: AdminDeveloperApplicationDecisionBody = {
    decision: input.decision,
    expected_revision: input.application.revision,
    reason: input.reason,
  };
  return decideAdminDeveloperApplication(input.application.application_id, body);
}

export async function submitAdminDeveloperApplicationSuspension(
  input: AdminDeveloperApplicationSuspensionInput,
) {
  return suspendAdminDeveloperApplication(input.application.application_id, {
    expected_revision: input.application.revision,
    reason: input.reason,
  });
}

export async function refreshAdminDeveloperApplicationAfterConflict(
  queryClient: Pick<QueryClient, 'removeQueries' | 'refetchQueries'>,
  applicationId: string,
): Promise<void> {
  queryClient.removeQueries({ queryKey: adminDeveloperApplicationKeys.detail(applicationId) });
  await queryClient.refetchQueries({ queryKey: adminDeveloperApplicationKeys.detail(applicationId) });
}

function invalidateAdminDeveloperApplication(
  queryClient: QueryClient,
  applicationId: string,
): Promise<unknown[]> {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: adminDeveloperApplicationKeys.detail(applicationId) }),
    queryClient.invalidateQueries({ queryKey: adminDeveloperApplicationKeys.all }),
  ]);
}

export function useAdminDeveloperApplicationDecision() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: submitAdminDeveloperApplicationDecision,
    retry: false,
    onSuccess: async (_application, input) => {
      await invalidateAdminDeveloperApplication(queryClient, input.application.application_id);
    },
    onError: async (error, input) => {
      if (adminDeveloperApplicationErrorCode(error) !== 'DEVELOPER_APPLICATION_CONFLICT') return;
      await refreshAdminDeveloperApplicationAfterConflict(queryClient, input.application.application_id);
    },
  });
}

export function useAdminDeveloperApplicationSuspension() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: submitAdminDeveloperApplicationSuspension,
    retry: false,
    onSuccess: async (_application, input) => {
      await invalidateAdminDeveloperApplication(queryClient, input.application.application_id);
    },
    onError: async (error, input) => {
      if (adminDeveloperApplicationErrorCode(error) !== 'DEVELOPER_APPLICATION_CONFLICT') return;
      await refreshAdminDeveloperApplicationAfterConflict(queryClient, input.application.application_id);
    },
  });
}

export type { AdminDeveloperApplicationDetail };
