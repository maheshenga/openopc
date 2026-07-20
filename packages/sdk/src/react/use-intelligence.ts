'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type IntelligenceAgentCardResponse,
  type IntelligenceAssetDownload,
  type IntelligenceCapabilitiesResponse,
  type IntelligenceCapabilityDiscoveryResponse,
  type IntelligenceCreateTaskRequest,
  type IntelligenceCreateUploadRequest,
  type IntelligenceImageEstimate,
  type IntelligenceImageEstimateRequest,
  type IntelligenceStudioAsset,
  type IntelligenceStudioAssetList,
  type IntelligenceStudioJob,
  type IntelligenceStudioJobList,
  type IntelligenceStudioUpload,
  type IntelligenceTaskEventsResponse,
  type IntelligenceTaskLookupResponse,
  type IntelligenceTaskResponse,
  type IntelligenceWorkflowApprovalDecisionRequest,
  type IntelligenceWorkflowApprovalDecisionResponse,
  type IntelligenceWorkflowCancelRequest,
  type IntelligenceWorkflowEventsResponse,
  type IntelligenceWorkflowRunResponse,
  type IntelligenceWorkflowStartRequest,
  type IntelligenceWorkflowStartResponse,
  cancelIntelligenceJob,
  cancelIntelligenceWorkflow,
  createIntelligenceAssetDownloadUrl,
  createIntelligenceTask,
  createIntelligenceUpload,
  decideIntelligenceWorkflowApproval,
  discoverIntelligenceCapabilities,
  estimateIntelligenceImage,
  finalizeIntelligenceUpload,
  getIntelligenceAgentCard,
  getIntelligenceTaskByJob,
  getIntelligenceTaskEvents,
  getIntelligenceWorkflow,
  getIntelligenceWorkflowEvents,
  listIntelligenceAssets,
  listIntelligenceCapabilities,
  listIntelligenceJobs,
  startIntelligenceWorkflow,
} from '../core/rest/projects-client';

export const intelligenceCapabilitiesKey = (projectId: string | null | undefined) =>
  ['intelligence-capabilities', projectId] as const;

export const intelligenceCapabilityDiscoveryKey = (projectId: string | null | undefined) =>
  ['intelligence-capability-discovery', projectId] as const;

export const intelligenceAgentCardKey = (projectId: string | null | undefined) =>
  ['intelligence-agent-card', projectId] as const;

export const intelligenceTasksKey = (projectId: string | null | undefined) =>
  ['intelligence-tasks', projectId] as const;

export const intelligenceJobsKey = (projectId: string | null | undefined, cursor?: string | null) =>
  ['intelligence-jobs', projectId, cursor ?? null] as const;

export const intelligenceJobsPrefix = (projectId: string | null | undefined) =>
  ['intelligence-jobs', projectId] as const;

export const intelligenceAssetsKey = (
  projectId: string | null | undefined,
  cursor?: string | null,
) => ['intelligence-assets', projectId, cursor ?? null] as const;

export const intelligenceAssetsPrefix = (projectId: string | null | undefined) =>
  ['intelligence-assets', projectId] as const;

export const intelligenceTaskEventsKey = (
  projectId: string | null | undefined,
  taskId: string | null | undefined,
  cursor?: string | null,
) => ['intelligence-task-events', projectId, taskId, cursor ?? null] as const;

export const intelligenceTaskByJobKey = (
  projectId: string | null | undefined,
  jobId: string | null | undefined,
) => ['intelligence-task-by-job', projectId, jobId] as const;

export const intelligenceTaskEventsPrefix = (projectId: string | null | undefined) =>
  ['intelligence-task-events', projectId] as const;

export const intelligenceWorkflowsKey = (projectId: string | null | undefined) =>
  ['intelligence-workflows', projectId] as const;

export const intelligenceWorkflowKey = (
  projectId: string | null | undefined,
  runId: string | null | undefined,
) => [...intelligenceWorkflowsKey(projectId), runId] as const;

