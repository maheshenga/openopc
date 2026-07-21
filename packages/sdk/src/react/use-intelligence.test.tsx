import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as React from 'react';
import { configureKortix } from '../core/http/config';

let invalidated: unknown[][] = [];
let queryConfigs: Array<Record<string, unknown>> = [];
let stateValues: unknown[] = [];
let stateIndex = 0;
let effectDependencies: Array<readonly unknown[] | undefined> = [];
let effectCleanups: Array<(() => void) | undefined> = [];
let effectIndex = 0;
let refValues: unknown[] = [];
let refIndex = 0;
const originalFetch = globalThis.fetch;

function sameDependencies(
  left: readonly unknown[] | undefined,
  right: readonly unknown[] | undefined,
): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.length === right.length &&
    left.every((value, index) => Object.is(value, right[index]))
  );
}
mock.module('@tanstack/react-query', () => ({
  useQuery: (config: Record<string, unknown>) => {
    queryConfigs.push(config);
    return config;
  },
  useMutation: (config: Record<string, unknown>) => config,
  useQueryClient: () => ({
    invalidateQueries: (options: { queryKey: unknown[] }) => {
      invalidated.push(options.queryKey);
    },
  }),
  keepPreviousData: Symbol('keepPreviousData'),
}));
mock.module('react', () => ({
  ...React,
  useEffect: (effect: () => undefined | (() => void), dependencies?: readonly unknown[]) => {
    const index = effectIndex;
    effectIndex += 1;
    if (sameDependencies(effectDependencies[index], dependencies)) return;
    effectCleanups[index]?.();
    effectDependencies[index] = dependencies;
    effectCleanups[index] = effect() ?? undefined;
  },
  useRef: <T,>(initial: T) => {
    const index = refIndex;
    refIndex += 1;
    if (refValues[index] === undefined) refValues[index] = { current: initial };
    return refValues[index] as { current: T };
  },
  useState: <T,>(initial: T) => {
    const index = stateIndex;
    stateIndex += 1;
    if (stateValues[index] === undefined) stateValues[index] = initial;
    return [
      stateValues[index] as T,
      (value: T) => {
        stateValues[index] = value;
      },
    ] as const;
  },
}));
const {
  intelligenceAgentCardKey,
  intelligenceCapabilityDiscoveryKey,
  intelligenceCatalogKey,
  intelligenceCapabilitiesKey,
  intelligenceAssetsKey,
  intelligenceAssetsPrefix,
  intelligenceJobsKey,
  intelligenceJobsPrefix,
  intelligenceTaskEventsKey,
  intelligenceTaskByJobKey,
  intelligenceWorkflowEventsKey,
  intelligenceWorkflowKey,
  intelligenceWorkflowsKey,
  useCancelIntelligenceWorkflow,
  useCancelIntelligenceJob,
  useCreateIntelligenceUpload,
  useCreateIntelligenceTask,
  useDecideIntelligenceWorkflowApproval,
  useIntelligence,
  useIntelligenceAgentCard,
  useIntelligenceAgUiWorkflow,
  useIntelligenceCapabilityDiscovery,
  useIntelligenceCatalog,
  useIntelligenceCapabilities,
  useIntelligenceAssets,
  useEstimateIntelligenceImage,
  useFinalizeIntelligenceUpload,
  useIntelligenceAssetDownload,
  useIntelligenceJobs,
  useIntelligenceTaskEvents,
  useIntelligenceTaskByJob,
  useIntelligenceWorkflow,
  useIntelligenceWorkflowEvents,
  useStartIntelligenceWorkflow,
} = await import('./use-intelligence');

type MockQueryConfig = {
  queryKey?: readonly unknown[];
  enabled?: boolean;
  mutationFn?: (...args: never[]) => unknown;
  onSuccess?: (...args: never[]) => unknown;
};

const asMockQueryConfig = (value: unknown) => value as MockQueryConfig;

beforeEach(() => {
  invalidated = [];
  queryConfigs = [];
  stateValues = [];
  stateIndex = 0;
  effectDependencies = [];
  effectCleanups = [];
  effectIndex = 0;
  refValues = [];
  refIndex = 0;
});

afterEach(() => {
  for (const cleanup of effectCleanups) cleanup?.();
  globalThis.fetch = originalFetch;
});

