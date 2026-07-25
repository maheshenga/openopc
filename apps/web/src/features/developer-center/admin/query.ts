'use client';

import type {
  DeveloperModuleHumanReviewEvidence,
  DeveloperModuleRelease,
  DeveloperModuleTrustView,
} from '@kortix/sdk';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  type AdminDeveloperDistributionAction,
  type AdminDeveloperLifecycleEvent,
  type AdminDeveloperReviewDecision,
  type AdminDeveloperReviewDetail,
  type AdminDeveloperReviewPage,
  adminDeveloperReviewErrorCode,
  cancelAdminDeveloperModuleVerification,
  decideAdminDeveloperReview,
  getAdminDeveloperModuleTrust,
  getAdminDeveloperReview,
  listAdminDeveloperReviews,
  publishAdminDeveloperModuleRelease,
  retryAdminDeveloperModuleVerification,
  signAdminDeveloperModuleRelease,
} from './client';
import { buildAdminDecisionBody } from './evidence';

export const adminDeveloperReviewKeys = {
  all: ['admin-developer-reviews'] as const,
  list: (status: DeveloperModuleRelease['status'], cursor: string | null) =>
    ['admin-developer-reviews', 'list', status, cursor ?? 'first'] as const,
  detail: (releaseId: string) => ['admin-developer-reviews', 'detail', releaseId] as const,
  trust: (releaseId: string) => ['admin-developer-reviews', 'trust', releaseId] as const,
};

const queuePrefix = (status: DeveloperModuleRelease['status']) =>
  ['admin-developer-reviews', 'list', status] as const;

export function adminDeveloperReviewQueueQuery(
  status: DeveloperModuleRelease['status'] = 'review_pending',
  cursor: string | null = null,
) {
  return {
    queryKey: adminDeveloperReviewKeys.list(status, cursor),
    queryFn: () => listAdminDeveloperReviews({ status, cursor }),
    staleTime: 15_000,
  };
}

export function adminDeveloperReviewDetailQuery(releaseId: string) {
  return {
    queryKey: adminDeveloperReviewKeys.detail(releaseId),
    queryFn: () => getAdminDeveloperReview(releaseId),
    staleTime: 15_000,
  };
}

export function adminDeveloperTrustQuery(releaseId: string) {
  return {
    queryKey: adminDeveloperReviewKeys.trust(releaseId),
    queryFn: () => getAdminDeveloperModuleTrust(releaseId),
    staleTime: 2_000,
    refetchInterval: (query: { state: { data: DeveloperModuleTrustView | undefined } }) => {
      const state = query.state.data?.attempts.at(-1)?.state;
      return state === 'queued' || state === 'running' ? 2_000 : false;
    },
  };
}

export function useAdminDeveloperReviewQueue(
  status: DeveloperModuleRelease['status'] = 'review_pending',
  cursor: string | null = null,
  enabled = true,
) {
  return useQuery({
    ...adminDeveloperReviewQueueQuery(status, cursor),
    enabled,
  });
}

export function useAdminDeveloperReviewDetail(releaseId: string, enabled = true) {
  return useQuery({
    ...adminDeveloperReviewDetailQuery(releaseId),
    enabled: Boolean(releaseId) && enabled,
  });
}

export function useAdminDeveloperTrust(releaseId: string, enabled = true) {
  return useQuery({
    ...adminDeveloperTrustQuery(releaseId),
    enabled: Boolean(releaseId) && enabled,
  });
}

export interface AdminDeveloperReviewDecisionInput {
  release: Pick<
    DeveloperModuleRelease,
    'release_id' | 'status' | 'review_revision' | 'review_requirements'
  >;
  decision: AdminDeveloperReviewDecision;
  reason?: string;
  evidence?: readonly DeveloperModuleHumanReviewEvidence[];
}

export async function submitAdminDeveloperReviewDecision(input: AdminDeveloperReviewDecisionInput) {
  return decideAdminDeveloperReview(
    input.release.release_id,
    buildAdminDecisionBody(input.release, input.decision, {
      reason: input.reason,
      evidence: input.evidence,
    }),
  );
}

