import { projectModuleInstallationService } from '../../developer';
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
