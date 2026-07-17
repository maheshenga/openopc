import { createDefaultIntelligenceProjectRoutes } from '../../studio/default-routes';
import { projectsApp } from '../lib/app';

projectsApp.route('/', createDefaultIntelligenceProjectRoutes());