export function useAdminDeveloperReviewDecision() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: submitAdminDeveloperReviewDecision,
    retry: false,
    onSuccess: async (transition, input) => {
      queryClient.setQueryData<AdminDeveloperReviewDetail>(
        adminDeveloperReviewKeys.detail(input.release.release_id),
        (current) =>
          current
            ? {
                release: transition.release,
                history: [...current.history, transition.event],
              }
            : current,
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queuePrefix(input.release.status) }),
        queryClient.invalidateQueries({ queryKey: queuePrefix(transition.release.status) }),
      ]);
    },
    onError: async (error, input) => {
      const code = adminDeveloperReviewErrorCode(error);
      if (code === 'DEVELOPER_TRUST_GATE_UNMET') {
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: adminDeveloperReviewKeys.detail(input.release.release_id),
          }),
          queryClient.invalidateQueries({
            queryKey: adminDeveloperReviewKeys.trust(input.release.release_id),
          }),
        ]);
        return;
      }
      if (code !== 'DEVELOPER_REVIEW_CONFLICT') return;
      queryClient.removeQueries({
        queryKey: adminDeveloperReviewKeys.detail(input.release.release_id),
      });
      await queryClient.refetchQueries({
        queryKey: adminDeveloperReviewKeys.detail(input.release.release_id),
      });
    },
  });
}

export interface AdminDeveloperDistributionMutationInput {
  release: Pick<DeveloperModuleRelease, 'release_id' | 'status' | 'review_revision'>;
  action: AdminDeveloperDistributionAction;
}

export function submitAdminDeveloperDistribution(input: AdminDeveloperDistributionMutationInput) {
  if (input.action === 'sign') {
    return signAdminDeveloperModuleRelease(input.release.release_id, {
      expected_status: 'approved',
      expected_revision: input.release.review_revision,
    });
  }
  return publishAdminDeveloperModuleRelease(input.release.release_id, {
    expected_status: 'signed',
    expected_revision: input.release.review_revision,
  });
}

export function useAdminDeveloperDistribution() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: submitAdminDeveloperDistribution,
    retry: false,
    onSuccess: async (transition, input) => {
      queryClient.setQueryData<AdminDeveloperReviewDetail>(
        adminDeveloperReviewKeys.detail(input.release.release_id),
        (current) =>
          current
            ? {
                release: transition.release,
                history: [...current.history, transition.event as AdminDeveloperLifecycleEvent],
              }
            : current,
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: adminDeveloperReviewKeys.all }),
        queryClient.invalidateQueries({
          queryKey: adminDeveloperReviewKeys.detail(input.release.release_id),
        }),
      ]);
    },
    onError: async (error, input) => {
      const code = adminDeveloperReviewErrorCode(error);
      if (code === 'DEVELOPER_TRUST_GATE_UNMET') {
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: adminDeveloperReviewKeys.detail(input.release.release_id),
          }),
          queryClient.invalidateQueries({
            queryKey: adminDeveloperReviewKeys.trust(input.release.release_id),
          }),
        ]);
        return;
      }
      if (code !== 'DEVELOPER_DISTRIBUTION_CONFLICT') return;
      queryClient.removeQueries({
        queryKey: adminDeveloperReviewKeys.detail(input.release.release_id),
      });
      await queryClient.refetchQueries({
        queryKey: adminDeveloperReviewKeys.detail(input.release.release_id),
      });
    },
  });
}

export type AdminDeveloperVerificationAction = 'retry' | 'cancel';

export function submitAdminDeveloperVerification(input: {
  releaseId: string;
  action: AdminDeveloperVerificationAction;
}) {
  return input.action === 'retry'
    ? retryAdminDeveloperModuleVerification(input.releaseId)
    : cancelAdminDeveloperModuleVerification(input.releaseId);
}

export function useAdminDeveloperVerification() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: submitAdminDeveloperVerification,
    retry: false,
    onSuccess: async (_run, input) => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: adminDeveloperReviewKeys.trust(input.releaseId),
        }),
        queryClient.invalidateQueries({
          queryKey: adminDeveloperReviewKeys.detail(input.releaseId),
        }),
      ]);
    },
    onError: async (_error, input) => {
      await queryClient.invalidateQueries({
        queryKey: adminDeveloperReviewKeys.trust(input.releaseId),
      });
    },
  });
}

export type { AdminDeveloperReviewDetail, AdminDeveloperReviewPage };
