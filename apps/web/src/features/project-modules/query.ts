'use client';

import type {
  ProjectModuleInstallation,
  ProjectModuleInstallationAction,
  ProjectModuleInstallationTransition,
} from '@kortix/sdk';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  type ModuleServiceConsent,
  type ModuleServiceConsentMutationInput,
  type OpenOpcServiceName,
  grantProjectModuleServiceConsent,
  installPublishedProjectModule,
  listInstalledProjectModules,
  listProjectModuleHistory,
  listProjectModuleServiceConsents,
  listPublishedProjectModuleReleases,
  revokeProjectModuleServiceConsent,
  rollbackPublishedProjectModule,
  updatePublishedProjectModule,
} from './client';

export const projectModuleKeys = {
  all: ['project-modules'] as const,
  installed: (projectId: string) => ['project-modules', projectId, 'installed'] as const,
  releases: () => ['project-modules', 'published-releases'] as const,
  history: (projectId: string, moduleId: string) =>
    ['project-modules', projectId, 'history', moduleId] as const,
  serviceConsents: (projectId: string, installationId: string) =>
    ['project-modules', projectId, 'service-consents', installationId] as const,
  serviceConsentsPrefix: (projectId: string) =>
    ['project-modules', projectId, 'service-consents'] as const,
  serviceCapabilities: (projectId: string, installationId: string) =>
    ['project-modules', projectId, 'service-capabilities', installationId] as const,
};

export const projectModulesQuery = (projectId: string) => ({
  queryKey: projectModuleKeys.installed(projectId),
  queryFn: () => listInstalledProjectModules(projectId),
  staleTime: 15_000,
});

export const projectModuleReleasesQuery = () => ({
  queryKey: projectModuleKeys.releases(),
  queryFn: listPublishedProjectModuleReleases,
  staleTime: 15_000,
});

export const projectModuleHistoryQuery = (projectId: string, moduleId: string) => ({
  queryKey: projectModuleKeys.history(projectId, moduleId),
  queryFn: () => listProjectModuleHistory(projectId, moduleId),
  staleTime: 15_000,
});

export function useProjectModules(projectId: string, enabled = true) {
  return useQuery({ ...projectModulesQuery(projectId), enabled: Boolean(projectId) && enabled });
}

export function useProjectModuleReleases(enabled = true) {
  return useQuery({ ...projectModuleReleasesQuery(), enabled });
}

export function useProjectModuleHistories(
  projectId: string,
  modules: readonly ProjectModuleInstallation[],
  enabled = true,
) {
  return useQueries({
    queries: modules.map((installation) => ({
      ...projectModuleHistoryQuery(projectId, installation.module_id),
      enabled: Boolean(projectId) && enabled,
    })),
  });
}

export const projectModuleServiceConsentsQuery = (projectId: string, installationId: string) => ({
  queryKey: projectModuleKeys.serviceConsents(projectId, installationId),
  queryFn: () => listProjectModuleServiceConsents(projectId, installationId),
  staleTime: 15_000,
});

export function useProjectModuleServiceConsents(
  projectId: string,
  installationId: string,
  enabled = true,
) {
  return useQuery({
    ...projectModuleServiceConsentsQuery(projectId, installationId),
    enabled: Boolean(projectId) && Boolean(installationId) && enabled,
  });
}

export function useProjectModuleServiceConsentsForInstallations(
  projectId: string,
  modules: readonly ProjectModuleInstallation[],
  enabled = true,
) {
  return useQueries({
    queries: modules.map((installation) => ({
      ...projectModuleServiceConsentsQuery(projectId, installation.installation_id),
      enabled: Boolean(projectId) && enabled,
    })),
  });
}

export interface ProjectModuleServiceConsentMutationInput {
  projectId: string;
  installationId: string;
  service: OpenOpcServiceName;
  operations: ModuleServiceConsentMutationInput['operations'];
  expectedInstallRevision: number;
}

export function useGrantProjectModuleServiceConsent() {
  const queryClient = useQueryClient();
  return useMutation<ModuleServiceConsent, Error, ProjectModuleServiceConsentMutationInput>({
    mutationFn: (input) =>
      grantProjectModuleServiceConsent(input.projectId, input.installationId, input.service, {
        operations: input.operations,
        expected_install_revision: input.expectedInstallRevision,
      }),
    retry: false,
    onSuccess: (_consent, input) => {
      void queryClient.invalidateQueries({
        queryKey: projectModuleKeys.serviceConsents(input.projectId, input.installationId),
      });
      void queryClient.invalidateQueries({
        queryKey: projectModuleKeys.serviceCapabilities(input.projectId, input.installationId),
      });
    },
  });
}

export function useRevokeProjectModuleServiceConsent() {
  const queryClient = useQueryClient();
  return useMutation<void, Error, Omit<ProjectModuleServiceConsentMutationInput, 'operations'>>({
    mutationFn: (input) =>
      revokeProjectModuleServiceConsent(
        input.projectId,
        input.installationId,
        input.service,
        input.expectedInstallRevision,
      ),
    retry: false,
    onSuccess: (_result, input) => {
      void queryClient.invalidateQueries({
        queryKey: projectModuleKeys.serviceConsents(input.projectId, input.installationId),
      });
      void queryClient.invalidateQueries({
        queryKey: projectModuleKeys.serviceCapabilities(input.projectId, input.installationId),
      });
    },
  });
}

export interface ProjectModuleMutationInput {
  projectId: string;
  moduleId: string;
  releaseId: string;
  expectedInstallRevision: number;
  idempotencyKey: string;
}

