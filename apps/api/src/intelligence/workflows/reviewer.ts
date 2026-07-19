import {
  type WorkflowReviewerVerdict,
  WorkflowReviewerVerdictSchema,
} from '@kortix/intelligence-contracts';
import { z } from 'zod';
import type { WorkflowAgentBinding } from './agents';

const MAX_REVIEW_CONTEXT_BYTES = 64 * 1024;
const MAX_REVIEW_OUTPUT_CHARS = 64 * 1024;
const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const ReasonCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_.-]{0,127}$/);
const ReviewerContextSchema = z
  .object({
    protocol_version: z.literal('intelligence.workflow.v1'),
    run_id: z.string().uuid(),
    node: z
      .object({
        node_id: z.string().uuid(),
        role: z.literal('executor'),
        agent_name: z.string().trim().min(1).max(255),
        agent_card_hash: HashSchema,
      })
      .strict(),
    result: z
      .object({
        status: z.enum(['succeeded', 'failed', 'cancelled']),
        asset_ids: z.array(z.string().uuid()).max(64),
        reason_codes: z.array(ReasonCodeSchema).max(16),
      })
      .strict(),
    evaluation_summary: z
      .object({
        evaluation_version: z.string().trim().min(1).max(128),
        score: z.number().finite().min(0).max(1),
        sample_count: z.number().int().nonnegative().max(1_000_000),
      })
      .strict()
      .nullable(),
    separation_of_duty: z.boolean(),
  })
  .strict();

export type WorkflowReviewerContext = {
  protocol_version: 'intelligence.workflow.v1';
  run_id: string;
  node: {
    node_id: string;
    role: 'executor';
    agent_name: string;
    agent_card_hash: string;
  };
  result: {
    status: 'succeeded' | 'failed' | 'cancelled';
    asset_ids: string[];
    reason_codes: string[];
  };
  evaluation_summary: {
    evaluation_version: string;
    score: number;
    sample_count: number;
  } | null;
  separation_of_duty: boolean;
};

export type WorkflowReviewerCommand = {
  accountId: string;
  projectId: string;
  binding: WorkflowAgentBinding;
  context: WorkflowReviewerContext;
  signal?: AbortSignal;
  timeoutMs?: number;
};

export interface ReviewerPort {
  review(command: WorkflowReviewerCommand): Promise<WorkflowReviewerVerdict>;
}

export class WorkflowReviewerError extends Error {
  constructor(
    readonly code:
      | 'WORKFLOW_REVIEWER_CONTEXT_INVALID'
      | 'WORKFLOW_REVIEWER_OUTPUT_INVALID'
      | 'WORKFLOW_REVIEWER_AUTHORIZATION_DENIED'
      | 'WORKFLOW_REVIEWER_SELF_REVIEW_DENIED',
  ) {
    super(code);
    this.name = 'WorkflowReviewerError';
  }
}

export function createWorkflowReviewer(input: {
  invokeAgent: {
    invoke(command: {
      accountId: string;
      projectId: string;
      expectedRole: 'reviewer';
      binding: WorkflowAgentBinding;
      context: unknown;
      signal?: AbortSignal;
      timeoutMs?: number;
    }): Promise<unknown>;
  };
  authorizeVerdict(command: {
    accountId: string;
    projectId: string;
    verdict: WorkflowReviewerVerdict;
  }): Promise<boolean>;
}): ReviewerPort {
  return {
    async review(command) {
      const context = ReviewerContextSchema.safeParse(command.context);
      if (!context.success || !boundedJson(context.data, MAX_REVIEW_CONTEXT_BYTES)) {
        throw new WorkflowReviewerError('WORKFLOW_REVIEWER_CONTEXT_INVALID');
      }
      if (
        context.data.separation_of_duty &&
        context.data.node.agent_name === command.binding.agentName
      ) {
        throw new WorkflowReviewerError('WORKFLOW_REVIEWER_SELF_REVIEW_DENIED');
      }
      const output = await input.invokeAgent.invoke({
        accountId: command.accountId,
        projectId: command.projectId,
        expectedRole: 'reviewer',
        binding: command.binding,
        context: context.data,
        signal: command.signal,
        timeoutMs: command.timeoutMs,
      });
      const verdict = parseVerdict(output);
      if (
        command.binding.role !== 'reviewer' ||
        verdict.run_id !== context.data.run_id ||
        verdict.node_id !== context.data.node.node_id ||
        verdict.reviewer_agent_name !== command.binding.agentName ||
        verdict.reviewer_card_hash !== command.binding.cardHash ||
        (verdict.feedback_ref === null) !== (verdict.feedback_hash === null)
      ) {
        throw new WorkflowReviewerError('WORKFLOW_REVIEWER_OUTPUT_INVALID');
      }
      let authorized = false;
      try {
        authorized = await input.authorizeVerdict({
          accountId: command.accountId,
          projectId: command.projectId,
          verdict,
        });
      } catch {
        authorized = false;
      }
      if (!authorized) {
        throw new WorkflowReviewerError('WORKFLOW_REVIEWER_AUTHORIZATION_DENIED');
      }
      return verdict;
    },
  };
}

function parseVerdict(output: unknown): WorkflowReviewerVerdict {
  let value = output;
  if (typeof output === 'string') {
    if (output.length > MAX_REVIEW_OUTPUT_CHARS) {
      throw new WorkflowReviewerError('WORKFLOW_REVIEWER_OUTPUT_INVALID');
    }
    try {
      value = JSON.parse(output);
    } catch {
      throw new WorkflowReviewerError('WORKFLOW_REVIEWER_OUTPUT_INVALID');
    }
  }
  const parsed = WorkflowReviewerVerdictSchema.safeParse(value);
  if (!parsed.success) {
    throw new WorkflowReviewerError('WORKFLOW_REVIEWER_OUTPUT_INVALID');
  }
  return parsed.data;
}

function boundedJson(value: unknown, maxBytes: number): boolean {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength <= maxBytes;
  } catch {
    return false;
  }
}
