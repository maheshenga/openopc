import { backendApi } from '../../http/api-client';
import { unwrap } from './shared';

export interface DeveloperModuleValidationIssue {
  severity: 'error' | 'warning';
  path: string;
  message: string;
}

export interface DeveloperModuleValidationResult {
  valid: boolean;
  issues: DeveloperModuleValidationIssue[];
}

/** Validate one registry:module item without publishing or persisting it. */
export async function validateDeveloperModule(
  item: Record<string, unknown>,
): Promise<DeveloperModuleValidationResult> {
  return unwrap(
    await backendApi.post<DeveloperModuleValidationResult>('/developer/modules/validate', item),
    'Failed to validate developer module',
  );
}
