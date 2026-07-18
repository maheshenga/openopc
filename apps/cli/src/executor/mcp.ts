/**
 * `kortix executor mcp` — the Executor exposed as a stdio MCP server.
 *
 * This is an optional compatibility face for every configured integration
 * (Pipedream / MCP / OpenAPI / GraphQL / HTTP). The default agent path is the
 * `kortix executor` CLI; OpenCode only sees this MCP server when the runtime
 * explicitly registers it.
 *
 * Modeled on RhysSullivan/executor: instead of exploding every connector action
 * into tools/list (which floods context once a catalog has hundreds of actions),
 * we expose a small, stable set of META-TOOLS and let the agent progressively
 * discover what it needs.
 *
 * Thin client: it never holds a third-party credential. Every call goes to the
 * Kortix Executor Gateway, which checks sharing, resolves the secret SERVER-SIDE,
 * runs the call, and audits it. The sandbox only carries KORTIX_EXECUTOR_TOKEN +
 * KORTIX_API_URL (injected at sandbox spawn).
 *
 * STDOUT IS THE JSON-RPC CHANNEL — nothing else may be written there. index.ts
 * skips the host/update notices for `executor`, so this stays clean.
 */
import {
  IntelligenceAgentCardResponseSchema,
  IntelligenceCapabilityDiscoveryResponseSchema,
} from '@kortix/api-contract';
import type { ExecutorClient } from '@kortix/executor-sdk';
import {
  addConnector,
  callPausingForApproval,
  executorClient,
  mintConnectLink,
  mintSecretLink,
  removeConnector,
} from './gateway.ts';
import {
  type IntelligenceAgentCardResponse,
  type IntelligenceCapabilityDiscoveryResponse,
  type IntelligenceCapabilityDiscoveryStatus,
  IntelligenceClientError,
  type IntelligenceCreateTaskRequest,
  createIntelligenceTask,
  discoverIntelligenceCapabilities,
  discoverIntelligenceCapabilitiesWithStatus,
  getIntelligenceAgentCard,
  intelligenceProjectContext,
  isSafeIntelligenceCode,
  parseIntelligenceCreateTaskRequest,
} from './intelligence.ts';

export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

// The MCP server identity is kept as `kortix-executor` (unchanged from the old
// standalone shim) so the agent's tool names and registration key don't move.
const SERVER_INFO = { name: 'kortix-executor', version: '0.3.0' };

export interface IntelligenceMcpDependencies {
  discoverCapabilities(projectOverride?: string): Promise<IntelligenceCapabilityDiscoveryResponse>;
  discoverCapabilitiesWithStatus?: (
    projectOverride?: string,
  ) => Promise<IntelligenceCapabilityDiscoveryStatus>;
  getAgentCard(projectOverride?: string): Promise<IntelligenceAgentCardResponse>;
  createTask(request: IntelligenceCreateTaskRequest, projectOverride?: string): Promise<string>;
  /** Optional test/host gate for callers that own the discovery session. */
  canCreateTask?: () => boolean | Promise<boolean>;
  /** Optional project resolver used to invalidate cached discovery after a switch. */
  getProjectId?: () => string | null | undefined | Promise<string | null | undefined>;
}

const defaultIntelligenceDependencies: IntelligenceMcpDependencies = {
  discoverCapabilities: discoverIntelligenceCapabilities,
  discoverCapabilitiesWithStatus: discoverIntelligenceCapabilitiesWithStatus,
  getAgentCard: getIntelligenceAgentCard,
  createTask: createIntelligenceTask,
  getProjectId: () => intelligenceProjectContext().projectId,
};

interface IntelligenceMcpSessionState {
  enhancedDiscovery: boolean;
  projectId: string | null;
}

const intelligenceSessionStates = new WeakMap<
  IntelligenceMcpDependencies,
  IntelligenceMcpSessionState
>();

function intelligenceSessionState(
  dependencies: IntelligenceMcpDependencies,
): IntelligenceMcpSessionState {
  const existing = intelligenceSessionStates.get(dependencies);
  if (existing) return existing;
  const created: IntelligenceMcpSessionState = { enhancedDiscovery: false, projectId: null };
  intelligenceSessionStates.set(dependencies, created);
  return created;
}

function clearIntelligenceSession(state: IntelligenceMcpSessionState) {
  state.enhancedDiscovery = false;
  state.projectId = null;
}

