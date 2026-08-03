'use client';

import {
  type CreateDeveloperPublisherInput,
  createDeveloperPublisher,
  getDeveloperAccess,
} from '@kortix/sdk';
import {
  type QueryClient,
  skipToken,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';

export const developerPublisherAccessKeys = {
  all: ['developer-publisher-access'] as const,
  account: (accountId: string) => ['developer-publisher-access', accountId] as const,
};

export function developerPublisherAccessQuery(accountId: string) {
  return {
    queryKey: developerPublisherAccessKeys.account(accountId),
    queryFn: () => getDeveloperAccess({ accountId }),
    staleTime: 15_000,
  };
}

export function useDeveloperPublisherAccess(accountId: string | null, enabled = true) {
  return useQuery({
    queryKey: accountId
      ? developerPublisherAccessKeys.account(accountId)
      : [...developerPublisherAccessKeys.all, 'idle'],
    queryFn: accountId ? () => getDeveloperAccess({ accountId }) : skipToken,
    enabled: Boolean(accountId) && enabled,
    staleTime: 15_000,
  });
}

export interface CreatePublisherInput extends CreateDeveloperPublisherInput {
  accountId: string;
}

export function createPublisher(input: CreatePublisherInput) {
  return createDeveloperPublisher(input);
}

export function invalidateDeveloperPublisherAccess(
  queryClient: Pick<QueryClient, 'invalidateQueries'>,
  accountId: string,
) {
  return queryClient.invalidateQueries({
    queryKey: developerPublisherAccessKeys.account(accountId),
    exact: true,
  });
}

export function useCreateDeveloperPublisher() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: createPublisher,
    onSuccess: (_result, input) => invalidateDeveloperPublisherAccess(queryClient, input.accountId),
  });
}
