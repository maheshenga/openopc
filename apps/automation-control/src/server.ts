import { AUTOMATION_PROTOCOL_VERSION } from '@kortix/intelligence-contracts';
import { Hono } from 'hono';
import type { AutomationControlConfig } from './config';
import type { InternalAutomationEnv } from './internal-auth';

type DependencyStatus = 'available' | 'unavailable' | 'skipped';

export type AutomationControlServerDependencies = Readonly<{
  config: AutomationControlConfig;
  checkDatabase: () => Promise<boolean>;
  checkRedis: () => Promise<boolean>;
  checkBrowserRuntime?: () => Promise<boolean>;
  routes?: Hono<InternalAutomationEnv>;
  workerRoutes?: Hono;
}>;

async function probe(check: () => Promise<boolean>): Promise<DependencyStatus> {
  try {
    return (await check()) ? 'available' : 'unavailable';
  } catch {
    return 'unavailable';
  }
}

function disabledSnapshot(config: AutomationControlConfig) {
  return {
    protocol_version: AUTOMATION_PROTOCOL_VERSION,
    service_id: config.serviceId,
    enabled: false as const,
    status: 'disabled' as const,
    dependencies: {
      database: 'skipped' as const,
      redis: 'skipped' as const,
    },
  };
}

async function dependencySnapshot(dependencies: AutomationControlServerDependencies) {
  const [database, redis] = await Promise.all([
    probe(dependencies.checkDatabase),
    probe(dependencies.checkRedis),
  ]);
  return { database, redis };
}

async function readinessSnapshot(dependencies: AutomationControlServerDependencies) {
  const status: Record<string, DependencyStatus> = await dependencySnapshot(dependencies);
  if (dependencies.config.browserApprovalResumeEnabled) {
    status.browser_dispatch = await probe(dependencies.checkBrowserRuntime ?? (async () => false));
  }
  return status;
}

export function createAutomationControlApp(
  dependencies: AutomationControlServerDependencies,
): Hono<InternalAutomationEnv> {
  const app = new Hono<InternalAutomationEnv>();

  app.get('/health', async (context) => {
    if (!dependencies.config.enabled) {
      return context.json(disabledSnapshot(dependencies.config));
    }

    const status = await dependencySnapshot(dependencies);
    const healthy = status.database === 'available' && status.redis === 'available';
    return context.json({
      protocol_version: AUTOMATION_PROTOCOL_VERSION,
      service_id: dependencies.config.serviceId,
      enabled: true,
      status: healthy ? ('healthy' as const) : ('degraded' as const),
      dependencies: status,
    });
  });

  app.get('/ready', async (context) => {
    if (!dependencies.config.enabled) {
      return context.json(disabledSnapshot(dependencies.config), 503);
    }

    const status = await readinessSnapshot(dependencies);
    const ready = Object.values(status).every((dependency) => dependency === 'available');
    return context.json(
      {
        protocol_version: AUTOMATION_PROTOCOL_VERSION,
        service_id: dependencies.config.serviceId,
        enabled: true,
        status: ready ? ('ready' as const) : ('not_ready' as const),
        dependencies: status,
      },
      ready ? 200 : 503,
    );
  });

  if (dependencies.config.enabled && dependencies.routes) {
    app.route('/', dependencies.routes);
  }
  if (
    dependencies.config.enabled &&
    dependencies.config.browserHeartbeatEnabled &&
    dependencies.workerRoutes
  ) {
    app.route('/', dependencies.workerRoutes);
  }

  return app;
}
