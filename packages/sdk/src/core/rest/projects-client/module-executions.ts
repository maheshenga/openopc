import { backendApi } from '../../http/api-client';
import { unwrap } from './shared';

export type ProjectModuleExecutionState =
  | 'pending'
  | 'awaiting_confirmation'
  | 'dispatchable'
  | 'leased'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'unknown';

export interface ProjectModuleExecution {
  execution_id: string;
  account_id: string;
  project_id: string;
  installation_id: string;
  release_id: string;
  state: ProjectModuleExecutionState;
  kill_switch_generation: number;
  deadline_at: string;
  created_at: string;
  updated_at: string;
  terminal_at: string | null;
}

export interface ProjectModuleExecutionEstimate {
  account_id: string;
  project_id: string;
  installation_id: string;
  install_revision: number;
  release_id: string;
  release_digest: `sha256:${string}`;
  runtime_kind: 'wasi-component' | 'oci-image';
  runtime_profile: string;
  resource_ceilings: {
    cpu_millis: number;
    memory_mib: number;
    wall_time_ms: number;
    cost_micro: number;
  };
  confirmation_required: boolean;
}

export interface ProjectModuleExecutionEvent {
  event_id: string;
  execution_id: string;
  sequence: number;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface EstimateProjectModuleExecutionInput {
  installation_id: string;
}

export interface CreateProjectModuleExecutionInput {
  installation_id: string;
  deadline_at: string;
  input: unknown;
}

export interface CreateProjectModuleExecutionOptions {
  idempotencyKey: string;
}

export interface ProjectModuleExecutionEventsResponse {
  events: ProjectModuleExecutionEvent[];
}

export type ProjectModuleExecutionErrorCode =
  | 'MODULE_EXECUTION_INPUT_INVALID'
  | 'MODULE_EXECUTION_BINDING_UNAVAILABLE'
  | 'MODULE_EXECUTION_BINDING_STALE'
  | 'MODULE_EXECUTION_NOT_FOUND'
  | 'MODULE_EXECUTION_STATE_CONFLICT';

export interface ProjectModuleExecutionErrorResponse {
  error: ProjectModuleExecutionErrorCode;
}

function collectionPath(projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/module-executions`;
}

function executionPath(projectId: string, executionId: string): string {
  return `${collectionPath(projectId)}/${encodeURIComponent(executionId)}`;
}

export async function estimateProjectModuleExecution(
  projectId: string,
  input: EstimateProjectModuleExecutionInput,
): Promise<ProjectModuleExecutionEstimate> {
  return unwrap(
    await backendApi.post<ProjectModuleExecutionEstimate>(
      `${collectionPath(projectId)}/estimate`,
      input,
    ),
    'Failed to estimate project module execution',
  );
}

export async function createProjectModuleExecution(
  projectId: string,
  input: CreateProjectModuleExecutionInput,
  options: CreateProjectModuleExecutionOptions,
): Promise<ProjectModuleExecution> {
  return unwrap(
    await backendApi.post<ProjectModuleExecution>(collectionPath(projectId), input, {
      headers: { 'Idempotency-Key': options.idempotencyKey },
    }),
    'Failed to create project module execution',
  );
}

export async function confirmProjectModuleExecution(
  projectId: string,
  executionId: string,
): Promise<ProjectModuleExecution> {
  return unwrap(
    await backendApi.post<ProjectModuleExecution>(
      `${executionPath(projectId, executionId)}/confirm`,
    ),
    'Failed to confirm project module execution',
  );
}

export async function cancelProjectModuleExecution(
  projectId: string,
  executionId: string,
): Promise<ProjectModuleExecution> {
  return unwrap(
    await backendApi.post<ProjectModuleExecution>(
      `${executionPath(projectId, executionId)}/cancel`,
    ),
    'Failed to cancel project module execution',
  );
}

export async function getProjectModuleExecution(
  projectId: string,
  executionId: string,
): Promise<ProjectModuleExecution> {
  return unwrap(
    await backendApi.get<ProjectModuleExecution>(executionPath(projectId, executionId)),
    'Failed to get project module execution',
  );
}

export async function listProjectModuleExecutionEvents(
  projectId: string,
  executionId: string,
): Promise<ProjectModuleExecutionEventsResponse> {
  return unwrap(
    await backendApi.get<ProjectModuleExecutionEventsResponse>(
      `${executionPath(projectId, executionId)}/events`,
    ),
    'Failed to list project module execution events',
  );
}
