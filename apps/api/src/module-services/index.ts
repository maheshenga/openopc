import { config } from '../config';
import { DeveloperModulePaymentOrderService } from '../module-payments/orders';
import { createDrizzleDeveloperModulePaymentRepository } from '../module-payments/orders.drizzle';
import {
  createZPayClient,
  createZPayDeveloperModulePaymentProvider,
} from '../module-payments/zpay';
import { db } from '../shared/db';
import { createModuleServicesApp } from './app';
import { createConfiguredModuleServiceCapabilityBroker } from './capability-config';
import { ModuleServiceConsentManager } from './capability-grants';
import { createDrizzleModuleServiceCapabilityRepository } from './capability-grants.drizzle';
import type { ModuleDataRouteDependencies } from './data';
import { createDrizzleModuleDataStore } from './data.drizzle';
import { configureModulePaymentOrderService } from './payments';
import { configureModuleServiceCapabilityBroker } from './service-auth';
import { requireModuleServiceOperation } from './service-auth';
import { type ModuleSettingsRouteDependencies, ModuleSettingsService } from './settings';
import { createDrizzleModuleSettingsRepository } from './settings.drizzle';

export * from './app';
export * from './capability-config';
export * from './capability-grants';
export * from './capability-grants.drizzle';
export * from './service-auth';
export * from './payments';
export * from './images';
export * from './images-studio';
export * from './data';
export * from './data.drizzle';
export * from './settings';
export * from './settings.drizzle';

export const moduleServiceCapabilityRepository = createDrizzleModuleServiceCapabilityRepository(db);
export const moduleServiceConsentManager = new ModuleServiceConsentManager({
  repository: moduleServiceCapabilityRepository,
});
export const moduleServiceCapabilityBroker = createConfiguredModuleServiceCapabilityBroker(
  moduleServiceCapabilityRepository,
  config,
);

configureModuleServiceCapabilityBroker(moduleServiceCapabilityBroker);

export const modulePaymentRepository = createDrizzleDeveloperModulePaymentRepository(db);
export const zPayClient = createZPayClient({
  baseUrl: config.ZPAY_BASE_URL,
  merchantPid: config.ZPAY_MERCHANT_PID,
  merchantKey: config.ZPAY_MERCHANT_KEY,
  callbackBaseUrl: config.ZPAY_CALLBACK_BASE_URL,
});
export const modulePaymentOrderService = new DeveloperModulePaymentOrderService({
  repository: modulePaymentRepository,
  provider: createZPayDeveloperModulePaymentProvider(zPayClient),
});

configureModulePaymentOrderService(modulePaymentOrderService);

export const moduleDataStore = createDrizzleModuleDataStore(db);
export const moduleDataRouteDependencies: ModuleDataRouteDependencies = {
  requireCapability: (authorization, operation) =>
    requireModuleServiceOperation(authorization, { service: 'data', operation }) as never,
  store: moduleDataStore,
};
export const moduleSettingsService = new ModuleSettingsService({
  repository: createDrizzleModuleSettingsRepository(db),
});
export const moduleSettingsRouteDependencies: ModuleSettingsRouteDependencies = {
  requireCapability: (authorization) =>
    requireModuleServiceOperation(authorization, {
      service: 'settings',
      operation: 'settings.read',
    }) as never,
  service: moduleSettingsService,
};

export const moduleServicesApp = createModuleServicesApp(
  undefined,
  undefined,
  undefined,
  moduleDataRouteDependencies,
  moduleSettingsRouteDependencies,
);
