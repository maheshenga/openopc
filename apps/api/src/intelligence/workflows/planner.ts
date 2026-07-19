import type {
  CapabilityDescriptor,
  WorkflowPlannerProposal,
  WorkflowProposedNode,
} from '@kortix/intelligence-contracts';
import {
  CapabilityDescriptorSchema,
  WORKFLOW_MAX_DEPENDENCIES,
  WORKFLOW_MAX_NODES,
  WorkflowPlannerProposalSchema,
} from '@kortix/intelligence-contracts';
import { validateWorkflowGraph } from '@kortix/intelligence-orchestration';
import { z } from 'zod';
import type { WorkflowAgentBinding } from './agents';

const MAX_PLANNER_OUTPUT_CHARS = 256 * 1024;
const MAX_PLANNER_CONTEXT_BYTES = 128 * 1024;
const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const PlannerContextSchema = z
  .object({
    protocol_version: z.literal('intelligence.workflow.v1'),
    run_id: z.string().uuid(),
    expected_graph_version: z.number().int().nonnegative(),
    capabilities: z.array(CapabilityDescriptorSchema).max(256),
    agents: z
      .array(z.object({ name: z.string().trim().min(1).max(255), card_hash: HashSchema }).strict())
      .max(WORKFLOW_MAX_NODES),
    asset_ids: z.array(z.string().uuid()).max(64),
    limits: z
      .object({
        max_nodes: z.number().int().positive().max(WORKFLOW_MAX_NODES),
        max_dependencies: z.number().int().nonnegative().max(WORKFLOW_MAX_DEPENDENCIES),
        max_approved_credits: z.number().finite().nonnegative().max(1_000_000),
        deadline_at: z.string().datetime({ offset: true }).nullable(),
      })
      .strict(),
    evaluation_summaries: z
      .array(
        z
          .object({
            evaluation_version: z.string().trim().min(1).max(128),
            sample_count: z.number().int().nonnegative().max(1_000_000),
            score: z.number().finite().min(0).max(1),
          })
          .strict(),
      )
      .max(32),
  })
  .strict();

export type WorkflowPlannerContext = {
  protocol_version: 'intelligence.workflow.v1';
  run_id: string;
  expected_graph_version: number;
  capabilities: CapabilityDescriptor[];
  agents: Array<{ name: string; card_hash: string }>;
  asset_ids: string[];
  limits: {
    max_nodes: number;
    max_dependencies: number;
    max_approved_credits: number;
    deadline_at: string | null;
  };
  evaluation_summaries: Array<{
    evaluation_version: string;
    sample_count: number;
    score: number;
  }>;
};

export type WorkflowPlannerCommand = {
  accountId: string;
  projectId: string;
  binding: WorkflowAgentBinding;
  context: WorkflowPlannerContext;
  signal?: AbortSignal;
  timeoutMs?: number;
};

export interface PlannerPort {
  plan(command: WorkflowPlannerCommand): Promise<WorkflowPlannerProposal>;
}

export class WorkflowPlannerError extends Error {
  constructor(
    readonly code:
      | 'WORKFLOW_PLANNER_CONTEXT_INVALID'
      | 'WORKFLOW_PLANNER_OUTPUT_INVALID'
      | 'WORKFLOW_PLANNER_AUTHORIZATION_DENIED',
  ) {
    super(code);
    this.name = 'WorkflowPlannerError';
  }
}