export interface ProjectModuleInstallMutationInput {
  projectId: string;
  releaseId: string;
  idempotencyKey: string;
}

export function useProjectModuleMutation(
  action: Exclude<ProjectModuleInstallationAction, 'install'>,
) {
  const queryClient = useQueryClient();
  return useMutation<ProjectModuleInstallationTransition, Error, ProjectModuleMutationInput>({
    mutationFn: (input) =>
      action === 'update'
        ? updatePublishedProjectModule(
            input.projectId,
            input.moduleId,
            input.releaseId,
            input.expectedInstallRevision,
            input.idempotencyKey,
          )
        : rollbackPublishedProjectModule(
            input.projectId,
            input.moduleId,
            input.releaseId,
            input.expectedInstallRevision,
            input.idempotencyKey,
          ),
    retry: false,
    onSuccess: (_transition, input) => {
      void queryClient.invalidateQueries({
        queryKey: projectModuleKeys.installed(input.projectId),
      });
      void queryClient.invalidateQueries({
        queryKey: projectModuleKeys.history(input.projectId, input.moduleId),
      });
      void queryClient.invalidateQueries({
        queryKey: projectModuleKeys.serviceConsentsPrefix(input.projectId),
      });
      void queryClient.invalidateQueries({
        queryKey: [...projectModuleKeys.all, input.projectId, 'service-capabilities'],
      });
    },
  });
}

export function useInstallProjectModule() {
  const queryClient = useQueryClient();
  return useMutation<ProjectModuleInstallationTransition, Error, ProjectModuleInstallMutationInput>(
    {
      mutationFn: (input) =>
        installPublishedProjectModule(input.projectId, input.releaseId, input.idempotencyKey),
      retry: false,
      onSuccess: (_transition, input) => {
        void queryClient.invalidateQueries({
          queryKey: projectModuleKeys.installed(input.projectId),
        });
        void queryClient.invalidateQueries({
          queryKey: [...projectModuleKeys.all, input.projectId, 'history'],
        });
        void queryClient.invalidateQueries({
          queryKey: projectModuleKeys.serviceConsentsPrefix(input.projectId),
        });
        void queryClient.invalidateQueries({
          queryKey: [...projectModuleKeys.all, input.projectId, 'service-capabilities'],
        });
      },
    },
  );
}

export type ProjectModuleUiErrorCode =
  | 'PROJECT_MODULE_INSTALL_INPUT_INVALID'
  | 'PROJECT_MODULE_INSTALL_CONFLICT'
  | 'PROJECT_MODULE_ROLLBACK_TARGET_INVALID'
  | 'PROJECT_MODULE_NOT_FOUND'
  | 'DEVELOPER_MODULE_SIGNER_UNAVAILABLE'
  | 'DEVELOPER_MODULE_SIGNATURE_INVALID'
  | 'DEVELOPER_MODULE_NOT_DISTRIBUTABLE'
  | 'DEVELOPER_MODULE_NOT_PUBLISHED'
  | 'DEVELOPER_MODULE_REVOKED'
  | 'DEVELOPER_RELEASE_NOT_FOUND'
  | 'MODULE_SERVICE_CONSENT_REVOKED'
  | 'MODULE_SERVICE_INSTALLATION_STALE'
  | 'MODULE_SERVICE_RELEASE_REVOKED'
  | 'MODULE_SERVICE_CAPABILITY_EXPIRED'
  | 'PROJECT_MODULE_REQUEST_FAILED';

const PROJECT_MODULE_ERRORS = new Set<ProjectModuleUiErrorCode>([
  'PROJECT_MODULE_INSTALL_INPUT_INVALID',
  'PROJECT_MODULE_INSTALL_CONFLICT',
  'PROJECT_MODULE_ROLLBACK_TARGET_INVALID',
  'PROJECT_MODULE_NOT_FOUND',
  'DEVELOPER_MODULE_SIGNER_UNAVAILABLE',
  'DEVELOPER_MODULE_SIGNATURE_INVALID',
  'DEVELOPER_MODULE_NOT_DISTRIBUTABLE',
  'DEVELOPER_MODULE_NOT_PUBLISHED',
  'DEVELOPER_MODULE_REVOKED',
  'DEVELOPER_RELEASE_NOT_FOUND',
  'MODULE_SERVICE_CONSENT_REVOKED',
  'MODULE_SERVICE_INSTALLATION_STALE',
  'MODULE_SERVICE_RELEASE_REVOKED',
  'MODULE_SERVICE_CAPABILITY_EXPIRED',
]);

export function projectModuleErrorCode(error: unknown): ProjectModuleUiErrorCode {
  if (!error || typeof error !== 'object') return 'PROJECT_MODULE_REQUEST_FAILED';
  const record = error as {
    code?: unknown;
    body?: unknown;
    data?: unknown;
    details?: unknown;
  };
  const direct = record.code;
  if (typeof direct === 'string' && PROJECT_MODULE_ERRORS.has(direct as ProjectModuleUiErrorCode)) {
    return direct as ProjectModuleUiErrorCode;
  }
  for (const payload of [record.body, record.data, record.details]) {
    if (!payload || typeof payload !== 'object') continue;
    const nested = payload as { error?: unknown; code?: unknown };
    for (const candidate of [nested.error, nested.code]) {
      if (
        typeof candidate === 'string' &&
        PROJECT_MODULE_ERRORS.has(candidate as ProjectModuleUiErrorCode)
      ) {
        return candidate as ProjectModuleUiErrorCode;
      }
    }
  }
  return 'PROJECT_MODULE_REQUEST_FAILED';
}
