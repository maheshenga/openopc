import { createRoute, z } from '@hono/zod-openapi';
import { auth, errors, json, makeOpenApiApp } from '../../openapi';
import type { AppEnv } from '../../types';
import type { AutomationApiDependencies } from '../index';
import { loadAutomationProject } from './shared';

export type AutomationDevice = Readonly<{
  device_id: string;
  name: string;
  status: 'online' | 'offline';
  capabilities: readonly string[];
  last_heartbeat_at: string | null;
}>;

export interface AutomationDeviceReader {
  list(accountId: string): Promise<readonly AutomationDevice[]>;
}

export function createAutomationDevicesRouter(dependencies: AutomationApiDependencies) {
  const router = makeOpenApiApp<AppEnv>();
  router.openapi(
    createRoute({
      method: 'get',
      path: '/',
      tags: ['automation'],
      summary: 'List automation devices',
      ...auth,
      request: { query: z.object({ project_id: z.string().uuid() }) },
      responses: { 200: json(z.any(), 'Devices'), ...errors(400, 401, 403, 404, 503) },
    }),
    async (context) => {
      const { project_id: projectId } = context.req.valid('query');
      const loaded = await loadAutomationProject(context, dependencies, projectId, 'read');
      const devices = (await dependencies.deviceReader?.list(loaded.row.accountId)) ?? [];
      return context.json({ devices }) as never;
    },
  );
  return router;
}
