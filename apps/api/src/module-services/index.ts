import { config } from '../config';
import { db } from '../shared/db';
import { createModuleServicesApp } from './app';
import { createConfiguredModuleServiceCapabilityBroker } from './capability-config';
import { ModuleServiceConsentManager } from './capability-grants';
import { createDrizzleModuleServiceCapabilityRepository } from './capability-grants.drizzle';
import { configureModuleServiceCapabilityBroker } from './service-auth';

export * from './app';
export * from './capability-config';
export * from './capability-grants';
export * from './capability-grants.drizzle';
export * from './service-auth';
export * from './payments';

export const moduleServiceCapabilityRepository = createDrizzleModuleServiceCapabilityRepository(db);
export const moduleServiceConsentManager = new ModuleServiceConsentManager({
  repository: moduleServiceCapabilityRepository,
});
export const moduleServiceCapabilityBroker = createConfiguredModuleServiceCapabilityBroker(
  moduleServiceCapabilityRepository,
  config,
);

configureModuleServiceCapabilityBroker(moduleServiceCapabilityBroker);

export const moduleServicesApp = createModuleServicesApp();