export const intelligenceWorkflowEventsKey = (
  projectId: string | null | undefined,
  runId: string | null | undefined,
  cursor?: string | null,
) => ['intelligence-workflow-events', projectId, runId, cursor ?? null] as const;

export const intelligenceWorkflowEventsPrefix = (
  projectId: string | null | undefined,
  runId?: string | null,
) =>
  runId == null
    ? (['intelligence-workflow-events', projectId] as const)
    : (['intelligence-workflow-events', projectId, runId] as const);

export interface IntelligenceQueryOptions {
  enabled?: boolean;
  /** Disable polling when a caller wants a one-shot cursor read. */
  pollingEnabled?: boolean;
  /** Poll interval in milliseconds; omitted means no polling. */
  refetchInterval?: number;
}

export function useIntelligenceCapabilities(
  projectId: string | null | undefined,
  options: IntelligenceQueryOptions = {},
) {
  const queryKey = intelligenceCapabilitiesKey(projectId);
  return useQuery<IntelligenceCapabilitiesResponse>({
    queryKey,
    queryFn: () => listIntelligenceCapabilities(projectId as string),
    enabled: !!projectId && (options.enabled ?? true),
    ...(options.pollingEnabled === false
      ? { refetchInterval: false }
      : options.refetchInterval !== undefined
        ? { refetchInterval: options.refetchInterval }
        : {}),
  });
}

/** Load the project-gated provider/model targets needed to create a task. */
export function useIntelligenceCapabilityDiscovery(
  projectId: string | null | undefined,
  options: IntelligenceQueryOptions = {},
) {
  const queryKey = intelligenceCapabilityDiscoveryKey(projectId);
  return useQuery<IntelligenceCapabilityDiscoveryResponse>({
    queryKey,
    queryFn: () => discoverIntelligenceCapabilities(projectId as string),
    enabled: !!projectId && (options.enabled ?? true),
    ...(options.pollingEnabled === false
      ? { refetchInterval: false }
      : options.refetchInterval !== undefined
        ? { refetchInterval: options.refetchInterval }
        : {}),
  });
}

export function useIntelligenceAgentCard(
  projectId: string | null | undefined,
  options: IntelligenceQueryOptions = {},
) {
  const queryKey = intelligenceAgentCardKey(projectId);
  return useQuery<IntelligenceAgentCardResponse>({
    queryKey,
    queryFn: () => getIntelligenceAgentCard(projectId as string),
    enabled: !!projectId && (options.enabled ?? true),
    ...(options.pollingEnabled === false
      ? { refetchInterval: false }
      : options.refetchInterval !== undefined
        ? { refetchInterval: options.refetchInterval }
        : {}),
  });
}

export function useIntelligenceTaskEvents(
  projectId: string | null | undefined,
  taskId: string | null | undefined,
  cursor?: string | null,
  options: IntelligenceQueryOptions = {},
) {
  const queryKey = intelligenceTaskEventsKey(projectId, taskId, cursor);
  return useQuery<IntelligenceTaskEventsResponse>({
    queryKey,
    queryFn: () => getIntelligenceTaskEvents(projectId as string, taskId as string, cursor),
    enabled: !!projectId && !!taskId && (options.enabled ?? true),
    ...(options.pollingEnabled === false
      ? { refetchInterval: false }
      : options.refetchInterval !== undefined
        ? { refetchInterval: options.refetchInterval }
        : {}),
  });
}

export function useIntelligenceTaskByJob(
  projectId: string | null | undefined,
  jobId: string | null | undefined,
  options: IntelligenceQueryOptions = {},
) {
  const queryKey = intelligenceTaskByJobKey(projectId, jobId);
  return useQuery<IntelligenceTaskLookupResponse>({
    queryKey,
    queryFn: () => getIntelligenceTaskByJob(projectId as string, jobId as string),
    enabled: !!projectId && !!jobId && (options.enabled ?? true),
  });
}