async function currentIntelligenceProjectId(
  dependencies: IntelligenceMcpDependencies,
): Promise<string | null> {
  try {
    const value = dependencies.getProjectId
      ? await dependencies.getProjectId()
      : intelligenceProjectContext().projectId;
    return typeof value === 'string' && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

async function discoverForIntelligenceSession(
  dependencies: IntelligenceMcpDependencies,
  state: IntelligenceMcpSessionState,
  projectOverride: string | null,
): Promise<IntelligenceCapabilityDiscoveryResponse> {
  const status = dependencies.discoverCapabilitiesWithStatus
    ? await dependencies.discoverCapabilitiesWithStatus(projectOverride ?? undefined)
    : {
        response: await dependencies.discoverCapabilities(projectOverride ?? undefined),
        legacy: false,
      };

  if (!status || typeof status !== 'object' || typeof status.legacy !== 'boolean') {
    throw new IntelligenceClientError('INTELLIGENCE_PROTOCOL_ERROR', 0);
  }
  const parsedResponse = IntelligenceCapabilityDiscoveryResponseSchema.safeParse(status.response);
  if (!parsedResponse.success) {
    throw new IntelligenceClientError('INTELLIGENCE_PROTOCOL_ERROR', 0);
  }

  state.enhancedDiscovery = !status.legacy;
  state.projectId = projectOverride;
  if (status.legacy) state.projectId = null;
  return parsedResponse.data;
}

type IntelligenceTaskGate = { allowed: false } | { allowed: true; projectOverride?: string };

async function canCreateFromIntelligenceSession(
  dependencies: IntelligenceMcpDependencies,
  state: IntelligenceMcpSessionState,
): Promise<IntelligenceTaskGate> {
  if (dependencies.canCreateTask) {
    try {
      if (!(await dependencies.canCreateTask())) return { allowed: false };
    } catch {
      return { allowed: false };
    }
  }

  // Injected legacy dependencies predate the status-aware discovery API. They
  // remain source-compatible, but must opt into writes with an explicit gate;
  // an omitted gate is fail-closed rather than an implicit authorization.
  if (!dependencies.discoverCapabilitiesWithStatus) {
    return dependencies.canCreateTask
      ? { allowed: true, projectOverride: state.projectId ?? undefined }
      : { allowed: false };
  }
  if (!state.enhancedDiscovery || state.projectId === null) return { allowed: false };

  const currentProjectId = await currentIntelligenceProjectId(dependencies);
  if (currentProjectId === null || currentProjectId !== state.projectId) {
    clearIntelligenceSession(state);
    return { allowed: false };
  }
  return { allowed: true, projectOverride: state.projectId };
}

const STUDIO_CREATE_TASK_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    capability_id: { type: 'string', enum: ['studio.image.generate'] },
    agent_card_hash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    provider_config_id: { type: 'string', format: 'uuid' },
    model: {
      type: 'string',
      minLength: 1,
      maxLength: 255,
      pattern:
        '^(?![A-Za-z][A-Za-z0-9+.-]*:)(?!//)(?!.*[?&#])(?!.*(api[_-]?key|secret|password|credential|authorization|bearer|access[_-]?token)).+$',
    },
    input: {
      type: 'object',
      properties: {
        capability: { type: 'string', enum: ['image.generate'] },
        image: {
          type: 'object',
          properties: {
            prompt: { type: 'string', minLength: 1, maxLength: 8000 },
            negative_prompt: { type: 'string', maxLength: 4000 },
            reference_asset_ids: {
              type: 'array',
              items: { type: 'string', format: 'uuid' },
              maxItems: 8,
            },
            aspect_ratio: { type: 'string', enum: ['1:1', '4:3', '3:4', '16:9', '9:16'] },
            quality: { type: 'string', enum: ['standard', 'high'] },
            output_count: { type: 'integer', minimum: 1, maximum: 8 },
            seed: { type: 'integer', minimum: 0 },
            advanced: { type: 'object', additionalProperties: true },
          },
          required: ['prompt', 'aspect_ratio', 'quality', 'output_count'],
          additionalProperties: false,
        },
      },
      required: ['capability', 'image'],
      additionalProperties: false,
    },
    idempotency_key: { type: 'string', minLength: 16, maxLength: 255 },
    parent_task_id: {
      anyOf: [{ type: 'string', format: 'uuid' }, { type: 'null' }],
    },
    deadline_at: {
      anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }],
    },
  },
  required: [
    'capability_id',
    'agent_card_hash',
    'provider_config_id',
    'model',
    'input',
    'idempotency_key',
  ],
  additionalProperties: false,
} as const;

