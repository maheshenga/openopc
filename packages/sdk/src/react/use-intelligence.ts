'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type IntelligenceAgentCardResponse,
  type IntelligenceCapabilitiesResponse,
  type IntelligenceCapabilityDiscoveryResponse,
  type IntelligenceCreateTaskRequest,
  type IntelligenceTaskEventsResponse,
  type IntelligenceTaskResponse,
  createIntelligenceTask,
  discoverIntelligenceCapabilities,
  getIntelligenceAgentCard,
  getIntelligenceTaskEvents,
  listIntelligenceCapabilities,
} from '../core/rest/projects-client';

export const intelligenceCapabilitiesKey = (projectId: string | null | undefined) =>
  ['intelligence-capabilities', projectId] as const;

export const intelligenceCapabilityDiscoveryKey = (projectId: string | null | undefined) =>
  ['intelligence-capability-discovery', projectId] as const;

export const intelligenceAgentCardKey = (projectId: string | null | undefined) =>
  ['intelligence-agent-card', projectId] as const;

export const intelligenceTasksKey = (projectId: string | null | undefined) =>
  ['intelligence-tasks', projectId] as const;

export const intelligenceTaskEventsKey = (
  projectId: string | null | undefined,
  taskId: string | null | undefined,
  cursor?: string | null,
) => ['intelligence-task-events', projectId, taskId, cursor ?? null] as const;

export const intelligenceTaskEventsPrefix = (projectId: string | null | undefined) =>
  ['intelligence-task-events', projectId] as const;

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

/** Aggregate the stable project-level reads and task mutation for workbench UIs. */
export function useIntelligence(projectId: string | null | undefined) {
  return {
    capabilities: useIntelligenceCapabilities(projectId),
    discovery: useIntelligenceCapabilityDiscovery(projectId),
    agentCard: useIntelligenceAgentCard(projectId),
    createTask: useCreateIntelligenceTask(projectId),
  };
}