export function useIntelligenceJobs(
  projectId: string | null | undefined,
  cursor?: string | null,
  options: IntelligenceQueryOptions = {},
) {
  return useQuery<IntelligenceStudioJobList>({
    queryKey: intelligenceJobsKey(projectId, cursor),
    queryFn: () => listIntelligenceJobs(projectId as string, cursor),
    enabled: !!projectId && (options.enabled ?? true),
    ...(options.pollingEnabled === false
      ? { refetchInterval: false }
      : options.refetchInterval !== undefined
        ? { refetchInterval: options.refetchInterval }
        : {}),
  });
}

export function useIntelligenceAssets(
  projectId: string | null | undefined,
  cursor?: string | null,
  options: IntelligenceQueryOptions = {},
) {
  return useQuery<IntelligenceStudioAssetList>({
    queryKey: intelligenceAssetsKey(projectId, cursor),
    queryFn: () => listIntelligenceAssets(projectId as string, cursor),
    enabled: !!projectId && (options.enabled ?? true),
    ...(options.pollingEnabled === false
      ? { refetchInterval: false }
      : options.refetchInterval !== undefined
        ? { refetchInterval: options.refetchInterval }
        : {}),
  });
}

export function useIntelligenceWorkflow(
  projectId: string | null | undefined,
  runId: string | null | undefined,
  options: IntelligenceQueryOptions = {},
) {
  return useQuery<IntelligenceWorkflowRunResponse>({
    queryKey: intelligenceWorkflowKey(projectId, runId),
    queryFn: () => getIntelligenceWorkflow(projectId as string, runId as string),
    enabled: !!projectId && !!runId && (options.enabled ?? true),
    ...(options.pollingEnabled === false
      ? { refetchInterval: false }
      : options.refetchInterval !== undefined
        ? { refetchInterval: options.refetchInterval }
        : {}),
  });
}

export function useIntelligenceWorkflowEvents(
  projectId: string | null | undefined,
  runId: string | null | undefined,
  cursor?: string | null,
  options: IntelligenceQueryOptions & { limit?: number } = {},
) {
  return useQuery<IntelligenceWorkflowEventsResponse>({
    queryKey: intelligenceWorkflowEventsKey(projectId, runId, cursor),
    queryFn: () =>
      getIntelligenceWorkflowEvents(projectId as string, runId as string, cursor, options.limit),
    enabled: !!projectId && !!runId && (options.enabled ?? true),
    ...(options.pollingEnabled === false
      ? { refetchInterval: false }
      : options.refetchInterval !== undefined
        ? { refetchInterval: options.refetchInterval }
        : {}),
  });
}

export function useCreateIntelligenceTask(projectId: string | null | undefined) {
  const queryClient = useQueryClient();
  return useMutation<IntelligenceTaskResponse, Error, IntelligenceCreateTaskRequest>({
    mutationKey: intelligenceTasksKey(projectId),
    mutationFn: (input) => createIntelligenceTask(projectId as string, input),
    onSuccess: () => {
      // Keep invalidation project-scoped and limited to Intelligence data. In
      // particular, task creation must not refetch or reset session/runtime
      // caches owned by the existing Kortix chat surface.
      void queryClient.invalidateQueries({ queryKey: intelligenceCapabilitiesKey(projectId) });
      void queryClient.invalidateQueries({
        queryKey: intelligenceCapabilityDiscoveryKey(projectId),
      });
      void queryClient.invalidateQueries({ queryKey: intelligenceTasksKey(projectId) });
      void queryClient.invalidateQueries({ queryKey: intelligenceTaskEventsPrefix(projectId) });
    },
  });
}

export function useEstimateIntelligenceImage(projectId: string | null | undefined) {
  return useMutation<IntelligenceImageEstimate, Error, IntelligenceImageEstimateRequest>({
    mutationKey: ['intelligence-image-estimate', projectId],
    mutationFn: (input) => estimateIntelligenceImage(projectId as string, input),
  });
}

