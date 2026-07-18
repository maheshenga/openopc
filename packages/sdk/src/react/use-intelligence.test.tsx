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
}));

const {
  intelligenceAgentCardKey,
  intelligenceCapabilityDiscoveryKey,
  intelligenceCapabilitiesKey,
  intelligenceTaskEventsKey,
  useCreateIntelligenceTask,
  useIntelligence,
  useIntelligenceAgentCard,
  useIntelligenceCapabilityDiscovery,
  useIntelligenceCapabilities,
  useIntelligenceTaskEvents,
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

  test('aggregate hook exposes the three project intelligence surfaces', () => {
    const result = useIntelligence('project-1') as unknown as {
      capabilities: MockQueryConfig;
      discovery: MockQueryConfig;
      agentCard: MockQueryConfig;
      createTask: MockQueryConfig;
    };
    expect(result.capabilities.queryKey).toEqual([...intelligenceCapabilitiesKey('project-1')]);
    expect(result.discovery.queryKey).toEqual([...intelligenceCapabilityDiscoveryKey('project-1')]);
    expect(result.agentCard.queryKey).toEqual([...intelligenceAgentCardKey('project-1')]);
    expect(result.createTask.mutationFn).toBeFunction();
  });
});
