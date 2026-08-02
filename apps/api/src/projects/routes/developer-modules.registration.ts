import {
  moduleCustomDomainBindingService,
  projectModuleInstallationService,
  projectModuleLaunchService,
  runtimeReleaseProfile,
} from '../../developer';
import { createModuleCustomDomainProjectRoutes } from '../../module-domains/app';
import {
  createModuleServiceProjectRoutes,
  moduleServiceCapabilityBroker,
  moduleServiceConsentManager,
} from '../../module-services';
import { assertProjectCapability, loadProjectForUser } from '../lib/access';
import { projectsApp } from '../lib/app';
import { createProjectDeveloperModuleRoutes } from './developer-modules';

projectsApp.route(
  '/',
  createProjectDeveloperModuleRoutes({
    loadProjectForUser,
    assertProjectCapability,
    installationService: projectModuleInstallationService,
    launchService: projectModuleLaunchService,
    runtime: runtimeReleaseProfile,
  }),
);

projectsApp.route(
  '/',
  createModuleServiceProjectRoutes({
    loadProjectForUser,
    assertProjectCapability,
    consentManager: moduleServiceConsentManager,
    capabilityBroker: moduleServiceCapabilityBroker,
  }),
);

projectsApp.route(
  '/',
  createModuleCustomDomainProjectRoutes({
    loadProjectForUser,
    assertProjectCapability,
    bindingService: moduleCustomDomainBindingService,
  }),
);