describe('Intelligence React Query bindings', () => {
  test('exports Image Studio hooks and keys through the existing React barrel', async () => {
    const barrel = await import('./index');
    expect(typeof barrel.intelligenceJobsKey).toBe('function');
    expect(typeof barrel.intelligenceAssetsKey).toBe('function');
    expect(typeof barrel.useIntelligenceJobs).toBe('function');
    expect(typeof barrel.useIntelligenceAssets).toBe('function');
    expect(typeof barrel.useEstimateIntelligenceImage).toBe('function');
    expect(typeof barrel.useCancelIntelligenceJob).toBe('function');
    expect(typeof barrel.useCreateIntelligenceUpload).toBe('function');
    expect(typeof barrel.useFinalizeIntelligenceUpload).toBe('function');
    expect(typeof barrel.useIntelligenceAssetDownload).toBe('function');
    expect(typeof barrel.intelligenceTaskByJobKey).toBe('function');
    expect(typeof barrel.useIntelligenceCatalog).toBe('function');
    expect(typeof barrel.useIntelligenceAgUiWorkflow).toBe('function');
    expect(typeof barrel.useIntelligenceTaskByJob).toBe('function');
  });

  test('partitions Studio jobs and assets by project and cursor', () => {
    expect(asMockQueryConfig(useIntelligenceJobs('project-1', 'jobs-1')).queryKey).toEqual([
      ...intelligenceJobsKey('project-1', 'jobs-1'),
    ]);
    expect(asMockQueryConfig(useIntelligenceAssets('project-1', 'assets-1')).queryKey).toEqual([
      ...intelligenceAssetsKey('project-1', 'assets-1'),
    ]);
    expect(asMockQueryConfig(useIntelligenceJobs(null)).enabled).toBe(false);
    expect(asMockQueryConfig(useIntelligenceAssets(undefined)).enabled).toBe(false);
  });

  test('partitions capability, Agent Card, and event queries by project/task', () => {
    expect(asMockQueryConfig(useIntelligenceCapabilities('project-1')).queryKey).toEqual([
      ...intelligenceCapabilitiesKey('project-1'),
    ]);
    expect(asMockQueryConfig(useIntelligenceCapabilityDiscovery('project-1')).queryKey).toEqual([
      ...intelligenceCapabilityDiscoveryKey('project-1'),
    ]);
    const catalogQuery = asMockQueryConfig(
      useIntelligenceCatalog('project-1', 'image', { cursor: 2, enabled: false }),
    );
    expect(catalogQuery.queryKey).toEqual(intelligenceCatalogKey('project-1', 'image', 2));
    expect(catalogQuery.enabled).toBe(false);
    expect(asMockQueryConfig(useIntelligenceAgentCard('project-1')).queryKey).toEqual([
      ...intelligenceAgentCardKey('project-1'),
    ]);
    expect(
      asMockQueryConfig(useIntelligenceTaskEvents('project-1', 'task-1', 'cursor-1')).queryKey,
    ).toEqual(intelligenceTaskEventsKey('project-1', 'task-1', 'cursor-1'));
    expect(asMockQueryConfig(useIntelligenceTaskByJob('project-1', 'job-1')).queryKey).toEqual(
      intelligenceTaskByJobKey('project-1', 'job-1'),
    );
    expect(asMockQueryConfig(useIntelligenceCapabilities(null)).enabled).toBe(false);
    expect(asMockQueryConfig(useIntelligenceCatalog(null, '')).enabled).toBe(false);
    expect(asMockQueryConfig(useIntelligenceTaskEvents('project-1', '')).enabled).toBe(false);
    expect(asMockQueryConfig(useIntelligenceTaskByJob('project-1', null)).enabled).toBe(false);
    expect(asMockQueryConfig(useIntelligenceWorkflow('project-1', 'run-1')).queryKey).toEqual([
      ...intelligenceWorkflowKey('project-1', 'run-1'),
    ]);
    expect(
      asMockQueryConfig(useIntelligenceWorkflowEvents('project-1', 'run-1', 'cursor-1')).queryKey,
    ).toEqual(intelligenceWorkflowEventsKey('project-1', 'run-1', 'cursor-1'));
    expect(asMockQueryConfig(useIntelligenceWorkflowEvents('project-1', '')).enabled).toBe(false);
  });

  test('task creation invalidates only intelligence queries for the same project', () => {
    const mutation = asMockQueryConfig(useCreateIntelligenceTask('project-1'));
    mutation.onSuccess?.();

    expect(invalidated).toContainEqual([...intelligenceCapabilitiesKey('project-1')]);
    expect(invalidated).toContainEqual([...intelligenceCapabilityDiscoveryKey('project-1')]);
    expect(invalidated).not.toContainEqual([...intelligenceAgentCardKey('project-1')]);
    expect(invalidated).toContainEqual(['intelligence-tasks', 'project-1']);
    expect(invalidated).toContainEqual(['intelligence-task-events', 'project-1']);
    expect(invalidated.some((key) => key[0] === 'session' || key[0] === 'opencode')).toBe(false);
  });

  test('Studio mutations invalidate only durable project data and never cache download URLs', () => {
    const cancellation = asMockQueryConfig(useCancelIntelligenceJob('project-1'));
    cancellation.onSuccess?.();
    expect(invalidated).toContainEqual([...intelligenceJobsPrefix('project-1')]);
    expect(invalidated).toContainEqual(['intelligence-task-events', 'project-1']);

    invalidated = [];
    const finalized = asMockQueryConfig(useFinalizeIntelligenceUpload('project-1'));
    finalized.onSuccess?.();
    expect(invalidated).toContainEqual([...intelligenceAssetsPrefix('project-1')]);
    expect(invalidated).not.toContainEqual(['project-sessions', 'project-1']);

    invalidated = [];
    expect(asMockQueryConfig(useEstimateIntelligenceImage('project-1')).mutationFn).toBeFunction();
    expect(asMockQueryConfig(useCreateIntelligenceUpload('project-1')).mutationFn).toBeFunction();
    const download = asMockQueryConfig(useIntelligenceAssetDownload('project-1'));
    expect(download.mutationFn).toBeFunction();
    download.onSuccess?.();
    expect(invalidated).toEqual([]);
  });

  test('aggregate hook exposes the three project intelligence surfaces', () => {
    const result = useIntelligence('project-1') as unknown as {
      capabilities: MockQueryConfig;
      discovery: MockQueryConfig;
      agentCard: MockQueryConfig;
      createTask: MockQueryConfig;
      startWorkflow: MockQueryConfig;
    };
    expect(result.capabilities.queryKey).toEqual([...intelligenceCapabilitiesKey('project-1')]);
    expect(result.discovery.queryKey).toEqual([...intelligenceCapabilityDiscoveryKey('project-1')]);
    expect(result.agentCard.queryKey).toEqual([...intelligenceAgentCardKey('project-1')]);
    expect(result.createTask.mutationFn).toBeFunction();
    expect(result.startWorkflow.mutationFn).toBeFunction();
  });

  test('workflow mutations invalidate only the same project workflow queries', () => {
    const startMutation = asMockQueryConfig(useStartIntelligenceWorkflow('project-1'));
    startMutation.onSuccess?.();
    expect(invalidated).toContainEqual([...intelligenceWorkflowsKey('project-1')]);

    invalidated = [];
    const cancelMutation = asMockQueryConfig(useCancelIntelligenceWorkflow('project-1', 'run-1'));
    cancelMutation.onSuccess?.();
    expect(invalidated).toContainEqual([...intelligenceWorkflowKey('project-1', 'run-1')]);
    expect(invalidated).toContainEqual(['intelligence-workflow-events', 'project-1', 'run-1']);

    invalidated = [];
    const approvalMutation = asMockQueryConfig(
      useDecideIntelligenceWorkflowApproval('project-1', 'run-1', 'approval-1'),
    );
    approvalMutation.onSuccess?.();
    expect(invalidated).toContainEqual([...intelligenceWorkflowKey('project-1', 'run-1')]);
    expect(invalidated.some((key) => key.includes('project-2'))).toBe(false);
    expect(invalidated.some((key) => key[0] === 'session' || key[0] === 'opencode')).toBe(false);
  });

  test('falls back to project-scoped workflow polling when the AG-UI stream is unavailable', async () => {
    const requests: Array<{ url: string; headers: Headers }> = [];
    configureKortix({
      backendUrl: 'https://api.example.test/v1',
      getToken: async () => 'test-token',
    });
    globalThis.fetch = (async (input, init) => {
      requests.push({ url: String(input), headers: new Headers(init?.headers) });
      return new Response(JSON.stringify({ code: 'INTELLIGENCE_AG_UI_DISABLED' }), { status: 404 });
    }) as typeof fetch;
    let fallbackCount = 0;
    const first = useIntelligenceAgUiWorkflow('project-1', 'run-1', {
      cursor: 7,
      onFallback: () => {
        fallbackCount += 1;
      },
    });
    const firstFallback = first.fallback as unknown as Record<string, unknown>;

    expect(first.mode).toBe('stream');
    expect(firstFallback.enabled).toBe(false);
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers.get('Last-Event-ID')).toBe('7');
    expect(fallbackCount).toBe(1);

    stateIndex = 0;
    queryConfigs = [];
    const fallback = useIntelligenceAgUiWorkflow('project-1', 'run-1', {
      cursor: 7,
      onFallback: () => {
        fallbackCount += 1;
      },
    });
    const fallbackQuery = fallback.fallback as unknown as Record<string, unknown>;

    expect(fallback.mode).toBe('polling');
    expect(fallbackQuery.enabled).toBe(true);
    expect(fallbackQuery.refetchInterval).toBe(500);
    expect(queryConfigs[0]?.queryKey).toEqual([
      'intelligence-workflow-events',
      'project-1',
      'run-1',
      '7',
    ]);
  });

  test('does not reconnect when inline stream callbacks change on rerender', async () => {
    const requests: string[] = [];
    configureKortix({
      backendUrl: 'https://api.example.test/v1',
      getToken: async () => 'test-token',
    });
    globalThis.fetch = (async (input) => {
      requests.push(String(input));
      return new Response(
        new ReadableStream<Uint8Array>({
          start() {},
        }),
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    }) as typeof fetch;

    useIntelligenceAgUiWorkflow('project-1', 'run-1', { onEvent: () => {} });
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    expect(requests).toHaveLength(1);

    stateIndex = 0;
    effectIndex = 0;
    refIndex = 0;
    useIntelligenceAgUiWorkflow('project-1', 'run-1', { onEvent: () => {} });
    for (let index = 0; index < 8; index += 1) await Promise.resolve();

    expect(requests).toHaveLength(1);
  });
});