/**
 * The fixed meta-tool surface. Stable regardless of how many connectors or
 * actions a session has — that's the whole point versus exploding the catalog.
 */
const META_TOOLS = [
  {
    name: 'connectors',
    description:
      'List the integration connectors this session can use (Pipedream / MCP / OpenAPI / GraphQL / HTTP), each with its provider, status, and number of tools. Start here to see what is available.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    readOnly: true,
  },
  {
    name: 'discover',
    description:
      'Search every usable tool by intent and return the best matches (connector-namespaced path, risk, description). Use a natural-language query like "send a slack message" or "create a stripe charge".',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Natural-language intent to search for. Empty returns the first available tools.',
        },
        limit: { type: 'number', description: 'Maximum matches to return (default 20).' },
      },
      additionalProperties: false,
    },
    readOnly: true,
  },
  {
    name: 'describe',
    description:
      'Show one tool\'s full input JSON schema, risk, and description. Pass the connector-namespaced path from discover, e.g. "stripe.charges.create". Always describe an unfamiliar tool before calling it.',
    inputSchema: {
      type: 'object',
      properties: {
        tool: {
          type: 'string',
          description: 'Connector-namespaced tool path, e.g. "stripe.charges.create".',
        },
      },
      required: ['tool'],
      additionalProperties: false,
    },
    readOnly: true,
  },
  {
    name: 'call',
    description:
      'Run a tool. The gateway resolves the credential server-side, enforces sharing + policy, executes the call, and audits it. Returns { ok, data, risk } on success, or a denial / pending-approval result. GraphQL tools take selected fields via an "__select" arg, e.g. {"id":"1","__select":"id name email"}.',
    inputSchema: {
      type: 'object',
      properties: {
        connector: { type: 'string', description: 'Connector slug, e.g. "stripe".' },
        action: {
          type: 'string',
          description: 'Action path within the connector, e.g. "charges.create".',
        },
        args: {
          type: 'object',
          description: "Arguments matching the tool's input schema (see describe). Defaults to {}.",
        },
      },
      required: ['connector', 'action'],
      additionalProperties: false,
    },
    readOnly: false,
  },
  {
    name: 'connect',
    description:
      'Get a 1-click Pipedream Quick Connect link for a connector that is declared but not yet authenticated, and SURFACE the returned url to the human in your reply. Use this the moment you add/need a Pipedream connector — never tell the human to open the dashboard. In the web UI the link opens a connect popup; in Slack it is a tappable link. No credential ever touches the sandbox. The connector must already exist in kortix.yaml (add it + land the change request first).',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Connector slug to connect, e.g. "smartlead".' },
        expires_in_minutes: {
          type: 'number',
          description: 'Link lifetime in minutes (default 30, max 1440).',
        },
      },
      required: ['slug'],
      additionalProperties: false,
    },
    readOnly: false,
  },
  {
    name: 'request_secret',
    description:
      'Get a link the human opens to enter one or more project SECRET values (e.g. an API key), and SURFACE the returned url in your reply. Use this whenever you need a credential you do not have — never ask the human to paste a raw key into chat or to hunt through the dashboard. You never see the value; once they submit it, the secret becomes available to your session (check KORTIX_PROJECT_SECRET_NAMES). In the web UI the link opens a fill-in modal; in Slack it is a tappable link. scope "runtime" (default) injects the value into your sandbox env; "connector" keeps it server-side only.',
    inputSchema: {
      type: 'object',
      properties: {
        names: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Env var name(s) to request, e.g. ["APOLLO_API_KEY","SMARTLEAD_API_KEY"]. UPPER_SNAKE_CASE.',
        },
        scope: {
          type: 'string',
          enum: ['runtime', 'connector'],
          description: 'runtime (default) or connector.',
        },
        labels: {
          type: 'object',
          description: 'Optional per-name human label, { NAME: "label" }.',
        },
        descriptions: {
          type: 'object',
          description: 'Optional per-name hint shown on the form, { NAME: "where to find it" }.',
        },
        expires_in_minutes: {
          type: 'number',
          description: 'Link lifetime in minutes (default 30, max 1440).',
        },
      },
      required: ['names'],
      additionalProperties: false,
    },
    readOnly: false,
  },
  {
    name: 'add_connector',
    description:
      'Add (or update) an integration connector on this project RIGHT NOW — committed to kortix.yaml on main and synced server-side, exactly like the dashboard\'s "Add app". No change request needed; it is live this session. Use this to set up a new tool, then call `connect` (Pipedream) or `request_secret` for its credential. For Pipedream pass provider="pipedream" + app (e.g. "smartlead").',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Connector slug, e.g. "smartlead".' },
        provider: {
          type: 'string',
          enum: ['pipedream', 'mcp', 'openapi', 'graphql', 'http'],
          description: 'Connector provider.',
        },
        app: {
          type: 'string',
          description: 'Pipedream app slug (provider=pipedream), e.g. "smartlead".',
        },
        name: { type: 'string', description: 'Optional display name.' },
        url: { type: 'string', description: 'MCP server URL (provider=mcp).' },
        transport: {
          type: 'string',
          enum: ['http', 'sse'],
          description: 'MCP transport (provider=mcp).',
        },
        endpoint: { type: 'string', description: 'GraphQL endpoint (provider=graphql).' },
        base_url: { type: 'string', description: 'HTTP base URL (provider=http).' },
        spec: { type: 'string', description: 'OpenAPI/GraphQL/HTTP spec ref.' },
        credential: {
          type: 'string',
          enum: ['shared'],
          description: 'Credential storage mode (shared is the only mode).',
        },
      },
      required: ['slug', 'provider'],
      additionalProperties: false,
    },
    readOnly: false,
  },
  {
    name: 'remove_connector',
    description:
      'Remove a connector from this project (committed to kortix.yaml on main + catalog). No change request needed.',
    inputSchema: {
      type: 'object',
      properties: { slug: { type: 'string', description: 'Connector slug to remove.' } },
      required: ['slug'],
      additionalProperties: false,
    },
    readOnly: false,
  },
  {
    name: 'studio_capabilities',
    description:
      'List governed Studio capabilities and the public local Agent Card needed to create a task.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    readOnly: true,
  },
  {
    name: 'studio_create_task',
    description:
      'Create one governed asynchronous Studio task. The Kortix API enforces IAM, trust, approval, billing, and provider credential isolation.',
    inputSchema: STUDIO_CREATE_TASK_INPUT_SCHEMA,
    readOnly: false,
  },
] as const;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringField(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  return typeof value === 'string' ? value : '';
}

