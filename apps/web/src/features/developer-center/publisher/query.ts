'use client';

import {
  getDeveloperModuleRelease,
  getDeveloperModuleReviewHistory,
  listDeveloperModuleReleases,
  requestDeveloperModuleReview,
  type DeveloperModuleReviewTransition,
  type RequestDeveloperModuleReviewInput,
} from '@kortix/sdk';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { developerCenterErrorCode } from '../model';

export const developerModuleKeys = {
  all: ['developer-modules'] as const,
  account: (accountId: string) => ['developer-modules', 'account', accountId] as const,
  list: (accountId: string) => [...developerModuleKeys.account(accountId), 'list'] as const,
  detail: (accountId: string, releaseId: string) =>
    [...developerModuleKeys.account(accountId), 'detail', releaseId] as const,
  history: (accountId: string, releaseId: string) =>
    [...developerModuleKeys.account(accountId), 'history', releaseId] as const,
};

export function publisherModuleReleasesQuery(accountId: string) {
  return {
    queryKey: developerModuleKeys.list(accountId),
    queryFn: () => listDeveloperModuleReleases({ accountId, limit: 100 }),
    staleTime: 15_000,
  };
}

export function publisherModuleDetailQuery(accountId: string, releaseId: string) {
  return {
    queryKey: developerModuleKeys.detail(accountId, releaseId),
    queryFn: () => getDeveloperModuleRelease(releaseId, { accountId }),
    staleTime: 15_000,
  };
}

export function publisherModuleHistoryQuery(accountId: string, releaseId: string) {
  return {
    queryKey: developerModuleKeys.history(accountId, releaseId),
    queryFn: () => getDeveloperModuleReviewHistory(releaseId, { accountId }),
    staleTime: 15_000,
  };
}

export function usePublisherModuleReleases(accountId: string | null, enabled = true) {
  return useQuery({
    queryKey: accountId ? developerModuleKeys.list(accountId) : [...developerModuleKeys.all, 'idle', 'list'],
    queryFn: () => listDeveloperModuleReleases({ accountId: accountId!, limit: 100 }),
    enabled: Boolean(accountId) && enabled,
    staleTime: 15_000,
  });
}

export function usePublisherModuleDetail(
  accountId: string | null,
  releaseId: string,
  enabled = true,
) {
  return useQuery({
    queryKey: accountId
      ? developerModuleKeys.detail(accountId, releaseId)
      : [...developerModuleKeys.all, 'idle', 'detail', releaseId],
    queryFn: () => getDeveloperModuleRelease(releaseId, { accountId: accountId! }),
    enabled: Boolean(accountId) && Boolean(releaseId) && enabled,
    staleTime: 15_000,
  });
}

export function usePublisherModuleHistory(
  accountId: string | null,
  releaseId: string,
  enabled = true,
) {
  return useQuery({
    queryKey: accountId
      ? developerModuleKeys.history(accountId, releaseId)
      : [...developerModuleKeys.all, 'idle', 'history', releaseId],
    queryFn: () => getDeveloperModuleReviewHistory(releaseId, { accountId: accountId! }),
    enabled: Boolean(accountId) && Boolean(releaseId) && enabled,
    staleTime: 15_000,
  });
}

export interface PublisherReviewMutationInput {
  accountId: string;
  releaseId: string;
  expectedStatus: RequestDeveloperModuleReviewInput['expectedStatus'];
  expectedRevision: number;
  reason?: string;
}

export function submitPublisherReview(
  input: PublisherReviewMutationInput,
): Promise<DeveloperModuleReviewTransition> {
  return requestDeveloperModuleReview(input.releaseId, {
    accountId: input.accountId,
    expectedStatus: input.expectedStatus,
    expectedRevision: input.expectedRevision,
    reason: input.reason,
  });
}

export function useRequestPublisherReview() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: submitPublisherReview,
    onSuccess: async (transition, input) => {
      queryClient.setQueryData(
        developerModuleKeys.detail(input.accountId, input.releaseId),
        transition.release,
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: developerModuleKeys.list(input.accountId) }),
        queryClient.invalidateQueries({
          queryKey: developerModuleKeys.history(input.accountId, input.releaseId),
        }),
      ]);
    },
    onError: async (error, input) => {
      if (developerCenterErrorCode(error) !== 'DEVELOPER_REVIEW_CONFLICT') return;
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: developerModuleKeys.detail(input.accountId, input.releaseId),
        }),
        queryClient.invalidateQueries({
          queryKey: developerModuleKeys.history(input.accountId, input.releaseId),
        }),
      ]);
    },
  });
}
