import {
  type Database,
  intelligenceWorkflowNodes,
  intelligenceWorkflowPayloads,
  intelligenceWorkflowRuns,
} from '@kortix/db';
import type { SealedWorkflowPayload, WorkflowNodeRef } from '@kortix/intelligence-orchestration';
import { and, eq } from 'drizzle-orm';

export type WorkflowPayloadIndexErrorCode =
  | 'WORKFLOW_PAYLOAD_INDEX_CONFLICT'
  | 'WORKFLOW_PAYLOAD_INDEX_INVALID';

export class WorkflowPayloadIndexError extends Error {
  constructor(readonly code: WorkflowPayloadIndexErrorCode) {
    super(code);
    this.name = 'WorkflowPayloadIndexError';
  }
}

export type WorkflowNodeInputRecord = WorkflowNodeRef &
  SealedWorkflowPayload & {
    purpose: 'node_input';
    createdAt: string;
  };

export interface WorkflowPayloadRepository {
  putNodeInput(
    input: WorkflowNodeRef & { payload: SealedWorkflowPayload; createdAt: string },
  ): Promise<{ record: WorkflowNodeInputRecord; created: boolean }>;
  getNodeInput(input: WorkflowNodeRef): Promise<WorkflowNodeInputRecord | null>;
}

export function createMemoryWorkflowPayloadRepository(): WorkflowPayloadRepository {
  const records = new Map<string, WorkflowNodeInputRecord>();
  return {
    async putNodeInput(input) {
      const record = parseRecord(input);
      const key = recordKey(record);
      const existing = records.get(key);
      if (existing) return replay(existing, record);
      records.set(key, structuredClone(record));
      return { record: structuredClone(record), created: true };
    },
    async getNodeInput(input) {
      const record = records.get(recordKey(input));
      return record ? structuredClone(record) : null;
    },
  };
}

export function createPostgresWorkflowPayloadRepository(
  database: Database,
): WorkflowPayloadRepository {
  const read = async (input: WorkflowNodeRef): Promise<WorkflowNodeInputRecord | null> => {
    const [row] = await database
      .select({
        accountId: intelligenceWorkflowRuns.accountId,
        projectId: intelligenceWorkflowRuns.projectId,
        runId: intelligenceWorkflowPayloads.runId,
        nodeId: intelligenceWorkflowPayloads.nodeId,
        purpose: intelligenceWorkflowPayloads.purpose,
        payloadRef: intelligenceWorkflowPayloads.payloadRef,
        contentHash: intelligenceWorkflowPayloads.contentHash,
        byteLength: intelligenceWorkflowPayloads.byteLength,
        contentType: intelligenceWorkflowPayloads.contentType,
        createdAt: intelligenceWorkflowPayloads.createdAt,
      })
      .from(intelligenceWorkflowPayloads)
      .innerJoin(
        intelligenceWorkflowRuns,
        eq(intelligenceWorkflowRuns.runId, intelligenceWorkflowPayloads.runId),
      )
      .where(
        and(
          eq(intelligenceWorkflowRuns.accountId, input.accountId),
          eq(intelligenceWorkflowRuns.projectId, input.projectId),
          eq(intelligenceWorkflowPayloads.runId, input.runId),
          eq(intelligenceWorkflowPayloads.nodeId, input.nodeId),
          eq(intelligenceWorkflowPayloads.purpose, 'node_input'),
          eq(intelligenceWorkflowPayloads.retentionStatus, 'active'),
        ),
      )
      .limit(1);
    if (!row || row.nodeId === null || row.purpose !== 'node_input') return null;
    return parseRecord({
      accountId: row.accountId,
      projectId: row.projectId,
      runId: row.runId,
      nodeId: row.nodeId,
      payload: {
        payloadRef: row.payloadRef,
        contentHash: row.contentHash,
        byteLength: row.byteLength,
        contentType: row.contentType as 'application/json',
      },
      createdAt: row.createdAt,
    });
  };

  return {
    async putNodeInput(input) {
      const record = parseRecord(input);
      const existing = await read(record);
      if (existing) return replay(existing, record);

      const [node] = await database
        .select({ nodeId: intelligenceWorkflowNodes.nodeId })
        .from(intelligenceWorkflowNodes)
        .innerJoin(
          intelligenceWorkflowRuns,
          eq(intelligenceWorkflowRuns.runId, intelligenceWorkflowNodes.runId),
        )
        .where(
          and(
            eq(intelligenceWorkflowRuns.accountId, record.accountId),
            eq(intelligenceWorkflowRuns.projectId, record.projectId),
            eq(intelligenceWorkflowNodes.runId, record.runId),
            eq(intelligenceWorkflowNodes.nodeId, record.nodeId),
          ),
        )
        .limit(1);
      if (!node) throw new WorkflowPayloadIndexError('WORKFLOW_PAYLOAD_INDEX_INVALID');

      const [inserted] = await database
        .insert(intelligenceWorkflowPayloads)
        .values({
          runId: record.runId,
          nodeId: record.nodeId,
          purpose: record.purpose,
          payloadRef: record.payloadRef,
          contentHash: record.contentHash,
          byteLength: record.byteLength,
          contentType: record.contentType,
          retentionStatus: 'active',
          createdAt: record.createdAt,
        })
        .onConflictDoNothing()
        .returning({ payloadRef: intelligenceWorkflowPayloads.payloadRef });
      if (inserted) return { record, created: true };
      const raced = await read(record);
      if (!raced) throw new WorkflowPayloadIndexError('WORKFLOW_PAYLOAD_INDEX_CONFLICT');
      return replay(raced, record);
    },
    getNodeInput: read,
  };
}

function parseRecord(
  input: WorkflowNodeRef & { payload: SealedWorkflowPayload; createdAt: string },
): WorkflowNodeInputRecord {
  const record: WorkflowNodeInputRecord = {
    accountId: input.accountId,
    projectId: input.projectId,
    runId: input.runId,
    nodeId: input.nodeId,
    purpose: 'node_input',
    ...input.payload,
    createdAt: input.createdAt,
  };
  if (
    !UUID.test(record.accountId) ||
    !UUID.test(record.projectId) ||
    !UUID.test(record.runId) ||
    !UUID.test(record.nodeId) ||
    !/^sealed:[A-Za-z0-9][A-Za-z0-9._:-]{7,255}$/.test(record.payloadRef) ||
    !/^sha256:[a-f0-9]{64}$/.test(record.contentHash) ||
    !Number.isSafeInteger(record.byteLength) ||
    record.byteLength < 1 ||
    record.byteLength > 1024 * 1024 ||
    record.contentType !== 'application/json' ||
    !Number.isFinite(Date.parse(record.createdAt))
  ) {
    throw new WorkflowPayloadIndexError('WORKFLOW_PAYLOAD_INDEX_INVALID');
  }
  return record;
}

function replay(
  existing: WorkflowNodeInputRecord,
  incoming: WorkflowNodeInputRecord,
): { record: WorkflowNodeInputRecord; created: false } {
  if (
    existing.contentHash !== incoming.contentHash ||
    existing.byteLength !== incoming.byteLength ||
    existing.contentType !== incoming.contentType
  ) {
    throw new WorkflowPayloadIndexError('WORKFLOW_PAYLOAD_INDEX_CONFLICT');
  }
  return { record: structuredClone(existing), created: false };
}

function recordKey(input: WorkflowNodeRef): string {
  return `${input.accountId}\0${input.projectId}\0${input.runId}\0${input.nodeId}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
