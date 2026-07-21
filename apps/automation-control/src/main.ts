import { createDb } from '@kortix/db';
import { RedisClient } from 'bun';
import { sql } from 'drizzle-orm';
import { loadAutomationControlConfig } from './config';
import { createAutomationControlApp } from './server';

const config = loadAutomationControlConfig();
let redis: RedisClient | null = null;

const checkDatabase = config.enabled
  ? (() => {
      const db = createDb(config.databaseUrl);
      return async () => {
        await db.execute(sql`select 1`);
        return true;
      };
    })()
  : async () => false;

const checkRedis = config.enabled
  ? (() => {
      redis = new RedisClient(config.redisUrl);
      return async () => {
        if (!redis?.connected) await redis?.connect();
        return (await redis?.ping()) === 'PONG';
      };
    })()
  : async () => false;

const app = createAutomationControlApp({ config, checkDatabase, checkRedis });
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
