'use client';

import type {
  ProjectModuleInstallationAction,
  ProjectModuleInstallationTransition,
} from '@kortix/sdk';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  installPublishedProjectModule,
  listInstalledProjectModules,
  listPublishedProjectModuleReleases,
  rollbackPublishedProjectModule,
  updatePublishedProjectModule,
} from './client';

export const projectModuleKeys = {
  all: ['project-modules'] as const,
  installed: (projectId: string) => ['project-modules', projectId, 'installed'] as const,
  releases: () => ['project-modules', 'published-releases'] as const,
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

export function useProjectModules(projectId: string, enabled = true) {
  return useQuery({ ...projectModulesQuery(projectId), enabled: Boolean(projectId) && enabled });
}

export function useProjectModuleReleases(enabled = true) {
  return useQuery({ ...projectModuleReleasesQuery(), enabled });
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
]);

export function projectModuleErrorCode(error: unknown): ProjectModuleUiErrorCode {
  if (!error || typeof error !== 'object') return 'PROJECT_MODULE_REQUEST_FAILED';
  const record = error as { code?: unknown; body?: unknown };
  const direct = record.code;
  if (typeof direct === 'string' && PROJECT_MODULE_ERRORS.has(direct as ProjectModuleUiErrorCode)) {
    return direct as ProjectModuleUiErrorCode;
  }
  const body = record.body;
  const nested = body && typeof body === 'object' ? (body as { error?: unknown }).error : null;
  if (typeof nested === 'string' && PROJECT_MODULE_ERRORS.has(nested as ProjectModuleUiErrorCode)) {
    return nested as ProjectModuleUiErrorCode;
  }
  return 'PROJECT_MODULE_REQUEST_FAILED';
}
