'use client';

import {
  type DeveloperModuleReviewTransition,
  type DeveloperModuleTrustView,
  type RequestDeveloperModuleReviewInput,
  getDeveloperModuleRelease,
  getDeveloperModuleReviewHistory,
  getDeveloperModuleTrust,
  listDeveloperModuleReleases,
  requestDeveloperModuleReview,
  retryDeveloperModuleVerification,
} from '@kortix/sdk';
import { skipToken, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { developerCenterErrorCode } from '../model';

export const developerModuleKeys = {
  all: ['developer-modules'] as const,
  account: (accountId: string) => ['developer-modules', 'account', accountId] as const,
  list: (accountId: string) => [...developerModuleKeys.account(accountId), 'list'] as const,
  detail: (accountId: string, releaseId: string) =>
    [...developerModuleKeys.account(accountId), 'detail', releaseId] as const,
  history: (accountId: string, releaseId: string) =>
    [...developerModuleKeys.account(accountId), 'history', releaseId] as const,
  trust: (accountId: string, releaseId: string) =>
    [...developerModuleKeys.account(accountId), 'trust', releaseId] as const,
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

export function developerModuleTrustPollInterval(
  trust: Pick<DeveloperModuleTrustView, 'attempts'> | null | undefined,
): 2000 | false {
  const state = trust?.attempts.at(-1)?.state;
  return state === 'queued' || state === 'running' ? 2_000 : false;
}

export function publisherModuleTrustQuery(accountId: string, releaseId: string) {
  return {
    queryKey: developerModuleKeys.trust(accountId, releaseId),
    queryFn: () => getDeveloperModuleTrust(releaseId, { accountId }),
    staleTime: 2_000,
    refetchInterval: (query: { state: { data: DeveloperModuleTrustView | undefined } }) =>
      developerModuleTrustPollInterval(query.state.data),
  };
}

export function usePublisherModuleReleases(accountId: string | null, enabled = true) {
  return useQuery({
    queryKey: accountId
      ? developerModuleKeys.list(accountId)
      : [...developerModuleKeys.all, 'idle', 'list'],
    queryFn: accountId ? () => listDeveloperModuleReleases({ accountId, limit: 100 }) : skipToken,
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
    queryFn: accountId ? () => getDeveloperModuleRelease(releaseId, { accountId }) : skipToken,
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
    queryFn: accountId
      ? () => getDeveloperModuleReviewHistory(releaseId, { accountId })
      : skipToken,
    enabled: Boolean(accountId) && Boolean(releaseId) && enabled,
    staleTime: 15_000,
  });
}

export function usePublisherModuleTrust(
  accountId: string | null,
  releaseId: string,
  enabled = true,
) {
  return useQuery({
    queryKey: accountId
      ? developerModuleKeys.trust(accountId, releaseId)
      : [...developerModuleKeys.all, 'idle', 'trust', releaseId],
    queryFn: accountId ? () => getDeveloperModuleTrust(releaseId, { accountId }) : skipToken,
    enabled: Boolean(accountId) && Boolean(releaseId) && enabled,
    staleTime: 2_000,
    refetchInterval: (query) => developerModuleTrustPollInterval(query.state.data),
  });
}

export interface PublisherVerificationRetryInput {
  accountId: string;
  releaseId: string;
}

export function submitPublisherVerificationRetry(input: PublisherVerificationRetryInput) {
  return retryDeveloperModuleVerification(input.releaseId, { accountId: input.accountId });
}

export function useRetryPublisherVerification() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: submitPublisherVerificationRetry,
    retry: false,
    onSuccess: async (_run, input) => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: developerModuleKeys.trust(input.accountId, input.releaseId),
        }),
        queryClient.invalidateQueries({
          queryKey: developerModuleKeys.detail(input.accountId, input.releaseId),
        }),
      ]);
    },
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
