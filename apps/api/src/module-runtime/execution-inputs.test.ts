import { expect, test } from 'bun:test';

import { createMemoryExecutionInputStore } from './execution-inputs';

const INPUT = {
  executionId: '10000000-0000-4000-8000-000000000001',
  accountId: '20000000-0000-4000-8000-000000000001',
  projectId: '30000000-0000-4000-8000-000000000001',
  payload: new TextEncoder().encode('{"a":1}'),
  digest: `sha256:${'1'.repeat(64)}` as const,
  createdAt: '2026-07-27T08:00:00.000Z',
};

test('memory execution input store is tenant-qualified and returns immutable copies', async () => {
  const store = createMemoryExecutionInputStore({ inputs: [INPUT] });

  const loaded = await store.get(INPUT.accountId, INPUT.projectId, INPUT.executionId);
  expect(loaded).toEqual(INPUT);
  if (!loaded) throw new Error('expected execution input');
  loaded.payload[0] = 0;

  expect(
    new TextDecoder().decode(
      (await store.get(INPUT.accountId, INPUT.projectId, INPUT.executionId))?.payload,
    ),
  ).toBe('{"a":1}');
  expect(await store.get('wrong-account', INPUT.projectId, INPUT.executionId)).toBeNull();
  expect(await store.get(INPUT.accountId, 'wrong-project', INPUT.executionId)).toBeNull();
});