function content(data: unknown) {
  return [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }];
}

async function runMetaTool(
  executor: ExecutorClient,
  name: string,
  args: Record<string, unknown>,
  intelligence: IntelligenceMcpDependencies,
) {
  const intelligenceSession = intelligenceSessionState(intelligence);

  switch (name) {
    case 'connectors': {
      const connectors = await executor.connectors();
      return {
        content: content({
          connectors: connectors.map((c) => ({
            slug: c.slug,
            name: c.name,
            provider: c.provider,
            status: c.status,
            tools: c.actions.length,
          })),
        }),
        isError: false,
      };
    }

    case 'discover': {
      const query = typeof args.query === 'string' ? args.query : '';
      const limit = typeof args.limit === 'number' ? args.limit : undefined;
      const matches = await executor.discover(query, limit !== undefined ? { limit } : {});
      return {
        content: content({
          matches: matches.map((m) => ({ tool: m.tool, risk: m.risk, description: m.description })),
        }),
        isError: false,
      };
    }

    case 'describe': {
      const ref = typeof args.tool === 'string' ? args.tool : '';
      if (!ref.includes('.')) {
        return {
          content: content({ ok: false, error: 'tool must be a "<connector>.<action>" path' }),
          isError: true,
        };
      }
      const tool = await executor.describe(ref);
      if (!tool) {
        return {
          content: content({
            ok: false,
            error: `unknown tool "${ref}" — run discover to list tools`,
          }),
          isError: true,
        };
      }
      return {
        content: content({
          tool: tool.tool,
          risk: tool.risk,
          description: tool.description,
          inputSchema: tool.inputSchema,
        }),
        isError: false,
      };
    }

    case 'call': {
      const connector = typeof args.connector === 'string' ? args.connector : '';
      const action = typeof args.action === 'string' ? args.action : '';
      if (!connector || !action) {
        return {
          content: content({ ok: false, error: 'connector and action are required' }),
          isError: true,
        };
      }
      const callArgs = asRecord(args.args);
      // Pauses the run for human approval (indefinite poll, like a question) —
      // shared with `kortix executor call`, see callPausingForApproval.
      const result = await callPausingForApproval(executor, connector, action, callArgs);
      return { content: content(result), isError: !result.ok };
    }

    case 'connect': {
      const slug = typeof args.slug === 'string' ? args.slug : '';
      if (!slug)
        return { content: content({ ok: false, error: 'slug is required' }), isError: true };
      const expires =
        typeof args.expires_in_minutes === 'number' ? args.expires_in_minutes : undefined;
      try {
        const link = await mintConnectLink({ slug, expiresInMinutes: expires });
        return {
          content: content({
            ok: true,
            slug: link.slug,
            app: link.app,
            url: link.url,
            expires_at: link.expires_at,
            instructions:
              'Surface this url to the human now. Web: opens a connect popup. Slack: tappable link.',
          }),
          isError: false,
        };
      } catch (err) {
        return {
          content: content({ ok: false, error: err instanceof Error ? err.message : String(err) }),
          isError: true,
        };
      }
    }

    case 'request_secret': {
      const names = Array.isArray(args.names)
        ? args.names.filter((n): n is string => typeof n === 'string')
        : [];
      if (names.length === 0)
        return { content: content({ ok: false, error: 'names is required' }), isError: true };
      const scope =
        args.scope === 'connector' ? 'connector' : args.scope === 'runtime' ? 'runtime' : undefined;
      const expires =
        typeof args.expires_in_minutes === 'number' ? args.expires_in_minutes : undefined;
      try {
        const link = await mintSecretLink({
          names,
          scope,
          expiresInMinutes: expires,
          labels: asRecord(args.labels) as Record<string, string>,
          descriptions: asRecord(args.descriptions) as Record<string, string>,
        });
        return {
          content: content({
            ok: true,
            names: link.names,
            scope: link.scope,
            url: link.url,
            expires_at: link.expires_at,
            instructions:
              'Surface this url to the human now. Web: opens a fill-in modal. Slack: tappable link. You never see the value; once submitted it appears in KORTIX_PROJECT_SECRET_NAMES.',
          }),
          isError: false,
        };
      } catch (err) {
        return {
          content: content({ ok: false, error: err instanceof Error ? err.message : String(err) }),
          isError: true,
        };
      }
    }

    case 'add_connector': {
      const slug = typeof args.slug === 'string' ? args.slug : '';
      const provider = typeof args.provider === 'string' ? args.provider : '';
      if (!slug || !provider)
        return {
          content: content({ ok: false, error: 'slug and provider are required' }),
          isError: true,
        };
      const draft: Record<string, unknown> = { slug, provider };
      for (const k of [
        'app',
        'name',
        'url',
        'transport',
        'endpoint',
        'spec',
        'credential',
      ] as const) {
        if (typeof args[k] === 'string') draft[k] = args[k];
      }
      if (typeof args.base_url === 'string') draft.baseUrl = args.base_url;
      try {
        const res = await addConnector(draft);
        return {
          content: content({
            ok: true,
            slug,
            provider,
            applied: true,
            sync: res.sync,
            instructions: `Live now (committed to kortix.yaml on main + synced) — no change request needed. Next: call connect("${slug}") for a Pipedream app, or request_secret for an API key.`,
          }),
          isError: false,
        };
      } catch (err) {
        return {
          content: content({ ok: false, error: err instanceof Error ? err.message : String(err) }),
          isError: true,
        };
      }
    }

    case 'remove_connector': {
      const slug = typeof args.slug === 'string' ? args.slug : '';
      if (!slug)
        return { content: content({ ok: false, error: 'slug is required' }), isError: true };
      try {
        await removeConnector(slug);
        return { content: content({ ok: true, slug, removed: true }), isError: false };
      } catch (err) {
        return {
          content: content({ ok: false, error: err instanceof Error ? err.message : String(err) }),
          isError: true,
        };
      }
    }

    case 'studio_capabilities': {
      if (Object.keys(args).length > 0) return intelligenceValidationError();
      try {
        const projectSnapshot = await currentIntelligenceProjectId(intelligence);
        const capabilityResponse = await discoverForIntelligenceSession(
          intelligence,
          intelligenceSession,
          projectSnapshot,
        );
        let agentCard: IntelligenceAgentCardResponse | null = null;
        if (capabilityResponse.items.length > 0) {
          const parsedCard = IntelligenceAgentCardResponseSchema.safeParse(
            await intelligence.getAgentCard(projectSnapshot ?? undefined),
          );
          if (!parsedCard.success) {
            throw new IntelligenceClientError('INTELLIGENCE_PROTOCOL_ERROR', 0);
          }
          agentCard = parsedCard.data;
        }
        if (projectSnapshot !== null) {
          const currentProject = await currentIntelligenceProjectId(intelligence);
          if (currentProject === null || currentProject !== projectSnapshot) {
            clearIntelligenceSession(intelligenceSession);
            throw new IntelligenceClientError('INTELLIGENCE_DISCOVERY_UNAVAILABLE', 409);
          }
        }
        return {
          content: content({ ...capabilityResponse, agent_card: agentCard }),
          isError: false,
        };
      } catch (error) {
        clearIntelligenceSession(intelligenceSession);
        return intelligenceErrorResult(error);
      }
    }

    case 'studio_create_task': {
      if (Object.hasOwn(args, 'protocol_version')) {
        return intelligenceValidationError();
      }
      const parsed = parseIntelligenceCreateTaskRequest({
        protocol_version: 'intelligence.v1',
        ...args,
      });
      if (!parsed) return intelligenceValidationError();
      const taskGate = await canCreateFromIntelligenceSession(intelligence, intelligenceSession);
      if (!taskGate.allowed) {
        return intelligenceDiscoveryUnavailable();
      }
      try {
        const taskId = await intelligence.createTask(parsed, taskGate.projectOverride);
        return { content: content({ ok: true, task_id: taskId }), isError: false };
      } catch (error) {
        return intelligenceErrorResult(error);
      }
    }

    default:
      return { content: content({ ok: false, error: `unknown tool ${name}` }), isError: true };
  }
}

