import { supabaseAuth } from '../middleware/auth';
import { createDeveloperApp } from './app';

export { createDeveloperApp, type DeveloperAppDependencies } from './app';

export const developerApp = createDeveloperApp({ authenticate: supabaseAuth });
