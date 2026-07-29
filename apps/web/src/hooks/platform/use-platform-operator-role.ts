import { useQuery, type UseQueryOptions } from '@tanstack/react-query';

import { useAuth } from '@/features/providers/auth-provider';
import { backendApi } from '@/lib/api-client';

interface PlatformOperatorRoleResponse {
  isAdmin: boolean;
  role?: 'admin' | 'super_admin' | null;
}

export function usePlatformOperatorRole(
  options?: Partial<UseQueryOptions<PlatformOperatorRoleResponse>>,
) {
  const { user } = useAuth();

  return useQuery<PlatformOperatorRoleResponse>({
    queryKey: ['platform-operator-role', user?.id],
    queryFn: async () => {
      if (!user) return { isAdmin: false, role: null };
      const response = await backendApi.get<PlatformOperatorRoleResponse>('/user-roles', {
        showErrors: false,
      });
      return response.success && response.data
        ? response.data
        : { isAdmin: false, role: null };
    },
    enabled: Boolean(user) && options?.enabled !== false,
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: true,
    refetchOnMount: true,
    ...options,
  });
}
