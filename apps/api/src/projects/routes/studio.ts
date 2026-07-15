import { createDefaultStudioProjectRoutes } from '../../studio/default-routes';
import { projectsApp } from '../lib/app';

projectsApp.route('/', createDefaultStudioProjectRoutes());
