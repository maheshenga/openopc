import { tunnelConnections } from '@kortix/db';
import { desc, eq } from 'drizzle-orm';
import { config } from '../config';
import { getRequestContext } from '../lib/request-context';
import { supabaseAuth } from '../middleware/auth';
import { loadProjectForUser } from '../projects/lib/access';
import { db } from '../shared/db';
import { isTunnelConnectionLive } from '../tunnel/core/cluster-forwarder';
import { createAutomationControlClient } from './control-client';
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
