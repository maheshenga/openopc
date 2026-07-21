import { createDb } from '@kortix/db';
import { RedisClient } from 'bun';
import { sql } from 'drizzle-orm';
import { createPostgresApprovalService } from './approval-service';
import { loadAutomationControlConfig } from './config';
import {
  createPostgresKillSwitchService,
  createRedisKillSwitchPublisher,
} from './kill-switch-service';
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
  db && redis
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
          repository: createPostgresAutomationRepository(db),
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
    port: server.port,
  }),
);

function shutdown(): void {
  redis?.close();
  server.stop(true);
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
