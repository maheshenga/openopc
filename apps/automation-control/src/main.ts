import { createDb } from '@kortix/db';
import { RedisClient } from 'bun';
import { sql } from 'drizzle-orm';
import { createPostgresApprovalService } from './approval-service';
import { loadAutomationControlConfig } from './config';
import { startAutomationDispatchPolling } from './dispatch/poller';
import { createAutomationDesktopDispatchRuntime } from './dispatch/runtime';
import {
  createPostgresKillSwitchService,
  createRedisKillSwitchPublisher,
} from './kill-switch-service';
import { createPostgresLeaseManager } from './lease-manager';
import { createPostgresAutomationRepository } from './repository';
import { createPostgresApprovalRouteStore } from './routes/approvals';
import { createPostgresAutomationEventReader } from './routes/events';
import { createAutomationRoutes } from './routes/index';
import { createPostgresAutomationPolicyStore } from './routes/policies';
import { createPostgresBrowserProfileStore } from './routes/profiles';
import { createAutomationControlApp } from './server';

const config = loadAutomationControlConfig();
const db = config.enabled ? createDb(config.databaseUrl) : null;
const redis = config.enabled ? new RedisClient(config.redisUrl) : null;
const repository = db ? createPostgresAutomationRepository(db) : null;
const leaseManager = db ? createPostgresLeaseManager(db, config.sharedSecret) : null;

const checkDatabase = db
  ? async () => {
      await db.execute(sql`select 1`);
      return true;
    }
  : async () => false;

const checkRedis = redis
  ? async () => {
      if (!redis.connected) await redis.connect();
      return (await redis.ping()) === 'PONG';
    }
  : async () => false;

const routes =
  db && redis && repository
    ? (() => {
        const killSwitchService = createPostgresKillSwitchService(db, {
          publishers: [
            createRedisKillSwitchPublisher({
              send: (command, args) => redis.send(command, args),
            }),
          ],
        });
        const approvalService = createPostgresApprovalService(db, {
          currentGeneration: ({ accountId, projectId }) =>
            killSwitchService.current({ kind: 'project', accountId, projectId }),
        });
        return createAutomationRoutes({
          auth: {
            sharedSecret: config.sharedSecret,
            allowedServiceIds: ['kortix-api'],
          },
          repository,
          eventReader: createPostgresAutomationEventReader(db),
          approvalStore: createPostgresApprovalRouteStore(db, approvalService),
          profileStore: createPostgresBrowserProfileStore(db),
          policyStore: createPostgresAutomationPolicyStore(db),
          killSwitchService,
        });
      })()
    : undefined;

const app = createAutomationControlApp({ config, checkDatabase, checkRedis, routes });
const server = Bun.serve({
  hostname: '0.0.0.0',
  port: config.port,
  fetch: app.fetch,
});

console.info(
  JSON.stringify({
    event: 'automation_control_started',
    service_id: config.serviceId,
    enabled: config.enabled,
    desktop_coordinator_enabled: config.desktopCoordinatorEnabled,
    port: server.port,
  }),
);

const desktopDispatchRuntime =
  repository && leaseManager
    ? createAutomationDesktopDispatchRuntime({
        config,
        repository,
        leaseManager,
      })
    : null;
const coordinatorPoller = desktopDispatchRuntime
  ? startAutomationDispatchPolling({
      coordinator: desktopDispatchRuntime,
      intervalMs: config.coordinatorPollMs,
      onError: (failure) => {
        console.error(JSON.stringify({ ...failure, service_id: config.serviceId }));
      },
    })
  : null;

let shutdownPromise: Promise<void> | null = null;

function shutdown(): Promise<void> {
  shutdownPromise ??= (async () => {
    await coordinatorPoller?.stop();
    redis?.close();
    server.stop(true);
  })();
  return shutdownPromise;
}

process.once('SIGINT', () => {
  void shutdown();
});
process.once('SIGTERM', () => {
  void shutdown();
});
