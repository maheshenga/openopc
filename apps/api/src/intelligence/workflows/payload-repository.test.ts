import { describe, expect, test } from 'bun:test';
import { createMemoryWorkflowPayloadRepository } from './payload-repository';

const SCOPE = {
  accountId: '81000000-0000-4000-a000-000000000001',
  projectId: '82000000-0000-4000-a000-000000000001',
  runId: '83000000-0000-4000-a000-000000000001',
  nodeId: '84000000-0000-4000-a000-000000000001',
};
const PAYLOAD = {
  payloadRef: 'sealed:85000000-0000-4000-a000-000000000001',
  contentHash: `sha256:${'a'.repeat(64)}`,
  byteLength: 128,
  contentType: 'application/json' as const,
};

describe('workflow payload repository', () => {
  test('records and reads one project-scoped node input idempotently', async () => {
    const repository = createMemoryWorkflowPayloadRepository();
    const input = { ...SCOPE, payload: PAYLOAD, createdAt: '2026-07-19T10:00:00.000Z' };

    await expect(repository.putNodeInput(input)).resolves.toMatchObject({
      created: true,
      record: { ...SCOPE, ...PAYLOAD, purpose: 'node_input' },
    });
    await expect(repository.putNodeInput(input)).resolves.toMatchObject({ created: false });
    await expect(repository.getNodeInput(SCOPE)).resolves.toMatchObject({
      ...SCOPE,
      ...PAYLOAD,
      purpose: 'node_input',
    });
    await expect(
      repository.getNodeInput({ ...SCOPE, projectId: '82000000-0000-4000-a000-000000000099' }),
    ).resolves.toBeNull();
  });

  test('rejects a changed payload for the same workflow node', async () => {
    const repository = createMemoryWorkflowPayloadRepository();
    await repository.putNodeInput({
      ...SCOPE,
      payload: PAYLOAD,
      createdAt: '2026-07-19T10:00:00.000Z',
    });

    await expect(
      repository.putNodeInput({
        ...SCOPE,
        payload: { ...PAYLOAD, contentHash: `sha256:${'b'.repeat(64)}` },
        createdAt: '2026-07-19T10:00:01.000Z',
      }),
    ).rejects.toMatchObject({ code: 'WORKFLOW_PAYLOAD_INDEX_CONFLICT' });
  });
});
