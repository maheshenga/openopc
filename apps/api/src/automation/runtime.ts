import { projects, tunnelConnections } from '@kortix/db';
import { AUTOMATION_DESKTOP_EXECUTOR_AUDIENCE } from '@kortix/intelligence-contracts';
import { RedisClient } from 'bun';
import { and, desc, eq } from 'drizzle-orm';
import { config } from '../config';
import { getRequestContext } from '../lib/request-context';
import { supabaseAuth } from '../middleware/auth';
import { loadProjectForUser } from '../projects/lib/access';
import { db } from '../shared/db';
import { isTunnelConnectionLive } from '../tunnel/core/cluster-forwarder';
import { executeTunnelRpc } from '../tunnel/core/rpc-core';
import { createAutomationControlClient } from './control-client';
import {
  createAutomationDesktopExecutorApp,
  createMemoryAutomationDesktopNonceStore,
  createRedisAutomationDesktopNonceStore,
} from './desktop-executor';
import { createAutomationApiApp } from './index';

const controlClient = createAutomationControlClient({
  baseUrl: config.AUTOMATION_CONTROL_URL,
  sharedSecret: config.AUTOMATION_CONTROL_SHARED_SECRET,
  serviceId: 'kortix-api',
  timeoutMs: config.AUTOMATION_CONTROL_TIMEOUT_MS,
  streamTimeoutMs: config.AUTOMATION_CONTROL_STREAM_TIMEOUT_MS,
  mtlsCa: config.AUTOMATION_CONTROL_MTLS_CA || undefined,
});

export const automationApp = createAutomationApiApp({
  enabled: config.AUTOMATION_CONTROL_ENABLED,
  authenticate: supabaseAuth,
  loadProject: (context, projectId, action) => loadProjectForUser(context, projectId, action),
  controlClient,
  traceparent: (context) =>
    getRequestContext()?.traceparent ?? context.req.header('traceparent') ?? null,
  deviceReader: {
    async list(accountId) {
      const devices = await db
        .select({
          tunnelId: tunnelConnections.tunnelId,
          name: tunnelConnections.name,
          status: tunnelConnections.status,
          capabilities: tunnelConnections.capabilities,
          relayOwnerId: tunnelConnections.relayOwnerId,
          relayOwnerHeartbeatAt: tunnelConnections.relayOwnerHeartbeatAt,
          lastHeartbeatAt: tunnelConnections.lastHeartbeatAt,
        })
        .from(tunnelConnections)
        .where(eq(tunnelConnections.accountId, accountId))
        .orderBy(desc(tunnelConnections.updatedAt));
      return devices.map((device) => ({
        device_id: device.tunnelId,
        name: device.name,
        status: isTunnelConnectionLive(device) ? ('online' as const) : ('offline' as const),
        capabilities: device.capabilities ?? [],
        last_heartbeat_at: device.lastHeartbeatAt?.toISOString() ?? null,
      }));
    },
  },
});

const automationRedis = config.AUTOMATION_DESKTOP_EXECUTOR_ENABLED
  ? new RedisClient(config.AUTOMATION_REDIS_URL)
  : null;
const desktopExecutorNonceStore = automationRedis
  ? createRedisAutomationDesktopNonceStore({
      send: (command, args) => automationRedis.send(command, args),
    })
  : createMemoryAutomationDesktopNonceStore();

export const automationDesktopExecutorApp = createAutomationDesktopExecutorApp({
  controlEnabled: config.AUTOMATION_CONTROL_ENABLED,
  desktopExecutorEnabled: config.AUTOMATION_DESKTOP_EXECUTOR_ENABLED,
  sharedSecret: config.AUTOMATION_CONTROL_SHARED_SECRET,
  allowedServiceIds: [config.AUTOMATION_CONTROL_SERVICE_ID],
  audience: AUTOMATION_DESKTOP_EXECUTOR_AUDIENCE,
  nonceStore: desktopExecutorNonceStore,
  async verifyProjectScope({ accountId, projectId }) {
    const [project] = await db
      .select({ projectId: projects.projectId })
      .from(projects)
      .where(
        and(
          eq(projects.projectId, projectId),
          eq(projects.accountId, accountId),
          eq(projects.status, 'active'),
        ),
      )
      .limit(1);
    return project !== undefined;
  },
  async verifyTunnelOwnership({ accountId, tunnelId }) {
    const [tunnel] = await db
      .select({ tunnelId: tunnelConnections.tunnelId })
      .from(tunnelConnections)
      .where(
        and(eq(tunnelConnections.tunnelId, tunnelId), eq(tunnelConnections.accountId, accountId)),
      )
      .limit(1);
    return tunnel !== undefined;
  },
  executeTunnelRpc,
});
