import { beforeEach, describe, expect, mock, test } from 'bun:test';

let invalidated: unknown[][] = [];
mock.module('@tanstack/react-query', () => ({
  useQuery: (config: Record<string, unknown>) => config,
  useMutation: (config: Record<string, unknown>) => config,
  useQueryClient: () => ({
    invalidateQueries: (options: { queryKey: unknown[] }) => {
      invalidated.push(options.queryKey);
    },
  }),
  keepPreviousData: Symbol('keepPreviousData'),
}));

const {
  intelligenceAgentCardKey,
  intelligenceCapabilityDiscoveryKey,
  intelligenceCapabilitiesKey,
  intelligenceAssetsKey,
  intelligenceAssetsPrefix,
  intelligenceJobsKey,
  intelligenceJobsPrefix,
  intelligenceTaskEventsKey,
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
  useIntelligenceCapabilityDiscovery,
  useIntelligenceCapabilities,
  useIntelligenceAssets,
  useEstimateIntelligenceImage,
  useFinalizeIntelligenceUpload,
  useIntelligenceAssetDownload,
  useIntelligenceJobs,
  useIntelligenceTaskEvents,
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
    expect(asMockQueryConfig(useIntelligenceAgentCard('project-1')).queryKey).toEqual([
      ...intelligenceAgentCardKey('project-1'),
    ]);
    expect(
      asMockQueryConfig(useIntelligenceTaskEvents('project-1', 'task-1', 'cursor-1')).queryKey,
    ).toEqual(intelligenceTaskEventsKey('project-1', 'task-1', 'cursor-1'));
    expect(asMockQueryConfig(useIntelligenceCapabilities(null)).enabled).toBe(false);
    expect(asMockQueryConfig(useIntelligenceTaskEvents('project-1', '')).enabled).toBe(false);
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
});
