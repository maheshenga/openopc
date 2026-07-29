import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { systemStatusKeys } from '@/hooks/edge-flags';
import { backendApi } from '@/lib/api-client';
import type { MaintenanceConfig } from '@/lib/maintenance-store';

type MaintenanceAdminApi = Pick<typeof backendApi, 'get' | 'put'>;

export async function fetchMaintenanceAdminConfig(
  api: MaintenanceAdminApi = backendApi,
): Promise<MaintenanceConfig> {
  const response = await api.get<MaintenanceConfig>('/system/maintenance', {
    showErrors: false,
  });
  if (response.error) throw new Error(response.error.message);
  if (!response.data) throw new Error('Maintenance config returned no data');
  return response.data;
}

export async function updateMaintenanceAdminConfig(
  data: Partial<MaintenanceConfig>,
  api: MaintenanceAdminApi = backendApi,
): Promise<MaintenanceConfig> {
  const response = await api.put<MaintenanceConfig>('/system/maintenance', data, {
    showErrors: false,
  });
  if (response.error) throw new Error(response.error.message);
  if (!response.data) throw new Error('Maintenance update returned no data');
  return response.data;
}

export const useMaintenanceAdmin = () => {
  return useQuery<MaintenanceConfig>({
    queryKey: ['admin-maintenance-config'],
    queryFn: () => fetchMaintenanceAdminConfig(),
    staleTime: 10 * 1000,
    refetchInterval: 30 * 1000,
  });
};

export const useUpdateMaintenanceConfig = () => {
  const queryClient = useQueryClient();

  return useMutation<MaintenanceConfig, Error, Partial<MaintenanceConfig>>({
    mutationFn: (data: Partial<MaintenanceConfig>) => updateMaintenanceAdminConfig(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-maintenance-config'] });
      queryClient.invalidateQueries({ queryKey: systemStatusKeys.all });
      queryClient.invalidateQueries({ queryKey: systemStatusKeys.config });
    },
  });
};
