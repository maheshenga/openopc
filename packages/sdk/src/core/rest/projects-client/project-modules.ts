import { backendApi } from '../../http/api-client';
import { unwrap } from './shared';

export type ProjectModuleInstallationStatus = 'active' | 'blocked';
export type ProjectModuleInstallationAction = 'install' | 'update' | 'rollback';

export interface ProjectModuleInstallation {
  installation_id: string;
  project_id: string;
  account_id: string;
  module_id: string;
  active_release_id: string;
  active_version: string;
  install_revision: number;
  status: ProjectModuleInstallationStatus;
  installed_by: string;
  created_at: string;
  updated_at: string;
}

export interface ProjectModuleInstallationEvent {
  installation_event_id: string;
  installation_id: string;
  project_id: string;
  account_id: string;
  sequence: number;
  action: ProjectModuleInstallationAction;
  from_release_id: string | null;
  to_release_id: string;
  expected_revision: number;
  resulting_revision: number;
  idempotency_key: string | null;
  actor_user_id: string;
  created_at: string;
}

export interface ProjectModuleInstallationTransition {
  installation: ProjectModuleInstallation;
  event: ProjectModuleInstallationEvent;
}

export interface ProjectModuleListResponse {
  modules: ProjectModuleInstallation[];
}

export interface ProjectModuleHistoryResponse {
  history: ProjectModuleInstallationEvent[];
}

export interface ProjectModuleInstallInput {
  release_id: string;
  expected_install_revision: 0;
}

export interface ProjectModuleMoveInput {
  release_id: string;
  expected_install_revision: number;
}

export interface ProjectModuleMutationOptions {
  idempotencyKey?: string;
}

export type ProjectModuleErrorCode =
  | 'PROJECT_MODULE_INSTALL_INPUT_INVALID'
  | 'PROJECT_MODULE_INSTALL_CONFLICT'
  | 'PROJECT_MODULE_ROLLBACK_TARGET_INVALID'
  | 'PROJECT_MODULE_NOT_FOUND'
  | 'DEVELOPER_MODULE_SIGNER_UNAVAILABLE'
  | 'DEVELOPER_MODULE_SIGNATURE_INVALID'
  | 'DEVELOPER_MODULE_NOT_DISTRIBUTABLE'
  | 'DEVELOPER_MODULE_NOT_PUBLISHED'
  | 'DEVELOPER_MODULE_REVOKED'
  | 'DEVELOPER_RELEASE_NOT_FOUND';

export interface ProjectModuleErrorResponse {
  error: ProjectModuleErrorCode;
}

function projectPath(projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/modules`;
}

function mutationOptions(options?: ProjectModuleMutationOptions): RequestInit | undefined {
  return options?.idempotencyKey
    ? { headers: { 'Idempotency-Key': options.idempotencyKey } }
    : undefined;
}

/** List modules installed in a project. */
export async function listProjectModules(projectId: string): Promise<ProjectModuleListResponse> {
  return unwrap(
    await backendApi.get<ProjectModuleListResponse>(projectPath(projectId)),
    'Failed to list project modules',
  );
}

/** List immutable installation history for one exact project module. */
export async function listProjectModuleInstallationHistory(
  projectId: string,
  moduleId: string,
): Promise<ProjectModuleHistoryResponse> {
  return unwrap(
    await backendApi.get<ProjectModuleHistoryResponse>(
      `${projectPath(projectId)}/${encodeURIComponent(moduleId)}/history`,
    ),
    'Failed to list project module history',
  );
}

/** Install one exact published release into a project. */
export async function installProjectModule(
  projectId: string,
  input: ProjectModuleInstallInput,
  options?: ProjectModuleMutationOptions,
): Promise<ProjectModuleInstallationTransition> {
  return unwrap(
    await backendApi.post<ProjectModuleInstallationTransition>(
      `${projectPath(projectId)}/install`,
      input,
      mutationOptions(options),
    ),
    'Failed to install project module',
  );
}

/** Move a project module to one exact published release. */
export async function updateProjectModule(
  projectId: string,
  moduleId: string,
  input: ProjectModuleMoveInput,
  options?: ProjectModuleMutationOptions,
): Promise<ProjectModuleInstallationTransition> {
  return unwrap(
    await backendApi.post<ProjectModuleInstallationTransition>(
      `${projectPath(projectId)}/${encodeURIComponent(moduleId)}/update`,
      input,
      mutationOptions(options),
    ),
    'Failed to update project module',
  );
}

/** Roll a project module back to one exact historical published release. */
export async function rollbackProjectModule(
  projectId: string,
  moduleId: string,
  input: ProjectModuleMoveInput,
  options?: ProjectModuleMutationOptions,
): Promise<ProjectModuleInstallationTransition> {
  return unwrap(
    await backendApi.post<ProjectModuleInstallationTransition>(
      `${projectPath(projectId)}/${encodeURIComponent(moduleId)}/rollback`,
      input,
      mutationOptions(options),
    ),
    'Failed to rollback project module',
  );
}