export function createWorkflowPlanner(input: {
  invokeAgent: {
    invoke(command: {
      accountId: string;
      projectId: string;
      expectedRole: 'planner';
      binding: WorkflowAgentBinding;
      context: unknown;
      signal?: AbortSignal;
      timeoutMs?: number;
    }): Promise<unknown>;
  };
  authorizeNode(command: {
    accountId: string;
    projectId: string;
    node: WorkflowProposedNode;
  }): Promise<boolean>;
}): PlannerPort {
  return {
    async plan(command) {
      const parsedContext = PlannerContextSchema.safeParse(command.context);
      if (!parsedContext.success || !isBoundedContext(parsedContext.data)) {
        throw new WorkflowPlannerError('WORKFLOW_PLANNER_CONTEXT_INVALID');
      }
      const output = await input.invokeAgent.invoke({
        accountId: command.accountId,
        projectId: command.projectId,
        expectedRole: 'planner',
        binding: command.binding,
        context: parsedContext.data,
        signal: command.signal,
        timeoutMs: command.timeoutMs,
      });
      const proposal = parseProposal(output);
      validateProposal(command, parsedContext.data, proposal);
      for (const node of proposal.nodes) {
        let authorized = false;
        try {
          authorized = await input.authorizeNode({
            accountId: command.accountId,
            projectId: command.projectId,
            node,
          });
        } catch {
          authorized = false;
        }
        if (!authorized) {
          throw new WorkflowPlannerError('WORKFLOW_PLANNER_AUTHORIZATION_DENIED');
        }
      }
      return proposal;
    },
  };
}

function isBoundedContext(context: z.infer<typeof PlannerContextSchema>): boolean {
  try {
    return (
      new TextEncoder().encode(JSON.stringify(context)).byteLength <= MAX_PLANNER_CONTEXT_BYTES
    );
  } catch {
    return false;
  }
}

function parseProposal(output: unknown): WorkflowPlannerProposal {
  let value = output;
  if (typeof output === 'string') {
    if (output.length > MAX_PLANNER_OUTPUT_CHARS) {
      throw new WorkflowPlannerError('WORKFLOW_PLANNER_OUTPUT_INVALID');
    }
    try {
      value = JSON.parse(output);
    } catch {
      throw new WorkflowPlannerError('WORKFLOW_PLANNER_OUTPUT_INVALID');
    }
  }
  const parsed = WorkflowPlannerProposalSchema.safeParse(value);
  if (!parsed.success) {
    throw new WorkflowPlannerError('WORKFLOW_PLANNER_OUTPUT_INVALID');
  }
  return parsed.data;
}

function validateProposal(
  command: WorkflowPlannerCommand,
  context: z.infer<typeof PlannerContextSchema>,
  proposal: WorkflowPlannerProposal,
): void {
  if (
    command.binding.role !== 'planner' ||
    proposal.run_id !== context.run_id ||
    proposal.expected_graph_version !== context.expected_graph_version ||
    proposal.planner_agent_name !== command.binding.agentName ||
    proposal.planner_card_hash !== command.binding.cardHash ||
    proposal.nodes.length > context.limits.max_nodes ||
    proposal.dependencies.length > context.limits.max_dependencies
  ) {
    throw new WorkflowPlannerError('WORKFLOW_PLANNER_OUTPUT_INVALID');
  }
  const agents = new Map(context.agents.map((agent) => [agent.name, agent.card_hash]));
  const capabilities = new Set(
    context.capabilities.map((capability) => `${capability.id}\0${capability.version}`),
  );
  for (const node of proposal.nodes) {
    const hasAgentName = node.agent_name !== null;
    const hasAgentCard = node.agent_card_hash !== null;
    if (
      hasAgentName !== hasAgentCard ||
      (node.kind !== 'approval' && !hasAgentName) ||
      (hasAgentName && agents.get(node.agent_name as string) !== node.agent_card_hash) ||
      (node.kind === 'capability' &&
        !capabilities.has(`${node.capability_id}\0${node.capability_version}`))
    ) {
      throw new WorkflowPlannerError('WORKFLOW_PLANNER_OUTPUT_INVALID');
    }
  }
  try {
    validateWorkflowGraph(
      proposal.nodes.map((node) => ({ nodeKey: node.node_key })),
      proposal.dependencies.map((dependency) => ({
        nodeKey: dependency.node_key,
        dependsOnNodeKey: dependency.depends_on_node_key,
      })),
    );
  } catch {
    throw new WorkflowPlannerError('WORKFLOW_PLANNER_OUTPUT_INVALID');
  }
}