export async function handleExecutorMcpRequest(
  req: JsonRpcRequest,
  executor: ExecutorClient,
  intelligence: IntelligenceMcpDependencies = defaultIntelligenceDependencies,
) {
  switch (req.method) {
    case 'initialize':
      clearIntelligenceSession(intelligenceSessionState(intelligence));
      return {
        protocolVersion: asRecord(req.params).protocolVersion ?? '2025-06-18',
        serverInfo: SERVER_INFO,
        capabilities: { tools: {} },
      };

    case 'tools/list':
      return {
        tools: META_TOOLS.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: { readOnlyHint: tool.readOnly },
        })),
      };

    case 'tools/call': {
      const params = asRecord(req.params);
      return runMetaTool(
        executor,
        stringField(params, 'name'),
        asRecord(params.arguments),
        intelligence,
      );
    }

    case 'notifications/initialized':
      return undefined;

    default:
      throw new Error(`unsupported MCP method: ${req.method}`);
  }
}

function intelligenceValidationError() {
  return {
    content: content({
      ok: false,
      error: 'Invalid Intelligence request',
      code: 'INTELLIGENCE_VALIDATION_ERROR',
    }),
    isError: true,
  };
}

function intelligenceDiscoveryUnavailable() {
  return {
    content: content({
      ok: false,
      error: 'Intelligence discovery is unavailable for this MCP session',
      code: 'INTELLIGENCE_DISCOVERY_UNAVAILABLE',
    }),
    isError: true,
  };
}

function intelligenceErrorResult(error: unknown) {
  const code =
    error instanceof IntelligenceClientError && isSafeIntelligenceCode(error.code)
      ? error.code
      : 'INTELLIGENCE_REQUEST_FAILED';
  return {
    content: content({ ok: false, error: 'Intelligence request failed', code }),
    isError: true,
  };
}

function writeResponse(
  id: JsonRpcRequest['id'],
  result: unknown,
  error?: { code: number; message: string },
) {
  if (id === undefined || id === null) return;
  const payload = error ? { jsonrpc: '2.0', id, error } : { jsonrpc: '2.0', id, result };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

/** Run the stdio JSON-RPC loop until stdin closes. */
export async function runExecutorMcpServer(): Promise<number> {
  const executor = executorClient();
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk);
    for (;;) {
      const nl = buffer.indexOf('\n');
      if (nl < 0) break;
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let req: JsonRpcRequest;
      try {
        req = JSON.parse(line);
      } catch {
        writeResponse(null, null, { code: -32700, message: 'parse error' });
        continue;
      }
      try {
        const result = await handleExecutorMcpRequest(req, executor);
        writeResponse(req.id, result);
      } catch (err) {
        writeResponse(req.id, null, {
          code: -32000,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  return 0;
}