export function useCancelIntelligenceJob(projectId: string | null | undefined) {
  const queryClient = useQueryClient();
  return useMutation<IntelligenceStudioJob, Error, string>({
    mutationKey: [...intelligenceJobsPrefix(projectId), 'cancel'],
    mutationFn: (jobId) => cancelIntelligenceJob(projectId as string, jobId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: intelligenceJobsPrefix(projectId) });
      void queryClient.invalidateQueries({ queryKey: intelligenceTaskEventsPrefix(projectId) });
    },
  });
}

export function useCreateIntelligenceUpload(projectId: string | null | undefined) {
  return useMutation<IntelligenceStudioUpload, Error, IntelligenceCreateUploadRequest>({
    mutationKey: ['intelligence-uploads', projectId, 'create'],
    mutationFn: (input) => createIntelligenceUpload(projectId as string, input),
  });
}

export function useFinalizeIntelligenceUpload(projectId: string | null | undefined) {
  const queryClient = useQueryClient();
  return useMutation<IntelligenceStudioAsset, Error, string>({
    mutationKey: ['intelligence-uploads', projectId, 'finalize'],
    mutationFn: (uploadId) => finalizeIntelligenceUpload(projectId as string, uploadId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: intelligenceAssetsPrefix(projectId) });
    },
  });
}

export function useIntelligenceAssetDownload(projectId: string | null | undefined) {
  return useMutation<IntelligenceAssetDownload, Error, string>({
    mutationKey: ['intelligence-assets', projectId, 'download'],
    mutationFn: (assetId) => createIntelligenceAssetDownloadUrl(projectId as string, assetId),
  });
}

export function useStartIntelligenceWorkflow(projectId: string | null | undefined) {
  const queryClient = useQueryClient();
  return useMutation<IntelligenceWorkflowStartResponse, Error, IntelligenceWorkflowStartRequest>({
    mutationKey: intelligenceWorkflowsKey(projectId),
    mutationFn: (input) => startIntelligenceWorkflow(projectId as string, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: intelligenceWorkflowsKey(projectId) });
      void queryClient.invalidateQueries({
        queryKey: intelligenceWorkflowEventsPrefix(projectId),
      });
    },
  });
}

export function useCancelIntelligenceWorkflow(
  projectId: string | null | undefined,
  runId: string | null | undefined,
) {
  const queryClient = useQueryClient();
  return useMutation<IntelligenceWorkflowRunResponse, Error, IntelligenceWorkflowCancelRequest>({
    mutationKey: [...intelligenceWorkflowKey(projectId, runId), 'cancel'],
    mutationFn: (input) => cancelIntelligenceWorkflow(projectId as string, runId as string, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: intelligenceWorkflowKey(projectId, runId) });
      void queryClient.invalidateQueries({
        queryKey: intelligenceWorkflowEventsPrefix(projectId, runId),
      });
    },
  });
}

export function useDecideIntelligenceWorkflowApproval(
  projectId: string | null | undefined,
  runId: string | null | undefined,
  approvalId: string | null | undefined,
) {
  const queryClient = useQueryClient();
  return useMutation<
    IntelligenceWorkflowApprovalDecisionResponse,
    Error,
    IntelligenceWorkflowApprovalDecisionRequest
  >({
    mutationKey: [...intelligenceWorkflowKey(projectId, runId), 'approval', approvalId],
    mutationFn: (input) =>
      decideIntelligenceWorkflowApproval(
        projectId as string,
        runId as string,
        approvalId as string,
        input,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: intelligenceWorkflowKey(projectId, runId) });
      void queryClient.invalidateQueries({
        queryKey: intelligenceWorkflowEventsPrefix(projectId, runId),
      });
    },
  });
}

/** Aggregate the stable project-level reads and task mutation for workbench UIs. */
export function useIntelligence(projectId: string | null | undefined) {
  return {
    capabilities: useIntelligenceCapabilities(projectId),
    discovery: useIntelligenceCapabilityDiscovery(projectId),
    agentCard: useIntelligenceAgentCard(projectId),
    createTask: useCreateIntelligenceTask(projectId),
    startWorkflow: useStartIntelligenceWorkflow(projectId),
  };
}
