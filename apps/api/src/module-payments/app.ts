import { makeOpenApiApp } from '../openapi';
import type { AppEnv } from '../types';
import { type ZPayCallbackRouteDependencies, createZPayCallbackRoutes } from './zpay-callback';

export function createModulePaymentsApp(dependencies: ZPayCallbackRouteDependencies) {
  const app = makeOpenApiApp<AppEnv>();
  app.route('/', createZPayCallbackRoutes(dependencies));
  return app;
}
