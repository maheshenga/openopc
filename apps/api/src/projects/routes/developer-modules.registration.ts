import { projectModuleInstallationService } from '../../developer';
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
